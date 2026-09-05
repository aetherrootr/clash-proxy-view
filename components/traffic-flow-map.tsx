'use client';

import { useMemo } from 'react';
import { Activity, CircleOff, Network, Route, Wifi } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type TrafficFlow = {
  id: string;
  client: string;
  destination: string;
  route: string;
  downRate: number;
  upRate: number;
};

export type TunnelFlow = {
  id: string;
  line: string;
  exit: string;
  downRate: number;
  upRate: number;
};

export type TrafficLine = {
  name: string;
  alive: boolean;
  connections: number;
  downRate: number;
  upRate: number;
};

type Edge = { from: string; to: string; rate: number; connections: number };
type Tone = 'client' | 'route' | 'line' | 'destination';
type DiagramNode = { id: string; label: string; sublabel: string; x: number; y: number; tone: Tone };
type DiagramModel = { nodes: DiagramNode[]; edges: Array<Edge & { fromId: string; toId: string; tone: 'left' | 'right' }>; empty: boolean };

const WIDTH = 1200;
const HEIGHT = 510;
const NODE_WIDTH = 176;
const NODE_HEIGHT = 44;

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

function compact(value: string, length = 23) {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function spread(count: number) {
  if (count <= 1) return [HEIGHT / 2 - NODE_HEIGHT / 2];
  const top = 54;
  const bottom = HEIGHT - NODE_HEIGHT - 28;
  const step = (bottom - top) / (count - 1);
  return Array.from({ length: count }, (_, index) => top + index * step);
}

function bucketMap(totals: Map<string, number>, limit: number, fallback: string) {
  const keep = new Set([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name]) => name));
  return (name: string) => keep.has(name) ? name : fallback;
}

function aggregateTotals(edges: Edge[], side: 'from' | 'to') {
  const totals = new Map<string, number>();
  for (const edge of edges) totals.set(edge[side], (totals.get(edge[side]) ?? 0) + edge.rate);
  return totals;
}

function addEdge(target: Map<string, Edge>, from: string, to: string, rate: number) {
  const key = `${from}\u0000${to}`;
  const edge = target.get(key) ?? { from, to, rate: 0, connections: 0 };
  edge.rate += rate;
  edge.connections += 1;
  target.set(key, edge);
}

function buildBusinessModel(flows: TrafficFlow[]): DiagramModel {
  const active = flows.filter((flow) => flow.client && flow.route && flow.destination);
  if (!active.length) return { nodes: [], edges: [], empty: true };

  const rawClients = new Map<string, number>();
  const rawRoutes = new Map<string, number>();
  const rawDestinations = new Map<string, number>();
  for (const flow of active) {
    const rate = flow.downRate + flow.upRate;
    rawClients.set(flow.client, (rawClients.get(flow.client) ?? 0) + rate);
    rawRoutes.set(flow.route, (rawRoutes.get(flow.route) ?? 0) + rate);
    rawDestinations.set(flow.destination, (rawDestinations.get(flow.destination) ?? 0) + rate);
  }

  const clientBucket = bucketMap(rawClients, 7, '其他客户端');
  const routeBucket = bucketMap(rawRoutes, 5, '其他出口');
  const destinationBucket = bucketMap(rawDestinations, 8, '其他目标地址');
  const left = new Map<string, Edge>();
  const right = new Map<string, Edge>();
  for (const flow of active) {
    const rate = flow.downRate + flow.upRate;
    const client = clientBucket(flow.client);
    const route = routeBucket(flow.route);
    const destination = destinationBucket(flow.destination);
    addEdge(left, client, route, rate);
    addEdge(right, route, destination, rate);
  }

  return makeThreeColumnModel([...left.values()], [...right.values()], 'client', 'route', 'destination');
}

function buildTunnelModel(flows: TunnelFlow[]): DiagramModel {
  const active = flows.filter((flow) => flow.line && flow.exit);
  if (!active.length) return { nodes: [], edges: [], empty: true };

  const rawLines = new Map<string, number>();
  for (const flow of active) rawLines.set(flow.line, (rawLines.get(flow.line) ?? 0) + flow.downRate + flow.upRate);
  const lineBucket = bucketMap(rawLines, 12, '其他中转线路');
  const edges = new Map<string, Edge>();
  for (const flow of active) addEdge(edges, lineBucket(flow.line), flow.exit, flow.downRate + flow.upRate);
  return makeTwoColumnModel([...edges.values()]);
}

