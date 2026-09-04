# 多线代理控制台

一个纯静态的 Mihomo/OpenClash 监控面板。浏览器直接连接本地 Mihomo API，显示亚洲中转节点的健康、延迟、活动连接与实时速度。

## 本地使用

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`，填写 Mihomo 控制器地址和 `secret`。

页面会自动发现名称包含 `出口｜多线加速` 的策略组，并以这些组的成员作为监控范围。速度由 `/connections` 中每条连接的累计字节差计算，每秒刷新。

“踢掉连接”调用 `DELETE /connections/:id`，只关闭该节点当前承载的连接，不会永久修改 Provider 或负载均衡成员。

## Mihomo 控制器要求

浏览器需要 CORS 和 Private Network Access 响应。建议只允许实际使用的页面来源：

```yaml
external-controller: 0.0.0.0:9090
secret: "使用强随机密钥"
external-controller-cors:
  allow-origins:
    - http://localhost:3000
    - https://你的面板域名
  allow-private-network: true
```

不要把 9090 直接暴露到公网。

## Cloudflare 部署

Cloudflare Pages：

- 构建命令：`npm run build`
- 输出目录：`dist/client`

Cloudflare Workers Static Assets：

```bash
npm run deploy:cloudflare
```

Cloudflare 页面使用 HTTPS，浏览器会阻止它请求 `http://192.168.8.1:9090`。生产使用时需要一个浏览器信任的 HTTPS 控制器地址，例如：

- 在 Mihomo 配置 `external-controller-tls`，使用受信任证书；
- 使用仅在内网解析的域名指向路由器，并通过 DNS 验证申请证书；
- 或通过受严格访问控制的反向代理连接本地控制器。

不建议把 Mihomo API 通过无保护的 Cloudflare Tunnel 暴露出去。无论采用哪种方式，都应保留 Mihomo `secret` 并限制 CORS 来源。
