#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const clientRoot = join(projectRoot, 'dist', 'client');
const packageVersion = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version;
const outputRoot = join(projectRoot, 'dist-openclash');
const packageName = `luci-app-proxy-view_${packageVersion}-1_all.ipk`;
const sourceRoot = join(projectRoot, 'openwrt', 'luci-app-proxy-view');
const textExtensions = new Set(['.html', '.js', '.json', '.rsc', '.txt', '.xml']);
const tarOwnerArgs = process.platform === 'darwin'
  ? ['--uid', '0', '--gid', '0']
  : ['--owner=0', '--group=0', '--numeric-owner'];
const tarFormatArgs = process.platform === 'darwin'
  ? ['--format=gnutar']
  : ['--format=gnu'];

if (!existsSync(join(clientRoot, 'index.html'))) {
  console.error('没有找到前端构建产物。请先运行：npm run build');
  process.exit(1);
}

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(outputRoot, { recursive: true });
const workRoot = mkdtempSync(join(tmpdir(), 'proxy-view-ipk-'));
const dataRoot = join(workRoot, 'data');
const controlRoot = join(workRoot, 'control');
const dashboardRoot = join(dataRoot, 'usr', 'share', 'openclash', 'ui', 'proxy-view');
const controllerRoot = join(dataRoot, 'usr', 'lib', 'lua', 'luci', 'controller');
const viewRoot = join(dataRoot, 'usr', 'lib', 'lua', 'luci', 'view', 'proxy_view');
const guardRoot = join(dataRoot, 'usr', 'share', 'proxy-view');
const nginxRoot = join(dataRoot, 'etc', 'nginx', 'gl-conf.d');

function visitFiles(directory, callback) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) visitFiles(path, callback);
    else callback(path);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败：${result.stderr || result.stdout}`);
  }
}

try {
  mkdirSync(dashboardRoot, { recursive: true });
  cpSync(clientRoot, dashboardRoot, { recursive: true });
  visitFiles(dashboardRoot, (path) => {
    if (!textExtensions.has(extname(path))) return;
    const content = readFileSync(path, 'utf8');
    const rewritten = content.replaceAll('/_next/', '/ui/proxy-view/_next/');
    if (rewritten !== content) writeFileSync(path, rewritten);
  });

  mkdirSync(controllerRoot, { recursive: true });
  mkdirSync(viewRoot, { recursive: true });
  cpSync(join(sourceRoot, 'controller', 'proxy_view.lua'), join(controllerRoot, 'proxy_view.lua'));
  cpSync(join(sourceRoot, 'view', 'redirect.htm'), join(viewRoot, 'redirect.htm'));
  cpSync(join(sourceRoot, 'view', 'guard_status.htm'), join(viewRoot, 'guard_status.htm'));
  mkdirSync(guardRoot, { recursive: true });
  mkdirSync(join(dataRoot, 'etc', 'init.d'), { recursive: true });
  mkdirSync(join(dataRoot, 'etc', 'config'), { recursive: true });
  cpSync(join(sourceRoot, 'guard', 'guard.rb'), join(guardRoot, 'guard.rb'));
  cpSync(join(sourceRoot, 'guard', 'proxy-view-guard.init'), join(dataRoot, 'etc', 'init.d', 'proxy-view-guard'));
  chmodSync(join(dataRoot, 'etc', 'init.d', 'proxy-view-guard'), 0o755);
  cpSync(join(sourceRoot, 'guard', 'proxy_view_guard.config'), join(dataRoot, 'etc', 'config', 'proxy_view_guard'));
  mkdirSync(nginxRoot, { recursive: true });
  cpSync(join(sourceRoot, 'nginx', 'proxy-view-luci-ubus.conf'), join(nginxRoot, 'proxy-view-luci-ubus.conf'));

  mkdirSync(controlRoot, { recursive: true });
  const installedSize = Math.ceil(
    [...readdirSync(dataRoot)].reduce((sum, name) => {
      const path = join(dataRoot, name);
      if (!statSync(path).isDirectory()) return sum + statSync(path).size;
      let size = 0;
      visitFiles(path, (file) => { size += statSync(file).size; });
      return sum + size;
    }, 0) / 1024,
  );
  writeFileSync(join(controlRoot, 'control'), `Package: luci-app-proxy-view
