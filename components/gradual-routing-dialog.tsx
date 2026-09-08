'use client';

import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function GradualRoutingDialog({ open, endpoint, onClose }: {
  open: boolean;
  endpoint: string;
  onClose: () => void;
}) {
  let settingsUrl = '';
  try {
    const url = new URL(endpoint);
    if (['http:', 'https:'].includes(url.protocol)) {
      url.port = '';
      url.username = '';
      url.password = '';
      url.pathname = '/cgi-bin/luci/admin/services/proxy-view/guard';
      url.search = '';
      url.hash = '';
      settingsUrl = url.toString();
    }
  } catch { /* The connection settings report invalid controller addresses. */ }

  return <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
    <DialogContent className="border-white/10 bg-[#0c1823] text-slate-100">
      <DialogHeader>
        <div className="mb-2 grid size-10 place-items-center rounded-xl bg-cyan-400/10 text-cyan-300"><ShieldCheck /></div>
        <DialogTitle>全部逻辑出口 · 管理换线</DialogTitle>
        <DialogDescription className="text-slate-400">自动巡检根据 Provider 健康状态清理失效且持续空闲的旧连接。只要还有字节增长，自动处理就继续保护。</DialogDescription>
      </DialogHeader>
      <ol className="space-y-3 text-sm text-slate-300">
        <li><span className="mr-2 text-cyan-300">01</span>复用 Provider 的健康状态，连续失败达到设置轮数后才考虑退出。</li>
        <li><span className="mr-2 text-cyan-300">02</span>旧隧道连续至少 120 秒无字节增长，才进入待退出状态。</li>
        <li><span className="mr-2 text-cyan-300">03</span>每个退出间隔最多断开一条，间隔允许 10–3600 秒（默认 60 秒）；新连接由 Clash 原生多线组选择。</li>
      </ol>
      <div className="rounded-xl border border-white/8 bg-white/[.025] p-3 text-xs leading-relaxed text-slate-400">
        <p>在路由器管理页启用并查看保护中、等待退出和已退出的进度。关闭本页面后，路由器服务仍可继续运行；首次安装默认关闭。</p>
        <p className="mt-2">暂停中的长连接仍可能重连。新请求可能暂时复用旧隧道，迁移时间取决于实际流量；小请求探测也不能代替下载测速。</p>
      </div>
      <p className="text-xs text-slate-500">管理页列出全部逻辑出口，可修改巡检参数，也可经二次确认立即踢掉所选出口全部多线中转连接（包括正在传输的连接）。LuCI 使用非标准端口时，请从路由器菜单进入“多线代理控制台 → 渐进换线”。</p>
      <DialogFooter>
        <Button variant="outline" className="border-white/10 bg-white/4" onClick={onClose}>关闭</Button>
        {settingsUrl && <a href={settingsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center justify-center gap-2 rounded-lg bg-cyan-300 px-3 text-sm font-medium text-slate-950 hover:bg-cyan-200">打开路由器换线管理<ArrowUpRight className="size-4" /></a>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
