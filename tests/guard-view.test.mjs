import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// Exercise the actual LuCI renderers without network calls or live router actions.
const view = readFileSync(new URL('../openwrt/luci-app-proxy-view/view/guard_status.htm', import.meta.url), 'utf8');
const renderers = view.slice(view.indexOf('  function renderTelemetry('), view.indexOf('  function render(data)'));
const now = 1794415000000;
class Element {
  constructor(tag, cls, text) { this.tag = tag; this.className = cls; this.text = text ?? ''; this.children = []; this.attributes = {}; this.style = {}; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(' '); }
  set textContent(value) { this.text = value; this.children = []; }
}
function all(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap((child) => all(child, predicate))];
}
function fixture() {
  return {
    id: 'jp', endpoint: 'jp.example.test', enabled: true, attached: true, phase: 'monitoring', settings: {},
    health_summary: { assessed_at: now / 1000, max_age_seconds: 900, candidate_count: 3, healthy: 2, failed: 1, unknown: 0 },
    recommendations: [
      { name: 'slow', kind: 'high_latency', recommendation: 'consider_isolation', rounds: 3, required_rounds: 3, alternative_count: 1, sampled_at: now / 1000, samples: [] },
      { name: 'unused', kind: 'unreachable', recommendation: 'watch', rounds: 1, required_rounds: 3, alternative_count: 1, sampled_at: now / 1000, samples: [] },
    ],
    tunnels: [
      { id: 'fast-id', line: 'fast', health_state: 'healthy', protection_reason: 'transferring', protected: true },
      { id: 'slow-id', line: 'slow', health_state: 'healthy', protection_reason: 'transferring', protected: true },
    ],
  };
}
function renderer() {
  const posts = [];
  const context = vm.createContext({
    node: (tag, cls, text) => new Element(tag, cls, text), bytes: (value) => `${value ?? 0} B`,
    Date: class extends Date { static now() { return now; } },
    last: { running: true, enabled: true }, saving: false, requests: [], closedIds: {}, openEvidence: {},
    confirm: () => true, post: (payload) => posts.push(payload),
    document: { getElementById: () => new Element('div') },
  });
  vm.runInContext(renderers, context);
  return { context, posts };
}

test('each connection row contains its own advice next to the correct manual action', () => {
  const { context, posts } = renderer();
  const root = context.renderTelemetry(fixture());
  const table = all(root, (element) => element.className?.includes('pv-connections'))[0];
  assert.equal(table.children[0].children.map((cell) => cell.textContent).join('|'),
    '机场线路|线路探测|累计流量|估算速度 / 采样增量|空闲 / 保护|建议|手动管理');
  const fastRow = table.children[1];
  const slowRow = table.children[2];
  assert.ok(fastRow.children[5].textContent.includes('暂无隔离建议'));
  assert.ok(slowRow.children[5].textContent.includes('建议评估隔离'));
  assert.ok(slowRow.children[4].textContent.includes('正在传输，受保护'));
  assert.equal(slowRow.className, 'pv-advice-row');
  slowRow.children[6].children[0].onclick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].connection, 'slow-id');
  assert.equal(posts[0].operation, 'kick');
});

test('inactive candidate advice is retained separately and expanded evidence survives refresh', () => {
  const { context } = renderer();
  const root = context.renderTelemetry(fixture());
  const extra = all(root, (element) => element.tag === 'details' && element.children[0]?.textContent.includes('其他候选线路建议'))[0];
  assert.ok(extra.textContent.includes('unused'));
  assert.ok(!extra.textContent.includes('slow'));
  const detail = all(root, (element) => element.tag === 'details' && element.children[0]?.textContent === '查看依据')[0];
  detail.open = true;
  detail.ontoggle();
  const refreshed = context.renderTelemetry(fixture());
  assert.equal(all(refreshed, (element) => element.tag === 'details' && element.children[0]?.textContent === '查看依据')[0].open, true);
});

test('unknown, stale and disabled assessments do not display an actionable recommendation', () => {
  const { context } = renderer();
  const item = fixture();
  assert.ok(context.renderAdviceCell(item, 'unknown', 'unknown').textContent.includes('证据不足'));
  item.recommendations[0].sampled_at -= 901;
  const stale = context.renderAdviceCell(item, 'slow', 'healthy');
  assert.ok(stale.textContent.includes('证据已过期'));
  assert.ok(!stale.textContent.includes('建议评估隔离'));
  context.last.enabled = false;
  assert.ok(context.renderAdviceCell(item, 'slow', 'healthy').textContent.includes('等待有效评估'));
});
