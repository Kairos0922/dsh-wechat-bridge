# dsh-wechat-bridge

**在微信里控制你的 DSH agent**——[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的微信渠道插件（iLink 网关 + 会话桥），带三个生态里没有的能力：

1. **多模式动态路由**：运行时从 `$DSH_HOME/.agent-presets/` 发现 agent 预设，`/modes` 列出、`/new <mode>` 按模式开会话——不写死任何角色，任何用户的任何预设自动可用
2. **图片消息进会话**：微信发来的图片经 CDN 下载解密后存入本机工作区，交给 agent 会话处理
3. **Web 设置面板**：扫码配对、白名单管理、网关状态都在 DSH Web 设置里可视化完成，不用在终端里找二维码

## 架构

```
你的微信 ⇄ iLink 网关(腾讯) ⇄ wechat-gateway(ctx.wechat 服务) ⇄ wechat-bridge-node ⇄ DSH 会话
```

两个可独立挂载的 Cordis 插件：

| 插件 | 职责 |
|---|---|
| `wechat-gateway` | iLink 通道服务：QR 登录、认证长轮询、重连/退避、发送重试、typing、CDN 媒体 |
| `wechat-bridge-node` | 微信 ⇄ DSH 桥：白名单门禁、预设注册表、命令、审批、摘要输出 |

> 协议客户端移植自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）；
> 架构范式参照 [Jesse-njx/dsh-chatnode-wechat](https://github.com/Jesse-njx/dsh-chatnode-wechat)（MIT）。
> 完整署名见 LICENSE。

## 安装

```sh
cd plugins/dsh-wechat-bridge
pnpm install && pnpm build
dsh plugin --profile <你的-profile> add .
```

凭证走 **dsh credentials 服务**（绝不落 patch 文件）。扫码配对一次：

```sh
pnpm login          # 打印二维码链接，微信扫码确认
```

## 配置（profile 的 cordis.patch.yml）

```yaml
plugins:
  dsh-wechat-bridge:
    allowFrom: ["<你的微信id>"]   # 硬白名单，必填，无宽容默认
    defaultMode: life-butler     # /new 不带模式时的默认预设
    digestIntervalSec: 300       # 长任务心跳摘要（秒）
    approvalTimeoutSec: 600      # 审批超时默认拒绝（秒）
    maxMessageChars: 2000        # 微信单条气泡上限
    sendChunkDelayMs: 1500       # 气泡间隔节流
```

`allowFrom` **必填**：白名单外的消息记日志后丢弃，**绝不喂给模型**。

## 微信命令

`/modes` · `/new [模式]` · `/use <会话>` · `/sessions` · `/stop` · `/status` · `/yes` · `/no`

## 安全须知

- iLink 每个 bot token 只允许**一个**认证轮询者；同一微信号再跑其他微信桥会互相 403
- 本通道经腾讯微信机器人网关，腾讯有可能限制账号——建议使用愿意承担风险的微信号
- 微信消息只能进 DSH 会话流（`source.kind='plugin'`），**不能执行 shell**

## 里程碑状态

- [x] M0 骨架：双插件结构、配置 schema、挂载验证
- [x] M1 通道：iLink 客户端（QR 登录 / 长轮询 / 文本收发 / typing）＋登录 CLI
- [x] M2 桥接：白名单 / 多模式动态路由 / 审批 / 长文分段 + 测试
- [x] M3 图片进会话：CDN 下载 + AES-128-ECB 解密 + 落本机工作区
- [x] M3 Web 设置面板：网关状态/扫码配对/白名单/模式一览（设置 → 插件 → 微信桥）
- [ ] 发布：安装进 web profile + allowFrom 配置 + 端到端联调（需扫码配对后执行）

> 本插件为 **web profile 专用**（client 面板 + webServer 端点）；headless 可加载网关但无设置面板。

## License

MIT — 完整署名见 [LICENSE](LICENSE)。
