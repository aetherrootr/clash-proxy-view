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
`/tmp` 后安装：

```bash
opkg install /tmp/luci-app-proxy-view_0.1.0-1_all.ipk
```

安装后，LuCI 的“服务 → 多线代理控制台”会跳转到：

```text
http://<当前路由器地址>:9090/ui/proxy-view/
```

嵌入模式直接访问同源 Mihomo API，不依赖本机命令行中转。首次使用仍需在页面中
填写控制器 `secret`。卸载命令：

```bash
opkg remove luci-app-proxy-view
```

该软件包不会修改 OpenClash 源码；OpenClash 必须已经安装，并使用 9090 作为外部
控制端口。

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
```

## API 数据来源

- `/version`：内核版本和连接状态。
- `/providers/proxies`、`/proxies`：节点、策略组、健康状态和延迟。
- `/connections`：客户端、目标、连接路径和实时速度。
- `DELETE /connections/:id`：关闭活动连接，不会永久移除节点。
