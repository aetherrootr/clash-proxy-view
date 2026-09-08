import type { MihomoProxy } from './mihomo';

export function isExitName(name: string) {
  return /^exit-node(?:$|[-(])/.test(name);
}

export function exitIn(chains: string[], proxies: MihomoProxy[]) {
  // The recorded leaf is authoritative, including connections from before a switch.
  const leaf = chains.find((name) => name.startsWith('exit-node-'));
  if (leaf) return leaf;
  const alias = chains.find(isExitName);
  const tunnel = chains.map((name) => /^➡️ 代理隧道\(([^)]+)\)$/.exec(name)).find(Boolean);
  let current = alias || (tunnel ? `exit-node(${tunnel[1]})` : undefined);
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current.startsWith('exit-node-')) return current;
    const next = proxies.find((proxy) => proxy.name === current)?.now;
    if (!next) return current;
    current = next;
  }
  return alias;
}
