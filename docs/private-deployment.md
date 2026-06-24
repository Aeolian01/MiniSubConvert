# 私有部署说明

## 目标拓扑

```text
订阅入口服务
  private converter base URL = https://<worker-domain>/<secret>
        |
        v
MiniSubConvert Worker
  /<secret>/sub?target=<target>&url=<subscription-url>
```

本仓库只保存可公开的模板配置。真实域名、Zone、Worker 名称、入口服务项目名和订阅 token 必须放在本地未跟踪配置或托管平台 Secrets 中。

## 必需配置

- `SECRET`: 至少 16 位的随机后端路径 secret，不应使用短数字、常见单词或示例值。
- `CLOUDFLARE_API_TOKEN`: 具有目标 Worker 部署权限的 Cloudflare API token。
- `CLOUDFLARE_ACCOUNT_ID`: 目标 Cloudflare account ID。
- `WORKER_NAME`: 私有 Worker 名称。
- `WORKER_CUSTOM_DOMAIN`: 私有 Worker 自定义域名，例如 `<worker-domain>`。
- `WORKER_ZONE_NAME`: 自定义域名所在 Zone，例如 `<zone-name>`。

不要在 README、issue、日志、OpenSpec 文档或提交历史中写入真实 secret、真实订阅 URL、私有域名或账号标识。

## 本地私有配置

公开的 `wrangler.jsonc` 是模板配置，不包含真实自定义域名。需要本地部署时，复制一份未跟踪配置：

```bash
cp wrangler.jsonc wrangler.local.jsonc
```

在 `wrangler.local.jsonc` 中设置：

- `name`: 真实 Worker 名称。
- `workers_dev`: 私有部署建议为 `false`。
- `routes`: 使用真实 `pattern`、`zone_name` 和 `custom_domain: true`。

`wrangler.local.jsonc` 已被 `.gitignore` 忽略，不应提交。

## GitHub Actions 部署

Actions 不读取仓库内的真实域名。部署时会从 GitHub Secrets 生成 `.build/wrangler.deploy.jsonc`，再用该临时配置发布 Worker。

需要配置的 GitHub Secrets：

- `SECRET`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `WORKER_NAME`
- `WORKER_CUSTOM_DOMAIN`
- `WORKER_ZONE_NAME`

部署步骤会先运行质量门禁，再校验 `SECRET` 强度，最后执行：

```bash
pnpm run build:parsers
wrangler deploy .build/src/worker.js --config .build/wrangler.deploy.jsonc --tsconfig .build/jsconfig.json
wrangler secret bulk .env.local --config .build/wrangler.deploy.jsonc
```

## 私用限制

- 仅预期小范围私用，不作为公开转换服务。
- 上游订阅 URL 应优先来自受控入口服务的临时汇聚 URL，避免把真实上游订阅地址直接放进客户端。
- 默认上游数量限制为 8 个。
- 默认上游并发为 3。
- 默认单个上游响应大小限制为 5 MiB。
- 默认单个配置响应大小限制为 256 KiB。
- 默认 POST body 限制为 1 MiB。
- 默认上游 fetch 超时时间为 10 秒。
- 默认拒绝 `http:` 上游，包括 redirect 后的目标。
- 默认最多跟随 5 次上游 redirect，每一跳都会重新执行协议、host、IP 和 DNS guard。
- 默认启用 DNS guard，拒绝回环、私有、链路本地、metadata 和其他被阻止目标地址。

## SUBCONFIG 支持

当请求同时满足以下条件时，MiniSubConvert 会读取入口服务传入的 `config` URL，并输出完整 Mihomo YAML：

- `target=clash`、`target=mihomo`、`target=meta`、`target=clashmeta` 等会归一化到 Mihomo 的 target。
- 请求包含 `config=https://...`。
- `config` URL 通过与上游订阅相同的 HTTPS-only、DNS guard、超时和大小限制。

当前支持的 SUBCONFIG 子集：

