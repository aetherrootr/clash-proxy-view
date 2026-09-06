require_relative '../openwrt/luci-app-proxy-view/guard/guard'

TUNNEL = '➡️ 代理隧道(tw)'
FALLBACK = '🔀 台湾出口｜自动容灾'
GROUP = '⚡ 台湾出口｜多线加速'
HOST = 'tw-server.example.test'
LINE = '机场 / broken'
SPEC = ProxyViewGuard::ExitSpec.new(id:'tw', selector:'exit-node(tw)', tunnel_group:TUNNEL,
  group:GROUP, endpoint:HOST, eligible:[LINE,'机场 / healthy'],
  owners:{LINE=>['airport'],'机场 / healthy'=>['airport']})

def tunnel(id, line=LINE, upload=0, host=HOST, group=GROUP)
  {'id'=>id,'start'=>'2026-09-06T00:00:00Z','upload'=>upload,'download'=>0,
   'metadata'=>{'type'=>'Inner','host'=>host,'network'=>'tcp'},'chains'=>[line,group,FALLBACK,TUNNEL]}
end

class FakeClient
  attr_accessor :list, :route, :provider_alive, :provider_delays, :fail_delete
  attr_reader :closed, :probed
  def initialize(list)
    @list, @route = list, {TUNNEL=>FALLBACK,FALLBACK=>GROUP}
    @provider_alive, @provider_delays, @closed, @probed = false, [], [], []
  end
  def group(name)
    return {'now'=>'','history'=>[{'delay'=>80},{'delay'=>90}]} if name == GROUP
    {'now'=>@route.fetch(name,'')}
  end
  def connections; Marshal.load(Marshal.dump(@list)); end
  def providers
    @probed << LINE
    {'airport'=>{'proxies'=>[{'name'=>LINE,'alive'=>@provider_alive,
      'history'=>@provider_delays.map { |delay| {'delay'=>delay} }}]}}
  end
  def close(id)
    raise ProxyViewGuard::ApiError if @fail_delete
    @closed << id; @list.reject! { |connection| connection['id'] == id }
  end
end

def engine(api, mode='auto', observe=->(_id) {})
  ProxyViewGuard::Engine.new(api,SPEC,{
    'enabled'=>true,'mode'=>mode,'idle_seconds'=>120,'check_interval'=>60,
    'failure_rounds'=>2,'candidate_timeout_ms'=>500,'retire_interval'=>60
  },-> { false },observe)
end
def check(value, message); raise message unless value; end
def ticks(instance, from, to)
  (from..to).step(5) { |time| yield time if block_given?; instance.tick(time) }
end

api=FakeClient.new([tunnel('slow'),tunnel('idle1'),tunnel('idle2')]); guard=engine(api)
ticks(guard,0,120) { |time| api.list.find { |c| c['id']=='slow' }['upload']=time/5 }
check(api.closed==['idle1'],"must preserve a transferring connection and close only one idle failed line: #{api.closed.inspect}")
reasons=guard.status(120)['tunnels'].to_h { |item| [item['id'],item['protection_reason']] }
check(reasons['slow']=='transferring' && reasons['idle2']=='idle','status must distinguish transferring and idle connections')
ticks(guard,125,180) { |time| api.list.find { |c| c['id']=='slow' }['upload']=time/5 }
check(api.closed==['idle1','idle2'],'a later interval may retire one more idle connection')

api=FakeClient.new([tunnel('working')]); api.provider_alive=true; api.provider_delays=[60]; guard=engine(api); ticks(guard,0,300)
check(api.closed.empty?,'one successful line probe must keep the line')
api=FakeClient.new([tunnel('stale')]); api.provider_alive=false; api.provider_delays=[60]; guard=engine(api); guard.tick(0)
check(guard.status(0)['tunnels'][0]['line_failures']==1,'current alive=false must override stale successful history')
api=FakeClient.new([tunnel('observed')]); guard=engine(api,'observe'); ticks(guard,0,300)
check(api.closed.empty? && !api.probed.empty?,'observe mode must probe but never close')

api=FakeClient.new([tunnel('gap')]); guard=engine(api); guard.tick(0); guard.tick(120); guard.tick(240)
check(api.closed.empty?,'sampling gaps must reset idle evidence')
api=FakeClient.new([tunnel('fresh')]); guard=engine(api); ticks(guard,0,115)
reads=0
api.define_singleton_method(:connections) do
  reads += 1; @list[0]['download'] += 1 if reads == 1
  Marshal.load(Marshal.dump(@list))
end
guard.tick(180)
check(api.closed.empty?,'fresh byte growth must cancel a pending close')

observed=[]; api=FakeClient.new([]); api.route[TUNNEL]='🛡 台湾出口｜稳定优选'
guard=engine(api,'auto',->(id){observed << id}); guard.tick(0)
status=guard.status(0)
check(observed==['tw'] && status['settings']['mode']=='observe' && !status['attached'],
  'leaving the native multi-line selection chain must persist observe mode')
check(api.closed.empty? && api.probed.empty?,'detached tunnel must not probe or close')

tracker=ProxyViewGuard::Tracker.new(GROUP,HOST)
other=tunnel('other',LINE,0,'jp-server.example.test','⚡ 日本出口｜多线加速')
client=tunnel('client'); client['metadata']['type']='Socks5'
tracker.sample([tunnel('tw'),other,client],0)
check(tracker.entries.keys==['tw'] && tracker.entries['tw'][:line]==LINE,'tracker must match the logical group and extract its leaf line')
api=FakeClient.new([tunnel('manual')]); ProxyViewGuard.safe_kick(api,[SPEC],'tw','manual')
check(api.closed==['manual'],'manual kick must validate the logical exit')
begin
  ProxyViewGuard.safe_kick(FakeClient.new([other]),[SPEC],'tw','other'); raise 'unsafe kick was accepted'
rescue ArgumentError
end

discovery_api=Object.new
def discovery_api.proxies
  {'exit-node(tw)'=>{'now'=>'tw-exit'},TUNNEL=>{'now'=>FALLBACK,'all'=>[FALLBACK,GROUP]},
   FALLBACK=>{'now'=>GROUP,'all'=>[GROUP]},GROUP=>{'type'=>'LoadBalance','all'=>[LINE,'Traffic Reset: 4 Days Left']},
   'exit-node(orphan)'=>{'now'=>'none'}}
end
def discovery_api.providers
  {'airport'=>{'proxies'=>[{'name'=>LINE}]},'other'=>{'proxies'=>[{'name'=>'duplicate'}]}}
end
specs=ProxyViewGuard::Discovery.new(discovery_api).call
check(specs.map(&:id)==['tw'] && specs.first.group==GROUP,'discovery must use the subscription native multi-line group')
check(specs.first.eligible==[LINE],'discovery must omit subscription metadata entries')

payload={'unicode'=>'台湾','quoted'=>"a\"\\\n\t",'nested'=>[true,false,nil,1,1.25]}
check(YAML.safe_load(ProxyViewGuard.json(payload))==payload,'status JSON must be valid')
check(ProxyViewGuard::Client.new('/unused').encode('a /')=='a%20%2F','API paths must be encoded')
puts 'PASS: native multi-line discovery, Provider health, active-transfer protection, gradual disconnect, ownership gate, manual kick and encoding'