Version: ${packageVersion}-1
Architecture: all
Maintainer: aether
Depends: luci-base, luci-app-openclash, ruby, ruby-yaml, curl
Section: luci
Priority: optional
Installed-Size: ${installedSize}
Description: Mihomo dashboard with conservative native load-balancer connection cleanup.
`);
  writeFileSync(join(controlRoot, 'conffiles'), '/etc/config/proxy_view_guard\n');
  writeFileSync(join(controlRoot, 'postinst'), `#!/bin/sh
if [ -z "$IPKG_INSTROOT" ]; then
  # A browser can cache FileServer's directory listing while opkg replaces
  # the dashboard. Use install time rather than build time for revalidation.
  if [ -f /usr/share/openclash/ui/proxy-view/index.html ]; then
    touch /usr/share/openclash/ui/proxy-view/index.html
  fi
  # Keep upgrades self-contained. Old releases stored node-selection settings
  # which are no longer used by the native load-balancer monitor.
  if ! uci -q get proxy_view_guard.main >/dev/null 2>&1; then
    uci set proxy_view_guard.main='global'
    uci set proxy_view_guard.main.enabled='0'
  fi
  for section in $(uci show proxy_view_guard 2>/dev/null | sed -n 's/^proxy_view_guard\\.\\([^.=]*\\)=exit$/\\1/p'); do
    uci -q delete proxy_view_guard.$section.slow_ms >/dev/null 2>&1 || true
    uci -q delete proxy_view_guard.$section.candidate_timeout_ms >/dev/null 2>&1 || true
    uci -q delete proxy_view_guard.$section.switch_cooldown >/dev/null 2>&1 || true
    uci -q delete proxy_view_guard.$section.candidates >/dev/null 2>&1 || true
    uci -q delete proxy_view_guard.$section.excluded >/dev/null 2>&1 || true
  done
  uci commit proxy_view_guard

  # GL.iNet places nginx in front of uhttpd but does not expose uhttpd's
  # /ubus/ handler. The packaged server snippet restores that standard path.
  if command -v nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1; then
    uci set luci.main.ubuspath='/ubus/'
    uci commit luci
    nginx -s reload
  fi
  rm -f /tmp/luci-indexcache /tmp/luci-indexcache.*
  rm -rf /tmp/luci-modulecache
  /etc/init.d/proxy-view-guard enable
  /etc/init.d/proxy-view-guard restart
fi
exit 0
`, { mode: 0o755 });
  writeFileSync(join(controlRoot, 'prerm'), `#!/bin/sh
if [ -z "$IPKG_INSTROOT" ]; then
  /etc/init.d/proxy-view-guard stop
  /etc/init.d/proxy-view-guard disable
fi
exit 0
`, { mode: 0o755 });
  writeFileSync(join(controlRoot, 'postrm'), `#!/bin/sh
[ -n "$IPKG_INSTROOT" ] || rm -f /tmp/luci-indexcache
[ -n "$IPKG_INSTROOT" ] || rm -f /tmp/luci-indexcache.*
[ -n "$IPKG_INSTROOT" ] || rm -rf /tmp/luci-modulecache
exit 0
`, { mode: 0o755 });
  writeFileSync(join(workRoot, 'debian-binary'), '2.0\n');

  run('tar', [...tarOwnerArgs, ...tarFormatArgs, '-czf', join(workRoot, 'control.tar.gz'), '-C', controlRoot, '.'], projectRoot);
  run('tar', [...tarOwnerArgs, ...tarFormatArgs, '-czf', join(workRoot, 'data.tar.gz'), '-C', dataRoot, '.'], projectRoot);
  const outputPath = join(outputRoot, packageName);
  // OpenWrt 21.02's official ipkg-build uses an outer GNU tar.gz container in
  // this exact order. Some older opkg builds reject the Debian-style ar variant.
  run('tar', [
    ...tarOwnerArgs,
    ...tarFormatArgs,
    '-czf',
    outputPath,
    '-C',
    workRoot,
    'debian-binary',
    'data.tar.gz',
    'control.tar.gz',
  ], projectRoot);

  console.log(`OpenClash Dashboard 软件包已生成：${outputPath}`);
  console.log('安装命令：opkg install /tmp/' + basename(outputPath));
} finally {
  rmSync(workRoot, { force: true, recursive: true });
}
