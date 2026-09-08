# 多线代理控制台

一个本地命令行 Dashboard。启动命令会在 `127.0.0.1` 提供前端页面和受限的 Mihomo API 中转，然后自动在默认浏览器中打开控制台。运行时不依赖任何云端服务，也不要求路由器提供 HTTPS 或 CORS。

## 快速开始

首次安装依赖并启动：

```bash
npm ci
npm run dashboard
```

`dashboard` 会先构建前端，再启动本地服务并打开：

```text
http://127.0.0.1:9876
```

在页面设置中填写控制器地址和 `secret`，默认地址是 `http://192.168.8.1:9090`。

以后前端没有变化时可以直接运行：

```bash
npm start
```

## 安装为本机命令

在项目目录运行一次：

```bash
npm run build
npm link
```

之后可以在任意目录启动：

```bash
proxy-view
```

可用参数：

```text
proxy-view --port 9877   使用其他端口
proxy-view --no-open     不自动打开浏览器
proxy-view --help        查看帮助
```

卸载命令链接：

```bash
npm unlink --global proxy-view
```

## 安装为 OpenClash Dashboard

生成包含前端和 LuCI 菜单入口的通用架构 IPK：

```bash
npm run build:openclash
```

产物位于 `dist-openclash/luci-app-proxy-view_<版本>-1_all.ipk`。上传到路由器的
`/tmp` 后只需安装这个 IPK：

```bash
opkg install /tmp/luci-app-proxy-view_0.4.0-1_all.ipk
```

IPK 会通过 `Depends` 安装 LuCI、OpenClash、Ruby、ruby-yaml 与 curl 依赖，安装
Dashboard 静态文件、LuCI 页面、守护进程、UCI 默认配置和 GL.iNet nginx 的 ubus
补丁，并完成旧配置迁移、LuCI 缓存清理、服务开机启用和立即启动。已存在的
`/etc/config/proxy_view_guard` 会作为 conffile 保留。OpenClash 本身需要能够从当前
软件源安装，且运行配置使用 9090 控制端口。

安装后，LuCI 的“服务 → 多线代理控制台”会跳转到：

```text
http://<当前路由器地址>:9090/ui/proxy-view/
```

嵌入模式直接访问同源 Mihomo API，不依赖本机命令行中转。首次使用仍需在页面中
填写控制器 `secret`。从已登录的 LuCI“多线代理控制台”入口打开时，插件会读取
当前 OpenClash 配置中的密钥，通过不会发送到服务器的 URL fragment 一次性交给
Dashboard，并立即从地址栏清除；直接访问 9090 时仍可手工填写。卸载命令：

```bash
opkg remove luci-app-proxy-view
```

该软件包不会修改 OpenClash 源码；OpenClash 必须已经安装，并使用 9090 作为外部
控制端口。

### 渐进换线

控制台的“渐进换线”入口打开 LuCI 管理页，也可从“服务 → 多线代理控制台 →
渐进换线”进入。新版 IPK 包含 `proxy-view-guard` 常驻服务，依赖 Ruby、ruby-yaml
和 curl。守护进程会动态发现完整的 `exit-node(<逻辑名>)`、
`➡️ 代理隧道(<逻辑名>)` 与订阅原有的 `⚡ …出口｜多线加速`，不会向 OpenClash
配置注入代理组，也不会指定或改选机场节点。每个逻辑出口有独立的运行方式及检查
参数。关闭浏览器不会停止路由器服务。管理页使用现有 LuCI 登录，不新增监听端口
或公开状态文件。

守护进程递归检查代理隧道当前的组选择链。如果某个代理隧道不再经过其原生多线组，
该逻辑出口立即跳过处理，并把 UCI 中的处理方式持久化回“只观察”。重新经过多线组
后仍保持只观察，必须由用户再次保存为自动处理。其他逻辑出口不受影响。

管理页可以立即评估、启停单个出口、修改空闲保护时间/检查间隔/失败轮数/逐条
退出间隔，并支持按出口二次确认后立即踢掉全部隧道连接。守护进程复用 Clash Provider
维护的节点 `alive` 状态与最近延迟历史，不额外发起逐节点探测。
LuCI 表格每行提供“踢掉此连接”，二次确认后按 ID 立即关闭该行连接，包括正在传输
的连接；不会禁用节点或关闭同名节点的其他连接。Dashboard 保持无断开操作。

旧连接按照下面的条件逐步处理：

- 后台目标每 2 秒观察外层隧道的上传、下载计数。即使只增长一个字节，也重新计时并保留。
- 连续至少 120 秒没有字节增长才可能退出；采样间隔超过 20 秒、计数重置或 API
  出错会重置观察，不能把监测中断当成空闲。可将等待时间加长到 3600 秒。
- 关闭前重新读取连接，确认标识、启动时间及字节计数都未变化。自动处理每次只
  按连接 ID 关闭一条，间隔允许 10–3600 秒（默认 60 秒），绝不调用全局关闭接口。
