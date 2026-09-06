'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Cable,
  CircleAlert,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  Search,
  Settings2,
  Unplug,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  TrafficFlowMap,
  type TrafficFlow,
  type TunnelFlow,
} from '@/components/traffic-flow-map';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MihomoClient, type MihomoProxy } from '@/lib/mihomo';
import { GradualRoutingDialog } from '@/components/gradual-routing-dialog';

const DEFAULT_ENDPOINT = 'http://192.168.8.1:9090';
const ASIA_PATTERN = /(港|HK|Hong Kong|日本|东京|大阪|JP|Japan|台|台北|新北|彰化|TW|Taiwan|新加坡|坡|狮城|SG|Singapore)/;

type BaseNode = {
  name: string;
  provider: string;
  alive: boolean;
  latency: number;
  region: string;
};

type NodeRow = BaseNode & {
  connectionIds: string[];
  connections: number;
  downRate: number;
  upRate: number;
  download: number;
  upload: number;
};

type ConnectionRates = {
  connectionIds: string[];
  downRate: number;
  upRate: number;
  download: number;
  upload: number;
};

type SavedConfig = {
  endpoint: string;
  secret: string;
  rememberSecret: boolean;
};

type PreviousConnection = { upload: number; download: number };
type LogicalExit = { id: string; label: string };

function exitLabel(id: string) {
  if (id.toLowerCase() === 'tw') return '台湾';
  if (id.toLowerCase() === 'jp') return '日本';
  return id;
}

function logicalExitIn(chains: string[]) {
  for (const name of chains) {
    const match = /(?:exit-node|代理隧道)\(([A-Za-z0-9_-]+)\)/i.exec(name);
    if (match) return match[1];
  }
}

function regionOf(name: string) {
  if (/(港|HK|Hong Kong)/.test(name)) return '香港';
  if (/(台|台北|新北|彰化|TW|Taiwan)/.test(name)) return '台湾';
  if (/(新加坡|坡|狮城|SG|Singapore)/.test(name)) return '新加坡';
  if (/(日本|东京|大阪|JP|Japan)/.test(name)) return '日本';
  return '其他';
}

function latestDelay(proxy: MihomoProxy) {
  const valid = (proxy.history ?? []).map((item) => item.delay ?? 0).filter(Boolean);
  return valid.at(-1) ?? 0;
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unit]}`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unit]}`;
}

function loadConfig(): SavedConfig {
  if (typeof window === 'undefined') {
    return { endpoint: DEFAULT_ENDPOINT, secret: '', rememberSecret: false };
  }
  const embedded = /^\/ui\/proxy-view(?:\/|$)/.test(window.location.pathname);
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const bootstrapSecret = fragment.get('proxy-view-auth') ?? '';
  if (bootstrapSecret) {
    localStorage.setItem('mihomo:secret', bootstrapSecret);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  const savedSecret = bootstrapSecret || localStorage.getItem('mihomo:secret') || '';
  return {
    endpoint: embedded
      ? window.location.origin
      : localStorage.getItem('mihomo:endpoint') || DEFAULT_ENDPOINT,
    secret: savedSecret,
    rememberSecret: Boolean(savedSecret),
  };
}

function normalizeEndpoint(value: string) {
  const endpoint = value.trim().replace(/\/+$/, '');
  if (!endpoint) return DEFAULT_ENDPOINT;
  return /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
}

function StatusPill({ alive, active }: { alive: boolean; active: boolean }) {
  const label = !alive ? '故障' : active ? '传输中' : '空闲';
  const tone = !alive
    ? 'border-rose-400/30 bg-rose-400/10 text-rose-300'
    : active
      ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200'
      : 'border-white/10 bg-white/5 text-slate-400';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}>
      <span className={`size-1.5 rounded-full ${!alive ? 'bg-rose-400' : active ? 'bg-cyan-300 animate-pulse' : 'bg-slate-500'}`} />
      {label}
    </span>
  );
}

