require_relative '../openwrt/luci-app-proxy-view/guard/guard'

def verify(value, message); raise message unless value; end
URL = 'http://jp.example.test/generate_204'
NOW = Time.utc(2026,11,11,16,0,0).to_f
CONFIG = ProxyViewGuard::DEFAULTS

def samples(delays, ending=NOW)
  delays.each_with_index.map do |delay,index|
    {'time'=>Time.at(ending-(delays.size-1-index)*60).utc.strftime('%Y-%m-%dT%H:%M:%SZ'), 'delay'=>delay}
  end
end
def node(delays, ending=NOW)
  {'alive'=>false, 'history'=>[{'delay'=>9999}],
    'extra'=>{URL=>{'alive'=>true,'history'=>samples(delays,ending)},
      'http://tw.example.test/generate_204'=>{'alive'=>false,'history'=>samples([0,0,0],ending)}}}
end
def assess(nodes, evidence=ProxyViewGuard::HealthEvidence.new, now=NOW, config=CONFIG)
  evidence.assess(nodes,URL,now,config)
end

result=assess({'fast'=>node([50,60,70])})
verify(result['lines']['fast']['state']=='healthy' && result['recommendations'].empty?,
  'unrelated top-level/Taiwan failures must not degrade a healthy Japan path')

evidence=ProxyViewGuard::HealthEvidence.new
nodes={'failed'=>node([0])}
10.times { assess(nodes,evidence) }
result=assess(nodes,evidence)
verify(result['lines']['failed']['failures']==1 && result['recommendations'][0]['recommendation']=='watch',
  'polling one failed timestamp repeatedly must not manufacture failure rounds')

nodes['failed']=node([0,0,0])
result=assess(nodes,evidence)
verify(result['lines']['failed']['failures']==3 && result['recommendations'][0]['recommendation']=='consider_isolation',
  'three unique failed samples should produce advice')
verify(result['recommendations'][0]['alternative_count']==0,
  'no healthy alternative must be explicitly reported')
nodes['failed']=node([70],NOW+60)
result=assess(nodes,evidence,NOW+60)
verify(result['lines']['failed']['failures']==0 && result['recommendations'].empty?,
  'a fresh successful sample must immediately withdraw failure advice')

pool={'fast1'=>node([50,60,70]),'fast2'=>node([80,90,100]),'slow'=>node([2000,2200,2400])}
result=assess(pool)
advice=result['recommendations'].find { |item| item['name']=='slow' }
verify(advice && advice['kind']=='high_latency' && advice['rounds']==3 && advice['threshold_ms']==800,
  'persistent high latency must be compared with the absolute and relative threshold')
verify(advice['alternative_count']==2 && advice['samples'].size==3,
  'advice must include alternatives and dated evidence even without an active tunnel')
verify(result['summary']['candidate_count']==3,'all candidate nodes must be assessed')

result=assess({'outlier'=>node([50,3000,50]),'fast'=>node([50,50,50])})
verify(result['recommendations'].empty?,'one temporary latency spike must not produce isolation advice')
result=assess({'only'=>node([1500,1600,1700])})
verify(result['recommendations'].empty?,'a slow entire pool must not be judged by a fictional faster baseline')

evidence=ProxyViewGuard::HealthEvidence.new
assess({'stale'=>node([0,0,0])},evidence)
result=assess({'stale'=>node([0,0,0])},evidence,NOW+901)
verify(result['lines']['stale']['reason']=='stale' && result['recommendations'].empty?,
  'expired evidence must clear failure counts and recommendations')
result=assess({'legacy'=>{'alive'=>false,'history'=>samples([0,0,0])},'unknown'=>nil})
verify(result['summary']['unknown']==2 && result['recommendations'].empty?,
  'legacy mixed history, missing nodes and ambiguous ownership must remain unknown')
malformed=node([0,0,0]); malformed['extra'][URL]['history'].each { |entry| entry.delete('time') }
result=assess({'missing_time'=>malformed,'future'=>node([0,0,0],NOW+600)})
verify(result['summary']['unknown']==2,'missing timestamps and future samples must not be treated as failures')
duplicate=node([0]); duplicate['extra'][URL]['history']*=5
verify(assess({'duplicate'=>duplicate})['lines']['duplicate']['failures']==1,
  'duplicate timestamps inside one response must also be deduplicated')

reader=ProxyViewGuard::HealthEvidence.new
verify(reader.timestamp('2026-11-12T00:00:00+08:00')==NOW,'timezone offsets must be respected')
verify((reader.timestamp('2026-11-11T16:00:00.123456789Z')-NOW-0.123456789).abs<0.000001,
  'Mihomo fractional timestamps must work without extra Ruby libraries')
verify(reader.timestamp('not-a-time').nil?,'malformed timestamps must not escape the reader')

# A low-traffic but reachable connection is not evidence of low available bandwidth.
# Advice must never close a busy slow tunnel, alter groups, or probe extra URLs.
spec=ProxyViewGuard::ExitSpec.new(id:'jp',selector:'exit-node(jp)',tunnel_group:'tunnel',group:'multi',
  endpoint:'jp.example.test',eligible:pool.keys,owners:pool.keys.to_h { |name| [name,['airport']] },probe_url:URL)
api=Object.new
api.define_singleton_method(:connections) do
  [{'id'=>'busy','start'=>'session','upload'=>1,'download'=>1,
    'metadata'=>{'type'=>'Inner','host'=>'jp.example.test','network'=>'tcp'},'chains'=>['slow','multi','tunnel']}]
end
api.define_singleton_method(:group) { |name| name=='tunnel' ? {'now'=>'multi'} : {'testUrl'=>URL,'all'=>pool.keys} }
api.define_singleton_method(:providers) do
  {'airport'=>{'proxies'=>pool.map { |name,value| node(value['extra'][URL]['history'].map { |s| s['delay'] },Time.now.to_i).merge('name'=>name) }}}
end
api.define_singleton_method(:close) { |_id| raise 'advice closed a connection' }
guard=ProxyViewGuard::Engine.new(api,spec,{'enabled'=>true,'mode'=>'auto'})
(0..300).step(5) { |time| guard.tick(time) }
status=guard.status(300)
verify(status['recommendations'].any? { |item| item['name']=='slow' },'slow candidate must remain visible in advice')
verify(status['retired']==0,'high-latency advice must never trigger automatic idle retirement')
verify(status['health_summary']['unknown']==0,'scoped fixtures must be readable in the engine')
puts 'PASS: scoped health, sample freshness and deduplication, full-pool advice, recovery, alternatives and no automatic isolation'
