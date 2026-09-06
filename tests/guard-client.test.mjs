import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('router client authenticates, encodes provider names and limits deletes to explicit IDs', async () => {
  const secret = 'fixture-"\\-secret';
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    requests.push({ method: req.method, path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'DELETE' || req.method === 'PUT') {
      res.writeHead(204); res.end(); return;
    }
    if (req.url.includes('healthcheck') || req.url.includes('/delay')) {
      res.end('{"delay":85}'); return;
    }
    if (req.url === '/connections') {
      res.end('{"connections":[]}'); return;
    }
    res.end(JSON.stringify({ now: '香港 / A', all: ['香港 / A'] }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const directory = await mkdtemp(join(tmpdir(), 'proxy-view-guard-test-'));
  try {
    const config = join(directory, 'config.yaml');
    // JSON is a YAML subset; no runtime ruby-json dependency is needed.
    await writeFile(config, JSON.stringify({ secret }), { mode: 0o600 });
    const code = `require ARGV.shift
c=ProxyViewGuard::Client.new(ARGV.shift,ARGV.shift)
c.line_delays('机场 / provider','香港 / A',500)
c.exit_delays('⚡ 台湾出口｜多线加速',1500)
c.connections
c.close('one-id')
puts 'client-ok'
`;
    const output = await new Promise((done, reject) => {
      const child = spawn('ruby', ['-e', code, resolve('openwrt/luci-app-proxy-view/guard/guard.rb'), config, `http://127.0.0.1:${server.address().port}`]);
      let text = '';
      child.stdout.on('data', (data) => { text += data; });
      child.stderr.on('data', (data) => { text += data; });
      child.on('error', reject);
      child.on('close', (status) => status === 0 ? done(text) : reject(new Error(text)));
    });
    assert.equal(output.trim(), 'client-ok');
    assert.equal(requests.filter((r) => r.method === 'PUT').length, 0);
    assert.equal(requests.filter((r) => r.method === 'DELETE').length, 1);
    assert.equal(requests.find((r) => r.method === 'DELETE').path, '/connections/one-id');
    const health = requests.find((r) => r.path.includes(encodeURIComponent('香港 / A')) && r.path.includes('/healthcheck'));
    assert.ok(health);
    assert.ok(health.path.includes(encodeURIComponent('机场 / provider')));
    assert.equal(new URL(health.path, 'http://test').searchParams.get('url'), 'https://cp.cloudflare.com/generate_204');
  } finally {
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});
