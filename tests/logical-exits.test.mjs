import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exitIn, isExitName } from '../lib/logical-exits.ts';

test('recorded exit leaf and selector aliases share the original node name', () => {
  const proxies = [
    { name: 'exit-node', now: 'exit-node(jp)' },
    { name: 'exit-node(jp)', now: 'exit-node-jp' },
    { name: 'exit-node(tw)', now: 'exit-node-tw' },
  ];
  assert.equal(exitIn(['exit-node-jp', 'exit-node(jp)', 'exit-node'], proxies), 'exit-node-jp');
  assert.equal(exitIn(['exit-node-jp'], proxies), 'exit-node-jp');
  assert.equal(exitIn(['exit-node(jp)'], proxies), 'exit-node-jp');
  assert.equal(exitIn(['➡️ 代理隧道(tw)'], proxies), 'exit-node-tw');
  assert.equal(exitIn(['exit-node-tw', 'exit-node'], proxies), 'exit-node-tw');
  assert.equal(exitIn(['DIRECT'], proxies), undefined);
  assert.deepEqual(['exit-node', 'exit-node(jp)', 'exit-node-jp', 'exit-node-sg', '其他节点'].filter(isExitName),
    ['exit-node', 'exit-node(jp)', 'exit-node-jp', 'exit-node-sg']);
});
