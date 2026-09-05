#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  cpSync,
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

  mkdirSync(controlRoot, { recursive: true });
  const installedSize = Math.ceil(
    [...readdirSync(dashboardRoot)].reduce((sum, name) => {
      const path = join(dashboardRoot, name);
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
Depends: luci-base, luci-app-openclash
Section: luci
Priority: optional
Installed-Size: ${installedSize}
Description: LuCI launcher and embedded Mihomo dashboard for proxy-view.
`);
  writeFileSync(join(controlRoot, 'postinst'), `#!/bin/sh
[ -n "$IPKG_INSTROOT" ] || rm -f /tmp/luci-indexcache
exit 0
`, { mode: 0o755 });
  writeFileSync(join(controlRoot, 'postrm'), `#!/bin/sh
[ -n "$IPKG_INSTROOT" ] || rm -f /tmp/luci-indexcache
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
