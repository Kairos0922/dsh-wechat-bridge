# 移植与上游对照记录

> 本文记录 dsh-wechat-bridge 与 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 的实现对照、适配边界和重要历史结论。**当前协议以 [protocol.md](protocol.md) 为准。**
>
> 核心协议实现来源是 Tencent/openclaw-weixin；整体实现方式基于 OpenClaw 及其官方实现，并针对 DSH runtime 做适配。其他第三方 DSH 微信项目不作为本项目的架构来源。

## 1. 来源与边界

| 领域 | 主要来源 | 本项目处理 |
|---|---|---|
| iLink API / 消息结构 | Tencent/openclaw-weixin | 移植并适配 DSH |
| CDN 媒体上传/下载 | Tencent/openclaw-weixin | 移植并适配本地媒体管线 |
| StreamingMarkdownFilter | Tencent/openclaw-weixin | 行为保持的移植 |
| QR 登录与轮询 | Tencent/openclaw-weixin | 按 DSH 生命周期适配 |
| typing ticket / session guard 等协议机制 | Tencent/openclaw-weixin | 按本项目单 bot 模型适配 |
| 会话、agent、审批、提问、Web 集成 | DSH 官方 runtime | 直接接入 DSH service API |

## 2. 当前对齐项

- `ITEM_*` / `UPLOAD_MEDIA_*` 协议常量。
- iLink `sendMessage` / `getUpdates` 消息结构。
- CDN AES-128-ECB + PKCS#7 媒体管线。
- CDN 响应头 `x-encrypted-param` 作为 bot 出站媒体引用。
- QR 验证码状态机、`local_token_list`、登录/轮询错误分类。
- `StreamingMarkdownFilter` 流式状态机与测试向量。
- typing ticket 缓存与刷新。
- 会话过期与发送错误分类。

## 3. 有意偏差

### 3.1 Markdown

上游实现默认过滤外发 Markdown；本项目默认 `passthrough`，因为生产通道实测大部分 Markdown 可以正常渲染。`filter` 与 `plain` 作为显式降级策略保留。

### 3.2 出站队列

本项目在上游发送语义之上增加 DSH 场景所需的统一 outbox：

- 最小发送间隔；
- 客户端滑动窗口预算；
- per-peer session-window 保护；
- MUST 消息优先级；
- 限流退避；
- 不确定发送结果禁止盲重发；
- 关键消息恢复重推。

这些属于本项目可靠性策略，不应描述为腾讯协议保证。

### 3.3 DSH runtime

会话、agent、审批、用户提问和 Web 设置面板均属于 DSH runtime 集成层。当前宿主基线为 DSH `0.1.5-rc.1`；不提供未经验证的旧 API 兼容路径。

## 4. 当前媒体结论

2026-08-17 的端上验证确认：

- 图片出站可正常显示；
- 视频必须使用 `ITEM_VIDEO=5`；此前误用 `3` 会被当成语音；
- `encrypt_query_param` 使用 CDN 上传响应头 `x-encrypted-param`；
- `aes_key` 使用 base64 编码的 hex 字符串；
- bot 出站 item 不应直接复制客户端入站 item 的附加字段。

入站图片、文件、视频均已有统一下载、解密、落盘代码路径。若某一媒体类型没有独立真机记录，不在 README 中宣称其“生产端到端实测”。

## 5. 当前发送窗口结论

2026-08-19 三次独立实测观察到约 10 条/用户入站窗口的成功出站。该数字仅用于桥端保护策略 `sessionWindowSendMax=10`，不是公开协议常量。

## 6. 宿主 API 结论

2026-09-10 后：

- 固定依赖 DSH `0.1.5-rc.1`；
- 会话事件读取统一使用 `snapshotEvents()`；
- 不再依赖旧的 `Session.events`；
- API 漂移记录诊断并退化为空日志，避免宿主进程因未处理 rejection 退出。

## 7. 微信提问结论

2026-09-20 修复了 `ask_user_question` 在微信侧不可见导致 turn 长时间阻塞的问题：

- 微信 bridge 优先认领属于自身 peer 的问题；
- 支持编号、多选和自由文本回答；
- 提问提示按 MUST-DELIVER 处理；
- 用户下一条消息与 watchdog tick 可触发重推；
- `/stop` 始终可用；
- `questionTimeoutSec` 默认 1800s；
- 超时、中断、销毁均清理 pending question。

## 8. 历史结论的处理

2026-08-16 的媒体探针曾把 `prepare failed` 与媒体形状直接绑定，并得出“客户端渲染门禁”的错误结论。2026-08-17 的端上验证已推翻该结论。

因此：

- 历史探针结果可以保留在提交历史中；
- 当前文档不得把被推翻的结论写成现行协议事实；
- 当前错误语义以 `classifySendFailure()` 和 [protocol.md](protocol.md) 为准。

## 9. 上游升级规则

每次升级 Tencent/openclaw-weixin：

1. 固定上游版本号。
2. 对照 API types、send、inbound、media、login/QR、config-cache、sync-buf 等相关实现。
3. 只记录行为差异，不把文件名变化误判为协议变化。
4. 自动化测试通过后，再更新 `protocol.md`。
5. 若实测推翻旧结论，保留日期与证据摘要，并从当前规格中删除旧结论。

## 10. 术语与署名

- **Tencent/openclaw-weixin**：本项目协议客户端及部分相关实现的主要上游来源。
- **OpenClaw**：本项目整体实现方式与协议适配的主要技术参照。
- **DSH official runtime**：本项目会话、agent、审批、提问及 Web 集成的宿主。
- 其他第三方 DSH 微信项目不属于本项目的代码来源或许可证归因范围。