export default function Home() {
  const [config, setConfig] = useState<SavedConfig>({ endpoint: DEFAULT_ENDPOINT, secret: '', rememberSecret: false });
  const [draft, setDraft] = useState<SavedConfig>(config);
  const [configReady, setConfigReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [version, setVersion] = useState('');
  const [error, setError] = useState('');
  const [nodes, setNodes] = useState<BaseNode[]>([]);
  const [rates, setRates] = useState<Map<string, ConnectionRates>>(new Map());
  const [flows, setFlows] = useState<TrafficFlow[]>([]);
  const [tunnelFlows, setTunnelFlows] = useState<TunnelFlow[]>([]);
  const [groups, setGroups] = useState<MihomoProxy[]>([]);
  const [totals, setTotals] = useState({ down: 0, up: 0, connections: 0 });
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [regionFilter, setRegionFilter] = useState('all');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [kickTarget, setKickTarget] = useState<NodeRow | null>(null);
  const [kicking, setKicking] = useState(false);
  const [gradualExit, setGradualExit] = useState<LogicalExit | null>(null);
  const [notice, setNotice] = useState('');
  const previousConnections = useRef<Map<string, PreviousConnection>>(new Map());
  const previousTimestamp = useRef(0);
  const autoConnectedConfig = useRef('');

  useEffect(() => {
    queueMicrotask(() => {
      const saved = loadConfig();
      setConfig(saved);
      setDraft(saved);
      setConfigReady(true);
    });
  }, []);

  const client = useMemo(() => new MihomoClient(config.endpoint, config.secret), [config.endpoint, config.secret]);

  const refreshTopology = useCallback(async () => {
    const [providerData, proxyData] = await Promise.all([client.providers(), client.proxies()]);
    const proxyValues = Object.values(proxyData.proxies ?? {});
    const fastGroups = proxyValues.filter((proxy) => proxy.name.includes('出口｜多线加速'));
    const poolNames = new Set(fastGroups.flatMap((group) => group.all ?? []));
    const nextNodes: BaseNode[] = [];

    for (const [providerName, provider] of Object.entries(providerData.providers ?? {})) {
      for (const proxy of provider.proxies ?? []) {
        if (poolNames.size ? !poolNames.has(proxy.name) : !ASIA_PATTERN.test(proxy.name)) continue;
        nextNodes.push({
          name: proxy.name,
          provider: providerName,
          alive: proxy.alive !== false,
          latency: latestDelay(proxy),
          region: regionOf(proxy.name),
        });
      }
    }

    setNodes([...new Map(nextNodes.map((node) => [node.name, node])).values()]);
    setGroups(proxyValues.filter((proxy) => proxy.name.includes('出口｜') || proxy.name.startsWith('➡️ 代理隧道')));
  }, [client]);

  const refreshConnections = useCallback(async () => {
    const snapshot = await client.connections();
    const connections = snapshot.connections ?? [];
    const now = performance.now();
    const elapsed = previousTimestamp.current ? Math.max((now - previousTimestamp.current) / 1000, 0.25) : 1;
    const nodeNames = new Set(nodes.map((node) => node.name));
    const nextRates = new Map<string, ConnectionRates>();
    const nextPrevious = new Map<string, PreviousConnection>();
    const nextFlows: TrafficFlow[] = [];
    const nextTunnelFlows: TunnelFlow[] = [];

    for (const connection of connections) {
      nextPrevious.set(connection.id, { upload: connection.upload, download: connection.download });
      const previous = previousConnections.current.get(connection.id);
      const downRate = previous ? Math.max(connection.download - previous.download, 0) / elapsed : 0;
      const upRate = previous ? Math.max(connection.upload - previous.upload, 0) / elapsed : 0;
      const metadata = connection.metadata ?? {};
      const chainNames = [...(connection.chains ?? []), ...(connection.providerChains ?? [])];
      const nodeName = chainNames.find((name) => nodeNames.has(name));
      const isInner = metadata.type?.toLowerCase() === 'inner';

      if (!isInner) {
        const logical = logicalExitIn(chainNames);
        const route = logical
          ? `${exitLabel(logical)}出口`
          : chainNames.some((name) => name.toUpperCase() === 'DIRECT')
            ? '直连'
            : chainNames[0] || '其他出口';
        const clientName = metadata.sourceIP
          || metadata.process
          || metadata.processPath?.split(/[\\/]/).at(-1)
          || '路由器本机';
        const destinationHost = metadata.host || metadata.destinationIP || '未知目标';
        const destination = metadata.destinationPort
          ? `${destinationHost}:${metadata.destinationPort}`
          : destinationHost;
        nextFlows.push({ id: connection.id, client: clientName, destination, route, downRate, upRate });
      }

      if (!nodeName) continue;
      const current = nextRates.get(nodeName) ?? { connectionIds: [], downRate: 0, upRate: 0, download: 0, upload: 0 };
      current.connectionIds.push(connection.id);
      current.download += connection.download;
      current.upload += connection.upload;
      current.downRate += downRate;
      current.upRate += upRate;
      nextRates.set(nodeName, current);

      if (isInner) {
        const logical = logicalExitIn(chainNames);
        const exit = logical
          ? `${exitLabel(logical)}出口 VM`
          : metadata.host || metadata.destinationIP || '出口 VM';
        nextTunnelFlows.push({ id: connection.id, line: nodeName, exit, downRate, upRate });
      }
    }

    previousConnections.current = nextPrevious;
    previousTimestamp.current = now;
    setRates(nextRates);
    setFlows(nextFlows);
    setTunnelFlows(nextTunnelFlows);
    setTotals({
      down: [...nextRates.values()].reduce((sum, item) => sum + item.downRate, 0),
      up: [...nextRates.values()].reduce((sum, item) => sum + item.upRate, 0),
      connections: connections.length,
    });
    setLastUpdated(new Date());
  }, [client, nodes]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError('');
    try {
      const info = await client.version();
      setVersion(info.version ?? 'Mihomo');
      await refreshTopology();
      setConnected(true);
    } catch (cause) {
      setConnected(false);
      setError(cause instanceof TypeError
        ? '无法访问本地 Dashboard 服务。请检查命令行进程是否仍在运行。'
        : cause instanceof Error ? cause.message : '连接失败。');
    } finally {
      setConnecting(false);
    }
  }, [client, refreshTopology]);

  useEffect(() => {
    const configKey = `${config.endpoint}\u0000${config.secret}`;
    if (!configReady || connected || connecting || autoConnectedConfig.current === configKey) return;
    autoConnectedConfig.current = configKey;
    void connect();
  }, [config.endpoint, config.secret, configReady, connect, connected, connecting]);

  useEffect(() => {
    if (!connected) return;
    queueMicrotask(() => {
      void refreshConnections().catch((cause) => {
        setError(cause instanceof Error ? cause.message : '刷新连接失败。');
        setConnected(false);
      });
    });
    const connectionTimer = window.setInterval(() => {
      void refreshConnections().catch((cause) => {
        setError(cause instanceof Error ? cause.message : '刷新连接失败。');
        setConnected(false);
      });
    }, 1000);
    const topologyTimer = window.setInterval(() => void refreshTopology(), 10_000);
    return () => {
      window.clearInterval(connectionTimer);
      window.clearInterval(topologyTimer);
    };
  }, [connected, refreshConnections, refreshTopology]);

  const rows = useMemo<NodeRow[]>(() => nodes
    .map((node) => {
      const activity = rates.get(node.name);
      return {
        ...node,
        latency: node.latency,
        connectionIds: activity?.connectionIds ?? [],
        connections: activity?.connectionIds.length ?? 0,
        downRate: activity?.downRate ?? 0,
        upRate: activity?.upRate ?? 0,
        download: activity?.download ?? 0,
        upload: activity?.upload ?? 0,
      };
    })
    .filter((row) => {
      const matchesQuery = `${row.name} ${row.provider}`.toLowerCase().includes(query.toLowerCase());
      const matchesRegion = regionFilter === 'all' || row.region === regionFilter;
      const matchesStatus = statusFilter === 'all' || (statusFilter === 'active' && row.connections > 0) || (statusFilter === 'idle' && row.connections === 0 && row.alive) || (statusFilter === 'dead' && !row.alive);
      return matchesQuery && matchesRegion && matchesStatus;
    })
    .sort((a, b) => {
      if (a.connections !== b.connections) return b.connections - a.connections;
      if (a.alive !== b.alive) return Number(a.alive) - Number(b.alive);
      return b.downRate + b.upRate - (a.downRate + a.upRate);
    }), [nodes, query, rates, regionFilter, statusFilter]);

  const activeNodes = nodes.filter((node) => (rates.get(node.name)?.connectionIds.length ?? 0) > 0).length;
  const healthyNodes = nodes.filter((node) => node.alive).length;
  const logicalExits = useMemo(() => groups.map((group) => {
    const match = /^➡️ 代理隧道\(([A-Za-z0-9_-]+)\)$/.exec(group.name);
    return match ? { id: match[1], label: exitLabel(match[1]), tunnel: group } : null;
  }).filter((item): item is { id: string; label: string; tunnel: MihomoProxy } => Boolean(item)), [groups]);

  function saveSettings() {
    const next = { ...draft, endpoint: normalizeEndpoint(draft.endpoint) };
    localStorage.setItem('mihomo:endpoint', next.endpoint);
    if (next.rememberSecret && next.secret) localStorage.setItem('mihomo:secret', next.secret);
    else localStorage.removeItem('mihomo:secret');
    previousConnections.current.clear();
    setConfig(next);
    setConnected(false);
    setSettingsOpen(false);
  }

  async function kickConnections() {
    if (!kickTarget) return;
    setKicking(true);
    try {
      await client.closeConnections(kickTarget.connectionIds);
      setKickTarget(null);
      await refreshConnections();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '关闭连接失败。');
    } finally {
      setKicking(false);
    }
  }


  return (
    <main className="min-h-screen bg-[#071019] text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col px-4 pb-10 pt-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-white/8 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200 shadow-[0_0_30px_rgba(34,211,238,.08)]"><Cable className="size-5" /></div>
            <div><h1 className="text-lg font-semibold tracking-tight">多线代理控制台</h1><p className="text-sm text-slate-500">节点健康、实时传输与连接处置</p></div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex h-8 items-center gap-2 rounded-lg border px-3 text-sm ${connected ? 'border-emerald-400/20 bg-emerald-400/8 text-emerald-300' : 'border-white/10 bg-white/4 text-slate-400'}`}><span className={`size-2 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,.7)]' : 'bg-slate-600'}`} />{connected ? version : '未连接'}</span>
            <Button variant="outline" className="border-white/10 bg-white/4 text-slate-200 hover:bg-white/8" onClick={() => void connect()} disabled={connecting}>{connecting ? <LoaderCircle className="animate-spin" /> : <PlugZap />}{connected ? '重新连接' : '连接 API'}</Button>
            <Button variant="outline" size="icon" className="border-white/10 bg-white/4 text-slate-200 hover:bg-white/8" aria-label="连接设置" onClick={() => { setDraft(config); setSettingsOpen(true); }}><Settings2 /></Button>
          </div>
        </header>

        {error && <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-400/8 px-4 py-3 text-sm text-amber-100"><CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-300" /><p className="flex-1">{error}</p><button aria-label="关闭错误提示" onClick={() => setError('')} className="text-amber-200/70 hover:text-amber-100"><X className="size-4" /></button></div>}
        {notice && <div className="mt-4 flex items-start gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/8 px-4 py-3 text-sm text-emerald-100"><RefreshCw className="mt-0.5 size-4 shrink-0 text-emerald-300" /><p className="flex-1">{notice}</p><button aria-label="关闭操作提示" onClick={() => setNotice('')} className="text-emerald-200/70 hover:text-emerald-100"><X className="size-4" /></button></div>}

        <section className="grid gap-3 py-5 sm:grid-cols-2 xl:grid-cols-4" aria-label="实时摘要">
          {[
            { label: '健康线路', value: connected ? `${healthyNodes} / ${nodes.length}` : '—', meta: `${nodes.length - healthyNodes} 条故障`, icon: Wifi, color: 'text-emerald-300' },
            { label: '正在传输', value: connected ? String(activeNodes) : '—', meta: `${totals.connections} 个活动连接`, icon: Activity, color: 'text-cyan-300' },
            { label: '实时下载', value: connected ? formatRate(totals.down) : '—', meta: '按连接增量统计', icon: ArrowDown, color: 'text-sky-300' },
            { label: '实时上传', value: connected ? formatRate(totals.up) : '—', meta: lastUpdated ? `更新于 ${lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}` : '等待连接', icon: ArrowUp, color: 'text-violet-300' },
          ].map((item) => <article key={item.label} className="relative overflow-hidden rounded-2xl border border-white/8 bg-[#0c1823] p-4 shadow-[0_14px_40px_rgba(0,0,0,.16)]"><div className="flex items-center justify-between"><p className="text-sm text-slate-400">{item.label}</p><item.icon className={`size-4 ${item.color}`} /></div><p className="mt-3 font-mono text-2xl font-semibold tracking-tight text-white">{item.value}</p><p className="mt-1 text-xs text-slate-500">{item.meta}</p></article>)}
        </section>

        <section className="mb-5 grid gap-3 lg:grid-cols-2" aria-label="出口策略状态">
          {logicalExits.map(({ id, label, tunnel }) => {
            const auto = groups.find((group) => group.name.includes(`${label}出口｜自动容灾`));
            const icon = id.toLowerCase() === 'jp' ? '🇯🇵' : id.toLowerCase() === 'tw' ? '🇹🇼' : '🌐';
            return <article key={id} className="flex items-center justify-between gap-4 rounded-2xl border border-white/8 bg-gradient-to-r from-[#0d1b27] to-[#0a151f] px-4 py-3.5"><div className="flex min-w-0 items-center gap-3"><div className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/5 text-lg">{icon}</div><div className="min-w-0"><p className="text-sm font-medium">{label}出口 <span className="font-mono text-xs text-slate-500">({id})</span></p><p className="truncate text-xs text-slate-500">隧道：{tunnel.now ?? '等待连接'}</p></div></div><div className="flex items-center gap-3"><div className="text-right"><p className="text-sm text-cyan-200">{auto?.now ?? '—'}</p><p className="mt-0.5 text-xs text-slate-500">{auto?.alive === false ? '探测失败' : auto ? '探测正常' : '未发现自动容灾组'}</p></div><Button variant="outline" size="sm" className="shrink-0 border-white/10 bg-white/4 text-slate-300 hover:bg-white/8" onClick={() => setGradualExit({ id, label })} disabled={!connected}><RefreshCw />管理换线</Button></div></article>;
          })}
        </section>

        <TrafficFlowMap
          flows={flows}
          tunnelFlows={tunnelFlows}
          lines={nodes.map((node) => {
            const activity = rates.get(node.name);
            return {
              name: node.name,
              alive: node.alive,
              connections: activity?.connectionIds.length ?? 0,
              downRate: activity?.downRate ?? 0,
              upRate: activity?.upRate ?? 0,
            };
          })}
        />

        <section className="flex min-h-[520px] flex-1 flex-col overflow-hidden rounded-2xl border border-white/8 bg-[#0a151f] shadow-[0_22px_70px_rgba(0,0,0,.22)]">
          <div className="flex flex-col gap-3 border-b border-white/8 p-4 lg:flex-row lg:items-center lg:justify-between"><div><h2 className="font-medium">亚洲中转线路</h2><p className="mt-1 text-xs text-slate-500">速度来自活动连接的字节增量；空闲不代表线路故障。</p></div><div className="flex flex-col gap-2 sm:flex-row"><div className="relative min-w-60"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-slate-600" /><Input aria-label="搜索节点或机场" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索节点或机场" className="border-white/10 bg-black/15 pl-9 text-slate-200 placeholder:text-slate-600" /></div><select value={regionFilter} onChange={(event) => setRegionFilter(event.target.value)} className="h-8 rounded-lg border border-white/10 bg-[#0d1b27] px-2.5 text-sm text-slate-300 outline-none focus:border-cyan-400/50" aria-label="地区筛选"><option value="all">全部地区</option><option>香港</option><option>台湾</option><option>新加坡</option><option>日本</option></select><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-8 rounded-lg border border-white/10 bg-[#0d1b27] px-2.5 text-sm text-slate-300 outline-none focus:border-cyan-400/50" aria-label="状态筛选"><option value="all">全部状态</option><option value="active">传输中</option><option value="idle">空闲</option><option value="dead">故障</option></select><Button variant="outline" size="icon" aria-label="刷新" className="border-white/10 bg-white/4 text-slate-300 hover:bg-white/8" onClick={() => void Promise.all([refreshTopology(), refreshConnections()])} disabled={!connected}><RefreshCw /></Button></div></div>

          <div className="min-h-0 flex-1 overflow-auto"><Table><TableHeader className="sticky top-0 z-10 bg-[#0b1721]/95 backdrop-blur"><TableRow className="border-white/8 hover:bg-transparent"><TableHead className="min-w-72 text-slate-500">线路</TableHead><TableHead className="text-slate-500">状态</TableHead><TableHead className="text-right text-slate-500">延迟</TableHead><TableHead className="text-right text-slate-500">连接</TableHead><TableHead className="min-w-36 text-right text-slate-500">实时速度</TableHead><TableHead className="text-right text-slate-500">活动流量</TableHead><TableHead className="text-right text-slate-500">操作</TableHead></TableRow></TableHeader><TableBody>
            {!connected ? <TableRow className="border-0 hover:bg-transparent"><TableCell colSpan={7} className="h-80 text-center"><div className="mx-auto flex max-w-sm flex-col items-center"><WifiOff className="size-9 text-slate-700" /><p className="mt-4 font-medium text-slate-300">连接本地 Mihomo API</p><p className="mt-2 text-sm leading-6 text-slate-500">配置控制器地址和密钥后，这里会显示每条亚洲中转线路的健康、延迟和实时速度。</p><Button className="mt-5 bg-cyan-300 text-slate-950 hover:bg-cyan-200" onClick={() => setSettingsOpen(true)}><Settings2 />配置连接</Button></div></TableCell></TableRow> : rows.length === 0 ? <TableRow className="border-0 hover:bg-transparent"><TableCell colSpan={7} className="h-80 text-center text-slate-500">当前筛选条件下没有线路。</TableCell></TableRow> : rows.map((row) => <TableRow key={row.name} className="border-white/6 hover:bg-white/[.025]"><TableCell><div className="flex items-center gap-3"><div className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/8 bg-white/4 text-xs font-semibold text-slate-300">{row.region.slice(0, 1)}</div><div className="min-w-0"><p className="max-w-[420px] truncate text-sm text-slate-200" title={row.name}>{row.name}</p><p className="mt-1 text-xs text-slate-600">{row.provider} · {row.region}</p></div></div></TableCell><TableCell><StatusPill alive={row.alive} active={row.connections > 0} /></TableCell><TableCell className="text-right font-mono text-sm"><span className={!row.alive ? 'text-rose-300' : row.latency && row.latency < 150 ? 'text-emerald-300' : 'text-amber-300'}>{row.latency ? `${row.latency} ms` : '—'}</span></TableCell><TableCell className="text-right font-mono text-sm text-slate-300">{row.connections}</TableCell><TableCell className="text-right"><p className="font-mono text-sm text-sky-300">↓ {formatRate(row.downRate)}</p><p className="mt-1 font-mono text-xs text-violet-300/80">↑ {formatRate(row.upRate)}</p></TableCell><TableCell className="text-right font-mono text-xs text-slate-500">{formatBytes(row.download + row.upload)}</TableCell><TableCell><div className="flex justify-end"><Button variant="destructive" size="sm" onClick={() => setKickTarget(row)} disabled={!row.connectionIds.length}><Unplug />踢掉连接</Button></div></TableCell></TableRow>)}
          </TableBody></Table></div>
        </section>

        <footer className="flex flex-col gap-1 pt-4 text-xs text-slate-600 sm:flex-row sm:items-center sm:justify-between"><p>密钥仅保存在本机浏览器中；关闭连接不会永久移除节点。</p><p className="font-mono">{config.endpoint}</p></footer>
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="border-white/10 bg-[#0c1823] text-slate-100 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>连接本地 Clash API</DialogTitle>
            <DialogDescription className="text-slate-400">本地命令行服务代为连接控制器；地址与密钥不会上传到任何云端服务。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div>
              <label htmlFor="controller-endpoint" className="mb-1.5 block text-sm text-slate-300">控制器地址</label>
              <Input id="controller-endpoint" value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} placeholder="192.168.8.1:9090" className="border-white/10 bg-black/20 font-mono text-slate-100" />
              <p className="mt-1.5 text-xs text-slate-500">可以直接填写 IP 和端口，未写协议时自动使用 http://。</p>
            </div>
            <div>
              <label htmlFor="controller-secret" className="mb-1.5 block text-sm text-slate-300">API 密钥</label>
              <Input id="controller-secret" type="password" value={draft.secret} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} placeholder="Mihomo secret" className="border-white/10 bg-black/20 font-mono text-slate-100" />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-white/8 bg-white/[.025] px-3 py-3"><div><p className="text-sm text-slate-300">记住密钥</p><p className="mt-0.5 text-xs text-slate-500">仅写入当前浏览器的 localStorage</p></div><Switch aria-label="记住 API 密钥" checked={draft.rememberSecret} onCheckedChange={(checked) => setDraft({ ...draft, rememberSecret: checked })} /></div>
          </div>
          <DialogFooter><Button variant="outline" className="border-white/10 bg-white/4" onClick={() => setSettingsOpen(false)}>取消</Button><Button className="bg-cyan-300 text-slate-950 hover:bg-cyan-200" onClick={saveSettings}>保存并连接</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(kickTarget)} onOpenChange={(open) => !open && setKickTarget(null)}><AlertDialogContent className="border-white/10 bg-[#0c1823] text-slate-100"><AlertDialogHeader><AlertDialogMedia className="bg-rose-400/10 text-rose-300"><Unplug /></AlertDialogMedia><AlertDialogTitle>关闭这条线路的活动连接？</AlertDialogTitle><AlertDialogDescription className="text-slate-400"><span className="block break-all text-slate-200">{kickTarget?.name}</span><span className="mt-2 block">将关闭 {kickTarget?.connectionIds.length ?? 0} 条当前连接。应用可能立即重连，节点也不会从负载均衡池中永久移除。</span></AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={kicking}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void kickConnections()} disabled={kicking}>{kicking ? <LoaderCircle className="animate-spin" /> : <Unplug />}确认关闭</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>

      <GradualRoutingDialog logicalExit={gradualExit} endpoint={config.endpoint} onClose={() => setGradualExit(null)} />
    </main>
  );
}