function makeThreeColumnModel(left: Edge[], right: Edge[], firstTone: Tone, middleTone: Tone, lastTone: Tone): DiagramModel {
  const firstTotals = aggregateTotals(left, 'from');
  const middleTotals = aggregateTotals(left, 'to');
  const lastTotals = aggregateTotals(right, 'to');
  const first = [...firstTotals].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const middle = [...middleTotals].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const last = [...lastTotals].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const y1 = spread(first.length);
  const y2 = spread(middle.length);
  const y3 = spread(last.length);
  const nodes: DiagramNode[] = [
    ...first.map((name, index) => ({ id: `first:${name}`, label: name, sublabel: formatRate(firstTotals.get(name) ?? 0), x: 24, y: y1[index], tone: firstTone })),
    ...middle.map((name, index) => ({ id: `middle:${name}`, label: name, sublabel: formatRate(middleTotals.get(name) ?? 0), x: 512, y: y2[index], tone: middleTone })),
    ...last.map((name, index) => ({ id: `last:${name}`, label: name, sublabel: formatRate(lastTotals.get(name) ?? 0), x: 1000, y: y3[index], tone: lastTone })),
  ];
  return {
    nodes,
    edges: [
      ...left.map((edge) => ({ ...edge, fromId: `first:${edge.from}`, toId: `middle:${edge.to}`, tone: 'left' as const })),
      ...right.map((edge) => ({ ...edge, fromId: `middle:${edge.from}`, toId: `last:${edge.to}`, tone: 'right' as const })),
    ],
    empty: false,
  };
}

function makeTwoColumnModel(edges: Edge[]): DiagramModel {
  const lineTotals = aggregateTotals(edges, 'from');
  const exitTotals = aggregateTotals(edges, 'to');
  const lineNames = [...lineTotals].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const exitNames = [...exitTotals].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const lineY = spread(lineNames.length);
  const exitY = spread(exitNames.length);
  return {
    nodes: [
      ...lineNames.map((name, index) => ({ id: `line:${name}`, label: name, sublabel: formatRate(lineTotals.get(name) ?? 0), x: 205, y: lineY[index], tone: 'line' as const })),
      ...exitNames.map((name, index) => ({ id: `exit:${name}`, label: name, sublabel: formatRate(exitTotals.get(name) ?? 0), x: 819, y: exitY[index], tone: 'destination' as const })),
    ],
    edges: edges.map((edge) => ({ ...edge, fromId: `line:${edge.from}`, toId: `exit:${edge.to}`, tone: 'right' as const })),
    empty: false,
  };
}

function nodeColors(tone: Tone) {
  if (tone === 'client') return { fill: '#112536', stroke: '#38bdf84d', accent: '#7dd3fc' };
  if (tone === 'route') return { fill: '#102a2d', stroke: '#2dd4bf66', accent: '#5eead4' };
  if (tone === 'line') return { fill: '#102a2d', stroke: '#2dd4bf66', accent: '#5eead4' };
  return { fill: '#221c38', stroke: '#a78bfa55', accent: '#c4b5fd' };
}

function DiagramNodeView({ node }: { node: DiagramNode }) {
  const colors = nodeColors(node.tone);
  return (
    <g>
      <rect x={node.x} y={node.y} width={NODE_WIDTH} height={NODE_HEIGHT} rx="11" fill={colors.fill} stroke={colors.stroke} />
      <circle cx={node.x + 14} cy={node.y + 14} r="3.5" fill={colors.accent} />
      <text x={node.x + 24} y={node.y + 18} fill="#e2e8f0" fontSize="12" fontWeight="600">{compact(node.label)}</text>
      <text x={node.x + 14} y={node.y + 34} fill="#64748b" fontSize="10.5">{node.sublabel}</text>
      <title>{node.label} · {node.sublabel}</title>
    </g>
  );
}

function FlowDiagram({ model, labels, title, emptyText }: { model: DiagramModel; labels: string[]; title: string; emptyText: string }) {
  if (model.empty) {
    return <div className="grid min-h-72 place-items-center px-4 text-center"><div><Route className="mx-auto size-9 text-slate-700" /><p className="mt-4 text-sm font-medium text-slate-300">等待活动连接</p><p className="mt-2 text-sm text-slate-500">{emptyText}</p></div></div>;
  }
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const maxRate = Math.max(...model.edges.map((edge) => edge.rate), 1);
  const labelX = labels.length === 2 ? [205, 819] : [24, 512, 1000];
  const indexedEdges = model.edges.map((edge, index) => ({ edge, index }));
  const renderedEdges = [...indexedEdges].sort((a, b) => b.edge.rate - a.edge.rate);
  const portY = (edgeIndex: number, side: 'from' | 'to') => {
    const edge = model.edges[edgeIndex];
    const nodeId = side === 'from' ? edge.fromId : edge.toId;
    const siblings = indexedEdges
      .filter((item) => (side === 'from' ? item.edge.fromId : item.edge.toId) === nodeId)
      .sort((a, b) => {
        const aNode = byId.get(side === 'from' ? a.edge.toId : a.edge.fromId);
        const bNode = byId.get(side === 'from' ? b.edge.toId : b.edge.fromId);
        return (aNode?.y ?? 0) - (bNode?.y ?? 0);
      });
    if (siblings.length <= 1) return NODE_HEIGHT / 2;
    const position = siblings.findIndex((item) => item.index === edgeIndex);
    return 7 + (NODE_HEIGHT - 14) * position / (siblings.length - 1);
  };
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full min-w-[980px]" aria-label={title}>
        <defs>
          <linearGradient id={`${title}-left`} x1="0" x2="1"><stop stopColor="#38bdf8" /><stop offset="1" stopColor="#2dd4bf" /></linearGradient>
          <linearGradient id={`${title}-right`} x1="0" x2="1"><stop stopColor="#2dd4bf" /><stop offset="1" stopColor="#a78bfa" /></linearGradient>
          <filter id={`${title}-glow`} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        {labels.map((label, index) => <text key={label} x={labelX[index]} y="28" fill="#64748b" fontSize="11" fontWeight="600" letterSpacing="1.4">{label}</text>)}
        {renderedEdges.map(({ edge, index }) => {
          const from = byId.get(edge.fromId);
          const to = byId.get(edge.toId);
          if (!from || !to) return null;
          const x1 = from.x + NODE_WIDTH;
          const x2 = to.x;
          const y1 = from.y + portY(index, 'from');
          const y2 = to.y + portY(index, 'to');
          const curve = (x2 - x1) * 0.48;
          const width = Math.max(1.4, 2 + Math.sqrt(edge.rate / maxRate) * 15);
          return <path key={`${edge.fromId}-${edge.toId}-${index}`} d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`} fill="none" stroke={`url(#${title}-${edge.tone})`} strokeWidth={width} strokeLinecap="round" opacity={edge.rate > 0 ? 0.52 : 0.16} strokeDasharray={edge.rate > 0 ? undefined : '5 6'} filter={edge.rate > 0 ? `url(#${title}-glow)` : undefined}><title>{`${from.label} → ${to.label} · ${formatRate(edge.rate)} · ${edge.connections} 条连接`}</title></path>;
        })}
        {model.nodes.map((node) => <DiagramNodeView key={node.id} node={node} />)}
      </svg>
    </div>
  );
}