- `custom_proxy_group=...` 会转换为 Mihomo `proxy-groups`。
- 组内 `[]组名` 会保留为组引用。
- 组内正则会按代理节点名称匹配，并填入匹配到的节点。
- 空组会 fallback 到 `♻️ 自动选择`，避免客户端加载空代理组。
- 如果 SUBCONFIG 未定义 `♻️ 自动选择`，后端会自动创建一个包含全部节点的 `url-test` 组。
- `ruleset=<policy>,https://...` 会转换为 `rule-providers` 和 `RULE-SET` 规则。
- 远程 rule-provider 会按 URL 后缀为 `.list` / `.txt` 输出 `format: text`，为 `.yaml` / `.yml` 输出 `format: yaml`。
- 每个远程 rule-provider 都会添加 `proxy: ♻️ 自动选择`，让客户端下载规则时默认走代理。
- `ruleset=<policy>,[]FINAL` 会转换为 `MATCH,<policy>`。
- `ruleset=<policy>,[]GEOIP,CN,no-resolve` 等常见内置规则会转换为 Mihomo `rules`，并保留 `no-resolve` 等尾部 option。

安全边界：

- `config` URL 不会写入日志。
- 后端 secret、真实上游订阅 URL 不会写入 rule-provider `path`。
- `rule-provider.path` 使用稳定且去重的本地相对路径，例如 `./ruleset/OpenAi.list` 或 `./ruleset/OpenAi.yaml`。
- 非 Mihomo target 会忽略 `config`，保持原有输出。
- 缺少 `config` 时保持原有 producer 输出，不自动补 `proxy-groups`、`rule-providers` 或 `rules`。

## 验证命令

本地门禁：

```bash
pnpm install --frozen-lockfile
pnpm run lint
pnpm run smoke
pnpm run build
```

只验证 Worker 打包而不发布：

```bash
pnpm run worker:dry-run
```

使用本地私有配置发布前 dry-run：

```bash
pnpm run build:parsers
wrangler deploy .build/src/worker.js --config wrangler.local.jsonc --tsconfig .build/jsconfig.json --dry-run
```

发布后远程 smoke 使用占位命令，执行时替换为本地真实值，不要把替换后的命令写入提交：

```bash
curl -i 'https://<worker-domain>/wrong/sub'
curl -fsS -X POST 'https://<worker-domain>/<secret>/api/proxy/parse' \
  -H 'content-type: application/json' \
  --data '{"client":"singbox","data":"trojan://password@example.com:443#ExampleNode"}'
curl -fsS 'https://<worker-domain>/<secret>/sub?target=singbox&url=<encoded-upstream-sub-url>'
```

预期结果：

- `/wrong/sub` 返回 `403`。
- POST 转换返回 JSON 且 `status` 为 `success`。
- GET 转换返回目标客户端格式。
- 响应体不包含后端 secret、真实上游订阅 URL 或公开转换后端标记。

## 已知兼容边界

- `config` 仅实现私有场景需要的 SUBCONFIG 子集，不等价于完整 subconverter。
- `insert`、`emoji`、`sort`、`list`、`new_name` 等传入的其他 subconverter 风格参数会被安全忽略，不会实现完整 subconverter 配置语义。
- 当前不展开远程 ruleset 内容，只生成 Mihomo `rule-providers`，由客户端按规则 provider 自行下载。
- 不支持复杂模板、外部 provider 覆写、脚本逻辑或非 `custom_proxy_group` 的高级 SUBCONFIG 指令。
- `mixed` 映射到 `v2ray`，用于返回 base64 URI 列表。
- 小写 `clash` 默认映射到 `mihomo`，适配现代 Clash.Meta/Mihomo 客户端；如果确需旧 Clash producer，请显式请求 `target=Clash`。

## 回滚

如果新 Worker 版本异常，先查看最近版本并回滚 Worker：

```bash
wrangler deployments list --config wrangler.local.jsonc
wrangler rollback <previous-version-id> --config wrangler.local.jsonc --name <worker-name> --message 'rollback MiniSubConvert production'
wrangler deployments status --config wrangler.local.jsonc
```

Worker 回滚后重新运行发布后远程 smoke。若入口服务已经改过后端地址，再把对应 secret 恢复到上一条已知可用的后端地址并重新部署入口服务。

如果只是 SUBCONFIG 规则组异常，可以先移除入口服务传入的 `config` 参数或切回无规则组输出；无 `config` 请求仍保持原 producer 行为。