- 同一机场线路需要连续多轮完全探测失败，且连接持续空闲，才进入逐条断开流程。
  每个间隔最多关闭一条；新的业务连接由 Clash 原生负载均衡组自行补建和选择。
- 停止服务会取消后续自动操作。守护进程不恢复连接，也不改变任何代理组选择。

原“重建中转”批量操作已从出口卡片移除。控制台会根据当前策略组动态展示全部
逻辑出口，并进入同一个 LuCI 管理页面。

Mihomo 没有给单个 MUX 会话设置“停止接收新请求”的管理接口，也不提供原子的
“仍然空闲才关闭”操作。因此这是保守的逐条断开，不保证所有长连接无感迁移：
暂停中的会话仍可能重连，新请求可能继续复用旧 MUX。持续传输的旧隧道不会
被自动处理强制清空，清理也可能长期等待。手动“立即踢掉全部连接”不受这些保护条件限制，
只关闭执行时匹配所选出口服务器和原生多线组的 TCP 中转连接，不阻止后续重连。
手动关闭最多并发 16 个按 ID 请求，完成后立即读取连接核对并显示已断开和剩余数量；
新连接不计入本次结果。自动巡检目标每 2 秒采样，实际退出时间可能稍晚于设定间隔。
LuCI 页面每 2 秒轮询（隐藏页面暂停轮询），编辑参数时表格仍会更新。表格显示相邻
有效采样的上传/下载速度、实际采样时长和字节增量；首次采样、计数重置或采样中断
不显示推断速度，样本超过 6 秒未更新会标记延迟并隐藏速度。Provider 健康数据仍按
出口配置的检查间隔读取，不额外增加主动探测。
Provider 健康状态只能判断可达性，不能证明下载
带宽更高；空闲或低流量本身不会把线路判为失效。

配置在 `/etc/config/proxy_view_guard`，受 LuCI 登录保护的运行状态在
`/var/run/proxy-view-guard/status.json`（目录仅 root 可访问）。API 密钥读取现有
OpenClash 运行配置，通过 curl 标准输入传递，不写入额外文件或日志。软件包升级
保留 UCI 配置；暂停或停止状态、计时和观察窗口不跨进程重启保存。

手工停用自动巡检（服务仍保留只读发现状态，方便从页面重新配置）：

```sh
uci set proxy_view_guard.main.enabled='0'
uci commit proxy_view_guard
/etc/init.d/proxy-view-guard restart
```

通过 CLI 修改设置后需手工重启服务；通过 LuCI 保存会自动重启。新发现的出口
默认不参与处理，建议先使用“只观察”，核对出口、线路探测和连接范围后再选择
自动模式。

### GitHub Release 自动构建

发布前同时更新 `package.json` 和 `package-lock.json` 中的版本号，然后推送对应的
`v<版本>` 标签：

```bash
npm version 0.1.1
git push origin main --follow-tags
```

GitHub Actions 会执行源码检查、构建并验证 IPK，随后创建 GitHub Release，上传
`.ipk` 和 `SHA256SUMS`。标签必须与 `package.json` 版本严格对应，例如版本
`0.1.1` 必须使用标签 `v0.1.1`；不匹配时工作流会停止，避免发布错误版本。

## Clash/Mihomo 配置

控制器只需监听局域网并设置强密钥：

```yaml
external-controller: 0.0.0.0:9090
secret: "使用强随机密钥"
```

浏览器只访问本机 `127.0.0.1`，由命令行进程访问路由器，所以不需要 `external-controller-cors`。不要把控制器端口直接暴露到公网。

## 安全边界

- 服务固定绑定 `127.0.0.1`，局域网内其他设备不能访问。
- 控制器必须是 `localhost`、IPv4 私网/链路本地地址或 IPv6 本地地址，不接受公网主机名。
- 中转只允许 Dashboard 使用的只读 API和 `DELETE /connections/:id`。
- 前端地址和可选的 Secret 保存在当前浏览器的 `localStorage`，不会写入服务器文件或上传云端。
- HTTP 响应包含 CSP、禁止嵌入和 MIME 嗅探等安全头。

## 开发与验证

```bash
npm run dev        # 仅启动前端开发服务器
npm run build      # 生成 dist/client
npm run build:openclash # 生成可安装的 LuCI/OpenClash IPK
npm start          # 提供已构建页面并自动打开浏览器
npm run check      # TypeScript 和 lint 检查
npm run test:guard # Provider 健康、传输保护、逐条退出与模拟控制器 API 测试（需 Ruby）
```

## API 数据来源

- `/version`：内核版本和连接状态。
- `/providers/proxies`、`/proxies`：节点、策略组、健康状态和延迟。
- `/connections`：客户端、目标、连接路径和实时速度。
- `DELETE /connections/:id`：关闭活动连接，不会永久移除节点。
