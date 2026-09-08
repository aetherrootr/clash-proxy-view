#!/usr/bin/ruby
require 'yaml'

module ProxyViewGuard
  RUN_DIR = '/var/run/proxy-view-guard'
  DEFAULTS = {
    'enabled'=>false, 'mode'=>'observe', 'idle_seconds'=>120, 'check_interval'=>60,
    'failure_rounds'=>3, 'retire_interval'=>60
  }.freeze
  PROBE_URLS = ['https://cp.cloudflare.com/generate_204','https://www.gstatic.com/generate_204'].freeze

  def self.json(value)
    case value
    when Hash then '{' + value.map { |k,v| json(k.to_s) + ':' + json(v) }.join(',') + '}'
    when Array then '[' + value.map { |v| json(v) }.join(',') + ']'
    when String
      '"' + value.gsub(/["\\\x00-\x1f]/) { |c| c == '"' || c == '\\' ? '\\' + c : '\\u%04x' % c.ord } + '"'
    when Numeric then value.respond_to?(:finite?) && !value.finite? ? 'null' : value.to_s
    when true then 'true'
    when false then 'false'
    when nil then 'null'
    else json(value.to_s)
    end
  end

  def self.atomic_write(path, content)
    File.write(path + '.new', content)
    File.rename(path + '.new', path)
  end

  class ApiError < StandardError; end

  class Client
    def initialize(config_path, endpoint = 'http://127.0.0.1:9090')
      @config_path, @endpoint = config_path, endpoint
    end
    def cache_credentials!
      @secret = YAML.load_file(@config_path).fetch('secret').to_s
    end
    def current_secret
      stat = File.stat(@config_path)
      signature = [stat.ino, stat.size, stat.mtime, stat.ctime]
      if @config_signature != signature
        @config_secret = YAML.load_file(@config_path).fetch('secret').to_s
        @config_signature = signature
      end
      @config_secret
    end
    def encode(value)
      value.to_s.bytes.map { |b| (b.between?(48,57) || b.between?(65,90) || b.between?(97,122) || [45,46,95,126].include?(b)) ? b.chr : '%%%02X' % b }.join
    end
    def request(path, method = 'GET', body = nil)
      secret = @secret || current_secret
      raise ApiError, 'Invalid secret' if secret.empty? || secret.match?(/[\r\n]/)
      escaped = secret.gsub(/([\\"])/) { |c| '\\' + c }
      args = ['curl','-s','--fail','--connect-timeout','2','--max-time','7','--config','-','-X',method]
      args += ['-H','Content-Type: application/json','--data-binary',ProxyViewGuard.json(body)] if body
      args << @endpoint + path
      output = IO.popen(args, 'r+') do |io|
        io.write("header = \"Authorization: Bearer #{escaped}\"\n")
        io.close_write
        io.read
      end
      raise ApiError, 'Controller request failed' unless $?.success?
      output.empty? ? {} : YAML.safe_load(output)
    end
    def connections; request('/connections').fetch('connections'); end
    def proxies; request('/proxies').fetch('proxies'); end
    def providers
      return @provider_snapshot if @provider_snapshot
      result = request('/providers/proxies').fetch('providers')
      @provider_snapshot = result if @sharing_providers
      result
    end
    def share_providers
      @sharing_providers = true
      yield
    ensure
      @sharing_providers = false
      @provider_snapshot = nil
    end
    def group(name); request('/proxies/' + encode(name)); end
    def close(id); request('/connections/' + encode(id), 'DELETE'); end
    def delay(name, url, timeout)
      result = request('/proxies/' + encode(name) + '/delay?timeout=' + timeout.to_i.to_s + '&url=' + encode(url))['delay']
      result.is_a?(Numeric) && result > 0 ? result : nil
    rescue ApiError
      nil
    end
    def line_delays(provider, name, timeout)
      PROBE_URLS.map do |url|
        path = '/providers/proxies/' + encode(provider) + '/' + encode(name) + '/healthcheck'
        result = request(path + '?timeout=' + timeout.to_i.to_s + '&url=' + encode(url))['delay']
        result.is_a?(Numeric) && result > 0 ? result : nil
      rescue ApiError
        nil
      end
    end
    def exit_delays(name, timeout); PROBE_URLS.map { |url| delay(name, url, timeout) }; end
  end

  ExitSpec = Struct.new(:id, :selector, :tunnel_group, :group, :endpoint, :eligible, :owners, keyword_init: true)

  class Discovery
    def initialize(api, mihomo_config = nil); @api, @mihomo_config = api, mihomo_config; end
    def endpoint_for(selector_now)
      return nil unless @mihomo_config && File.file?(@mihomo_config)
      cfg = YAML.load_file(@mihomo_config) || {}
      direct = (cfg['proxies'] || []).find { |proxy| proxy['name'] == selector_now }
      return direct['server'].to_s if direct && !direct['server'].to_s.empty?
      (cfg['proxy-providers'] || {}).each_value do |provider|
        path = provider['path'].to_s
        next if path.empty?
        path = File.expand_path(path, File.dirname(@mihomo_config)) unless path.start_with?('/')
        next unless File.file?(path)
        proxy = ((YAML.load_file(path) || {})['proxies'] || []).find { |item| item['name'] == selector_now }
        return proxy['server'].to_s if proxy && !proxy['server'].to_s.empty?
      rescue StandardError
        next
      end
      nil
    rescue StandardError
      nil
    end
    def call(manual: false)
      proxy_map = @api.proxies
      owners = {}
      (manual ? {} : @api.providers).each do |provider_name, provider|
        Array(provider['proxies']).each { |proxy| (owners[proxy['name'].to_s] ||= []) << provider_name }
      end
      specs = []
      proxy_map.each do |name, selector|
        match = /\Aexit-node\(([A-Za-z0-9_-]{1,32})\)\z/.match(name.to_s)
        next unless match
        id = match[1]
        tunnel_name = "➡️ 代理隧道(#{id})"
        tunnel = proxy_map[tunnel_name]
        next unless tunnel.is_a?(Hash)
        groups = Array(tunnel['all']).map(&:to_s).select do |candidate|
          candidate.match?(/\A⚡ .+出口｜多线加速\z/) && proxy_map[candidate].is_a?(Hash)
        end
        next unless groups.length == 1
        group = groups.first
        eligible = Array(proxy_map[group]['all']).map(&:to_s).reject { |node| metadata_name?(node) || owners.fetch(node, []).length != 1 }
        specs << ExitSpec.new(id:id, selector:name, tunnel_group:tunnel_name, group:group,
          endpoint:endpoint_for(selector['now'].to_s), eligible:eligible, owners:owners)
      end
      specs.sort_by(&:id)
    end
    def metadata_name?(name)
      name.empty? || name.start_with?('exit-node') ||
        name.match?(/\A\s*\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB)\s*[|\/]/i) ||
        name.match?(/Traffic\s*Reset|Expire\s*Date|剩余流量|流量重置|到期时间|套餐信息/i)
    end
  end

  class Tracker
    attr_reader :entries
    def initialize(group, host); @group, @host, @entries = group, host.to_s.downcase, {}; end
    def outer?(connection)
      metadata = connection['metadata'] || {}
      metadata['type'].to_s.downcase == 'inner' && metadata['host'].to_s.downcase == @host &&
        metadata['network'].to_s.downcase == 'tcp' && Array(connection['chains']).include?(@group)
    end
    def line_for(connection)
      chains = Array(connection['chains'])
      index = chains.index(@group)
      index && index > 0 ? chains[index - 1].to_s : ''
    end
    def sample(connections, now)
      next_entries = {}
      connections.select { |connection| outer?(connection) }.each do |connection|
        next unless connection['id'].is_a?(String) && !connection['id'].empty? && connection['start'].is_a?(String)
        next unless %w[upload download].all? { |key| connection[key].is_a?(Numeric) && connection[key] >= 0 }
        old = @entries[connection['id']]
        uninterrupted = old && now >= old[:seen] && now - old[:seen] <= 20 && old[:start] == connection['start']
        same = uninterrupted && old[:upload] == connection['upload'] && old[:download] == connection['download']
        growing = uninterrupted && (connection['upload'] > old[:upload] || connection['download'] > old[:download])
        interval = old ? now - old[:seen] : 0
        valid_rate = uninterrupted && interval > 0 && connection['upload'] >= old[:upload] && connection['download'] >= old[:download]
        next_entries[connection['id']] = {
          id:connection['id'], start:connection['start'], upload:connection['upload'], download:connection['download'],
          seen:now, last_change:same ? old[:last_change] : now, growing:growing,
          sample_seconds:valid_rate ? interval : nil,
          upload_delta:valid_rate ? connection['upload'] - old[:upload] : nil,
          download_delta:valid_rate ? connection['download'] - old[:download] : nil,
          upload_rate:valid_rate ? (connection['upload'] - old[:upload]) / interval.to_f : nil,
          download_rate:valid_rate ? (connection['download'] - old[:download]) / interval.to_f : nil,
          chains:Array(connection['chains']), line:line_for(connection)
        }
      end
      @entries = next_entries
    end
    def reset; @entries = {}; end
  end

  class Engine
    attr_reader :tracker, :phase
    def initialize(api, spec, config, cancelled = -> { false }, observe = ->(_id) {})
      @api, @spec, @config, @cancelled, @observe = api, spec, DEFAULTS.merge(config), cancelled, observe
      @tracker = Tracker.new(spec.group, spec.endpoint)
      @phase, @events, @retired = spec.endpoint ? 'monitoring' : 'unavailable', [], 0
      @last_probe = @last_retire = nil
      @assessment_requested, @line_failures, @line_delays, @attached = false, {}, {}, true
    end
    def event(message)
      @events << {'time'=>Time.now.to_i,'message'=>message}; @events.shift while @events.length > 30
    end
    def auto?; @config['enabled'] && @config['mode'] == 'auto'; end
    def request_assessment; @assessment_requested = true; end
    def attached?
      current, seen = @spec.tunnel_group, {}
      12.times do
        return true if current == @spec.group
        return false if current.empty? || seen[current]
        seen[current] = true
        current = @api.group(current).fetch('now', '').to_s
      end
      false
    end
    def switch_to_observe
      return if @config['mode'] == 'observe' && @phase == 'bypassed'
      @config['mode'], @phase, @attached = 'observe', 'bypassed', false
      @observe.call(@spec.id)
      event('代理隧道的当前选择链已离开原生多线组；该出口已跳过，并切回只观察。')
    end
    def probe_lines
      lines = @tracker.entries.values.map { |entry| entry[:line] }.reject(&:empty?).uniq
      @line_failures.delete_if { |line,_| !lines.include?(line) }
      @line_delays.delete_if { |line,_| !lines.include?(line) }
      providers = @api.providers
      lines.each do |line|
        break if @cancelled.call
        line_owners = @spec.owners.fetch(line, [])
        unless line_owners.length == 1
          @line_delays[line], @line_failures[line] = [], 0
          next
        end
        provider = providers[line_owners.first] || {}
        node = Array(provider['proxies']).find { |item| item['name'].to_s == line }
        values = Array(node && node['history']).last(2).map { |item| item['delay'].to_i }.select { |delay| delay > 0 }
        @line_delays[line] = values
        healthy = node && (node['alive'] == true || (node['alive'].nil? && values.any?))
        @line_failures[line] = healthy ? 0 : @line_failures.fetch(line, 0) + 1
      end
      group = @api.group(@spec.group)
      @group_delays = Array(group['history']).last(2).map { |item| item['delay'].to_i }.select { |delay| delay > 0 }
    end
    def retire_one(now)
      return unless auto?
      return if @last_retire && now - @last_retire < @config['retire_interval']
      candidates = @tracker.entries.values.select do |entry|
        @line_failures.fetch(entry[:line], 0) >= @config['failure_rounds'] &&
          now - entry[:last_change] >= @config['idle_seconds']
      end
      idle = candidates.min_by { |entry| entry[:last_change] }
      return unless idle
      fresh = @api.connections.find { |connection| connection['id'] == idle[:id] }
      return unless fresh && @tracker.outer?(fresh) && fresh['start'] == idle[:start]
      return unless fresh['upload'] == idle[:upload] && fresh['download'] == idle[:download]
      return if @cancelled.call
      @api.close(idle[:id])
      @last_retire, @retired = now, @retired + 1
      event('已断开失效线路 ' + idle[:line] + ' 的一条持续空闲连接；后续建连交给 Clash 原生多线组。')
    rescue ApiError
      @phase = 'paused'; event('逐条断开结果无法确认，已暂停后续自动处理。')
    end
    def tick(now, connections = nil)
      @tracker.sample(connections || @api.connections, now)
      return if @cancelled.call || @phase == 'unavailable'
      unless attached?
        @attached = false
        return switch_to_observe
      end
      @attached = true
      if @phase == 'bypassed'
        @phase = 'monitoring'
        event('代理隧道已重新经过原生多线组；继续只观察，等待手动启用自动处理。')
      end
      return unless @config['enabled']
      return if @phase == 'paused'
      if @assessment_requested || !@last_probe || now - @last_probe >= @config['check_interval']
        @assessment_requested = false
        @last_probe = now
        probe_lines
      end
      retire_one(now)
    rescue StandardError => error
      @tracker.reset
      event('读取或验证失败（' + error.class.to_s + ': ' + error.message.to_s[0,120] + '）；本轮不关闭连接，观察窗口已重置。')
    end
    def status(now)
      settings = @config.reject { |key,_| key == 'enabled' }
      {
        'id'=>@spec.id, 'selector'=>@spec.selector, 'tunnel_group'=>@spec.tunnel_group, 'group'=>@spec.group,
        'endpoint'=>@spec.endpoint, 'eligible'=>@spec.eligible, 'settings'=>settings, 'enabled'=>@config['enabled'],
        'phase'=>@phase, 'attached'=>@attached, 'selected'=>@spec.group, 'target'=>nil, 'retired'=>@retired,
        'delays'=>@group_delays, 'bad_rounds'=>@line_failures.values.max.to_i, 'events'=>@events,
        'lines'=>@line_failures.map { |line, failures| {'name'=>line,'failures'=>failures,'delays'=>@line_delays[line]} },
        'tunnels'=>@tracker.entries.values.map do |entry|
          idle_seconds = [now-entry[:last_change],0].max.to_i
          reason = entry[:growing] ? 'transferring' : (idle_seconds < @config['idle_seconds'] ? 'observing' : 'idle')
          {'id'=>entry[:id], 'line'=>entry[:line], 'upload'=>entry[:upload], 'download'=>entry[:download],
           'sample_seconds'=>entry[:sample_seconds], 'upload_delta'=>entry[:upload_delta], 'download_delta'=>entry[:download_delta],
           'upload_rate'=>entry[:upload_rate], 'download_rate'=>entry[:download_rate],
           'idle_seconds'=>idle_seconds, 'protection_reason'=>reason, 'protected'=>reason != 'idle',
           'line_failures'=>@line_failures.fetch(entry[:line],0), 'line_delays'=>@line_delays[entry[:line]],
           'probeable'=>@spec.owners.fetch(entry[:line],[]).length == 1}
        end
      }
    end
  end

  class Manager
    attr_reader :engines
    def initialize(api, specs, config, cancelled = -> { false }, observe = ->(_id) {})
      @api, @cancelled, @global, @engines = api, cancelled, config.fetch('global', {}), {}
      specs.each do |spec|
        per_exit = DEFAULTS.merge(config.fetch('exits', {}).fetch(spec.id, {}))
        @engines[spec.id] = Engine.new(api, spec, per_exit, cancelled, observe)
      end
    end
    def command(action, id); @engines[id]&.request_assessment if action == 'assess'; end
    def refresh_telemetry
      snapshot = @api.connections
      now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      @sampled_at = Time.now.to_i
      @engines.each_value { |engine| engine.tracker.sample(snapshot, now) }
    rescue StandardError
      @sampled_at = nil
      @engines.each_value { |engine| engine.tracker.reset }
    end
    def tick(now)
      snapshot = @api.connections
      now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      @sampled_at = Time.now.to_i
      if @global['enabled']
        @engines.each_value { |engine| engine.tick(now, snapshot) }
      else
        @engines.each_value { |engine| engine.tracker.sample(snapshot, now) }
      end
    rescue StandardError
      @sampled_at = nil
      @engines.each_value { |engine| engine.tracker.reset }
    end
    def status(now)
      {'updated_at'=>Time.now.to_i, 'sampled_at'=>@sampled_at, 'enabled'=>@global['enabled'], 'exits'=>@engines.values.map { |engine| engine.status(now) }}
    end
  end

  def self.bool(value); value == true || value.to_s == '1'; end
  def self.integer(value, default, minimum, maximum)
    parsed = Integer(value); [[parsed, minimum].max, maximum].min
  rescue StandardError
    default
  end
  def self.configuration(path = nil)
    source = IO.popen(['uci','-q','get','openclash.config.config_path'], &:read).strip
    active = path || '/etc/openclash/' + File.basename(source)
    raw = IO.popen(['ubus','call','uci','get',json({'config'=>'proxy_view_guard'})], &:read)
    values = (YAML.safe_load(raw) || {})['values'] || {}
    global = {'enabled'=>bool((values['main'] || {})['enabled'])}
    exits = {}
    values.each_value do |section|
      next unless section['.type'] == 'exit'
      id = section['logical'].to_s
      next unless id.match?(/\A[A-Za-z0-9_-]{1,32}\z/)
      exits[id] = {
        'enabled'=>bool(section['enabled']), 'mode'=>%w[observe auto].include?(section['mode']) ? section['mode'] : 'observe',
        'idle_seconds'=>integer(section['idle_seconds'],120,120,86400),
        'check_interval'=>integer(section['check_interval'],60,15,3600),
        'failure_rounds'=>integer(section['failure_rounds'],3,1,20),
        'retire_interval'=>integer(section['retire_interval'],60,10,3600)
      }
    end
    {'mihomo_config'=>active, 'global'=>global, 'exits'=>exits}
  end
  def self.safe_kick(api, specs, logical, connection_id)
    spec = specs.find { |item| item.id == logical }
    raise ArgumentError, 'Unknown logical exit' unless spec && connection_id.match?(/\A[A-Za-z0-9._:-]{1,128}\z/)
    raise ArgumentError, 'Unknown exit endpoint' if spec.endpoint.to_s.empty?
    tracker = Tracker.new(spec.group, spec.endpoint)
    connection = api.connections.find { |item| item['id'] == connection_id }
    raise ArgumentError, 'Connection is outside this logical exit' unless connection && tracker.outer?(connection)
    api.close(connection_id)
  end

  def self.safe_kick_all(api, specs, logical)
    spec = specs.find { |item| item.id == logical }
    raise ArgumentError, 'Unknown logical exit' unless spec
    raise ArgumentError, 'Unknown exit endpoint' if spec.endpoint.to_s.empty?
    tracker = Tracker.new(spec.group, spec.endpoint)
    ids = api.connections.select { |connection| tracker.outer?(connection) }
      .map { |connection| connection['id'].to_s }
      .select { |id| id.match?(%r{\A[A-Za-z0-9._:-]{1,128}\z}) }.uniq
    queue = Queue.new
    ids.each { |id| queue << id }
    workers = [ids.size, 16].min.times.map do
      Thread.new do
        loop do
          begin
            id = queue.pop(true)
          rescue ThreadError
            break
          end
          begin
            api.close(id)
          rescue ApiError
            # A timed-out request may still have closed the connection.
            # The fresh snapshot below determines the actual result.
          end
        end
      end
    end
    workers.each(&:value)
    remaining = api.connections.map { |connection| connection['id'].to_s } & ids
    {'ok'=>remaining.empty?, 'matched'=>ids.size, 'closed'=>ids.size-remaining.size,
     'remaining'=>remaining.size, 'closed_ids'=>ids-remaining}
  end
end

if $PROGRAM_NAME == __FILE__
  File.umask(0o077); $stdout.sync = true
  Dir.mkdir(ProxyViewGuard::RUN_DIR,0o700) unless Dir.exist?(ProxyViewGuard::RUN_DIR)
  config = ProxyViewGuard.configuration
  if ARGV[0] == '--print-secret'
    secret = YAML.load_file(config.fetch('mihomo_config')).fetch('secret').to_s
    raise 'Invalid secret' if secret.empty? || secret.match?(/[\r\n]/)
    print secret; exit 0
  end
  api = ProxyViewGuard::Client.new(config.fetch('mihomo_config'))
  manual = %w[--kick --kick-all].include?(ARGV[0])
  api.cache_credentials! if manual
  specs = ProxyViewGuard::Discovery.new(api, config.fetch('mihomo_config')).call(manual: manual)
  if ARGV[0] == '--kick'
    ProxyViewGuard.safe_kick(api, specs, ARGV.fetch(1), ARGV.fetch(2)); exit 0
  end
  if ARGV[0] == '--kick-all'
    puts ProxyViewGuard.json(ProxyViewGuard.safe_kick_all(api, specs, ARGV.fetch(1))); exit 0
  end
  File.open(ProxyViewGuard::RUN_DIR + '/lock', File::RDWR | File::CREAT,0o600) do |lock|
    exit 0 unless lock.flock(File::LOCK_EX | File::LOCK_NB)
    stopped = false
    %w[INT TERM].each { |signal| Signal.trap(signal) { stopped = true } }
    persist_observe = lambda do |id|
      exists = system('uci', '-q', 'get', "proxy_view_guard.exit_#{id}", out: File::NULL, err: File::NULL)
      unless exists
        system('uci', 'set', "proxy_view_guard.exit_#{id}=exit")
        system('uci', 'set', "proxy_view_guard.exit_#{id}.logical=#{id}")
        system('uci', 'set', "proxy_view_guard.exit_#{id}.enabled=0")
      end
      system('uci', 'set', "proxy_view_guard.exit_#{id}.mode=observe")
      system('uci', 'commit', 'proxy_view_guard')
    end
    manager = ProxyViewGuard::Manager.new(api, specs, config, -> { stopped }, persist_observe)
    until stopped
      Dir.glob(ProxyViewGuard::RUN_DIR + '/command-*.yaml').each do |path|
        command = YAML.safe_load(File.read(path)) || {}
        manager.command(command['action'], command['logical']); File.unlink(path)
      rescue StandardError
        File.unlink(path) rescue nil
      end
      now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      api.share_providers { manager.tick(now) }
      manager.refresh_telemetry if Process.clock_gettime(Process::CLOCK_MONOTONIC) - now > 2
      ProxyViewGuard.atomic_write(ProxyViewGuard::RUN_DIR + '/status.json', ProxyViewGuard.json(manager.status(Process.clock_gettime(Process::CLOCK_MONOTONIC))))
      break if ARGV.include?('--once')
      deadline = now + 2
      until stopped || Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
        sleep [[deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC), 0.2].max, 1].min
      end
    end
  end
end