export function TrafficFlowMap({ flows, tunnelFlows, lines }: { flows: TrafficFlow[]; tunnelFlows: TunnelFlow[]; lines: TrafficLine[] }) {
  const businessModel = useMemo(() => buildBusinessModel(flows), [flows]);
  const tunnelModel = useMemo(() => buildTunnelModel(tunnelFlows), [tunnelFlows]);
  const active = lines.filter((line) => line.connections > 0);
  const idle = lines.filter((line) => line.alive && line.connections === 0);
  const failed = lines.filter((line) => !line.alive);

  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-white/8 bg-[#0a151f] shadow-[0_22px_70px_rgba(0,0,0,.22)]" aria-labelledby="traffic-flow-title">
      <div className="flex flex-col gap-3 border-b border-white/8 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 id="traffic-flow-title" className="font-medium text-slate-100">实时网络通路</h2><p className="mt-1 text-xs text-slate-500">业务访问与底层隧道分开统计，避免把出口 VM 误认为访问目标。</p></div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400"><span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-6 rounded bg-cyan-300" />线宽 = 实时速度</span><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-400" />正常</span><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-rose-400" />故障</span></div>
      </div>

      <Tabs defaultValue="business" className="gap-0">
        <div className="border-b border-white/8 px-4 py-2">
          <TabsList className="bg-white/5">
            <TabsTrigger value="business" className="gap-2 px-3 text-slate-400 data-active:text-cyan-200"><Route className="size-3.5" />客户端访问</TabsTrigger>
            <TabsTrigger value="tunnel" className="gap-2 px-3 text-slate-400 data-active:text-cyan-200"><Network className="size-3.5" />中转承载</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="business">
          <FlowDiagram model={businessModel} labels={['本地客户端', '逻辑出口', '真实目标地址']} title="business-flow" emptyText="产生业务流量后，这里会显示客户端、逻辑出口和真实目标地址。" />
        </TabsContent>
        <TabsContent value="tunnel">
          <FlowDiagram model={tunnelModel} labels={['机场中转线路', '出口 VM']} title="tunnel-flow" emptyText="隧道开始承载流量后，这里会显示每条机场线路对应的出口 VM。" />
        </TabsContent>
      </Tabs>

      <div className="grid gap-px border-t border-white/8 bg-white/8 sm:grid-cols-3">
        <div className="bg-[#0b1721] px-4 py-3"><div className="flex items-center gap-2 text-sm text-cyan-200"><Activity className="size-4" />工作中 <strong className="font-mono text-white">{active.length}</strong></div><p className="mt-1 truncate text-xs text-slate-500" title={active.map((line) => line.name).join('、')}>{active.length ? active.map((line) => line.name).join('、') : '暂无传输线路'}</p></div>
        <div className="bg-[#0b1721] px-4 py-3"><div className="flex items-center gap-2 text-sm text-emerald-300"><Wifi className="size-4" />健康空闲 <strong className="font-mono text-white">{idle.length}</strong></div><p className="mt-1 text-xs text-slate-500">探测正常，当前没有承载连接</p></div>
        <div className="bg-[#0b1721] px-4 py-3"><div className="flex items-center gap-2 text-sm text-rose-300"><CircleOff className="size-4" />探测故障 <strong className="font-mono text-white">{failed.length}</strong></div><p className="mt-1 truncate text-xs text-slate-500" title={failed.map((line) => line.name).join('、')}>{failed.length ? failed.map((line) => line.name).join('、') : '没有故障线路'}</p></div>
      </div>
    </section>
  );
}
