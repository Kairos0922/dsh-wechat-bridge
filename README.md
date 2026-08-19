# dsh-wechat-bridge

**把微信变成 DeepSeek Harness（DSH）的移动遥控器。**

人在外面，智能体在电脑上干活——微信发一条消息，DSH 替你查资料、写代码、跑脚本、处理文件，结果直接回微信。走腾讯官方 iLink 通道，扫码即连，无需公网服务器、无需 webhook、无需固定 IP。

## 特性

- **零配置上手**：安装后扫码即可使用；直接发消息会自动创建会话（默认模式），无需手动建会话
- **多模式动态路由**：`/modes` 列出你 DSH 里的全部 agent 预设，回复编号直接开会话，不写死任何角色
- **媒体双向（图片 / 文件 / 视频）**：微信发来的图片经 CDN 下载、AES 解密后落本机工作区交给 agent；bot 也可外发图片、文件附件（`/export` 会话导出、长文转文件）与视频（`/video`），实测正常显示
- **多用户扫码即配对**：在 Web 设置面板扫码配对，首个用户自动信任（bootstrap），后续用户需在面板确认后加入（见「安全模型」）；每个用户拥有独立会话、上下文与模型/工作区偏好，互不可见
- **移动端完整体验**：Markdown 保真渲染、思考进度心跳、任务清单快照、编号菜单、长文自动分段、完成耗时提示
- **上下文透明**：每轮结束附上下文用量（`🧮 12.0k / 32.0k`），接近上限提示自动压缩并建议 `/new`；自动压缩发生时主动告知
- **可打断**：执行中回复「停 / 停止 / 算了」立即取消，停止后附进度摘要与 `/retry` 引导；断线恢复自动通知
- **安全边界**：白名单外的消息只记日志、绝不喂给模型（可选 `notifyRejected` 提醒）；危险操作经审批，在微信里回复 `/yes` `/no` 或编号即可决定
- **工程化底座**：限流感知出站队列（窗口预算 + 自动退避）、typing 缓存、断线重连、持久化去重、崩溃可恢复、媒体失败不静默
- **Web 设置面板**：扫码配对、白名单、模式一览、桥内偏好（模型/工作区）、出站队列状态——不用碰终端

## 快速开始

前置：本机已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` CLI 可用）。

**第 1 步：安装**（自动注册为 profile 插件层，装完重启 `dsh web`）：

```sh
dsh plugin --profile web add https://github.com/Kairos0922/dsh-wechat-bridge.git
```

> 若你的 profile 不叫 `web`，把 `--profile web` 换成你的 profile 名。

**第 2 步：扫码配对**——打开 DSH Web 界面 → 设置面板 → 插件 → 微信桥 → 点击「扫码配对」，用你的微信扫码确认。

> **扫码即配对（bootstrap）**：信任集为空时，第一个扫码用户的微信 id 自动进入信任集（持久化保存，无需手写配置）；信任集非空后，新用户扫码需在 Web 面板点「确认」才加入，换账号扫码同样需确认后才切换凭据。**多用户**：每个用户拥有独立会话/上下文/偏好，后来的扫码不会顶替先前用户。`allowFrom` 仅用于预授权或收紧（见下表）。

然后直接在微信里给机器人发消息即可——没有会话时会**自动创建**（默认模式），不用手动 `/new`。常用命令见下节。

## 微信命令

| 命令 | 作用 |
|---|---|
| `/modes` | 列出全部模式（中文说明 + 快捷命令），回复编号直接开会话 |
| `/new [模式] <任务>` | 按模式新建会话并开始处理 |
| `/sessions` | 列出你的会话（含上下文用量与最后活动时间） |
| `/use N` | 切换到第 N 个会话 |
| `/status` | 查看会话、偏好、配对人数与出站状态 |
| `/model` | 查看/切换模型（仅影响之后新建的会话；`/model default` 恢复默认） |
| `/workspace` | 查看/切换工作区（仅影响之后新建的会话；`/workspace default` 恢复默认） |
| `/thinking on\|off` | 思考心跳是否附最近原文（per-user） |
| `/stop` | 停止当前执行中的任务（也可直接回复「停 / 停止 / 算了」） |
| `/retry` | 重试上一次任务 |
| `/close` | 归档当前会话 |
| `/yes` `/no` | 审批：同意 / 拒绝最近一次权限请求（只回答你自己的；仅一条待确认时也可回复 1/2） |
| `/video <路径>` | 把本机视频文件作为微信视频消息发送（仅限工作区 cwd 与媒体目录下的 .mp4 文件，校验扩展名/真实路径/普通文件，≤10MB） |
| `/export` | 导出当前会话全文为 .md 附件 |
| `/card` | 把最近一条回复渲染成长图（需 `cardMode: long` + 本机 Chrome） |
| `/help [命令]` | 查看全部命令或单个命令详情 |
| `//开头` | 转义：原样把 `/` 开头的文本当普通消息发给 agent |

## 媒体能力（实测矩阵，2026-08-17）

| 方向 | 类型 | 状态 |
|---|---|---|
| 微信 → bot | 图片 | ✅ 生产可用（CDN 下载 + AES 解密落盘） |
| bot → 微信 | 图片 | ✅ 实测正常显示（`/card` 长图、agent 图片输出） |
| bot → 微信 | 文件附件 | ✅ 实测可用（`/export`、`fileThresholdChars` 长文转文件） |
| bot → 微信 | 视频 | ✅ 实测正常播放（`/video <路径>`；item 类型必须为 `ITEM_VIDEO=5`） |
| bot → 微信 | 语音气泡 | ❌ 腾讯客户端不渲染 bot 语音（官方参考实现实测同样不可见） |

协议规格见 [docs/protocol.md](docs/protocol.md)；历史探针矩阵与判定过程见 [docs/porting-notes.md](docs/porting-notes.md)。

## 常用配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `allowFrom` | `[]` | 额外白名单（扫码即配对是主信任机制；此项用于预授权未扫码用户或收紧） |
| `defaultMode` | — | `/new` 不带模式时的默认预设 |
| `cwd` | — | `/new` 会话默认工作目录 |
| `markdownMode` | `passthrough` | `passthrough` / `filter` / `plain` 三种 Markdown 策略（渲染行为实测见 [docs/verification-records.md](docs/verification-records.md)） |
| `minSendIntervalMs` | 5000 | 出站最小发送间隔（限流卫生） |
| `typingHeartbeatSec` | 25 | 长任务期间重发「正在输入」的间隔（0=关闭） |
| `maxMessageChars` | 2000 | 单条气泡上限 |
| `fileThresholdChars` | 0 | 长文转文件阈值（>0 时超长回复自动变 .md 附件；0=关闭） |
| `cardMode` | `off` | 长图卡片模式（`off` / `long`，需本机 Chrome） |
| `approvalTimeoutSec` | 600 | 审批等待超时（超时默认拒绝） |
| `notifyOnComplete` | false | 长任务完成时主动播报（仅私聊） |
| `notifyRejected` | false | 陌生账号尝试联系时通知信任用户 |
| `thinkingDigestSec` | 120 | 执行中「仍在处理」心跳间隔（秒，0=关闭） |
| `sendBudgetWindowSec` / `sendBudgetMaxPerWindow` | 60 / 4 | 出站滑动窗口预算（每窗口最多条数，超限排队不丢弃） |
| `allowGroups` | `[]` | 群聊两级白名单（腾讯暂未向机器人开放群事件，待用） |

完整配置见插件源码 `src/node/index.ts` 的 `Config`。

## 多用户（1:1）

- **接入**：每个用户各自在 Web 面板「扫码配对」扫码；首个用户（信任集为空）扫码即自动信任，之后的新用户需在面板点「确认」才加入。
- **隔离**：会话、iLink 上下文、模型/工作区偏好、思考开关全部 per-user；`/yes` `/no` 只回答你自己的审批。
- **信任边界**：信任集 = `allowFrom` ∪ 面板确认的配对用户 ∪ 凭据 owner（详见下节「安全模型」）。任何拿到二维码的人都能发起配对请求——二维码只在你的 Web 面板显示，请勿对外发布。

## 安全模型

- **信任集构成**：信任集 = `allowFrom` 配置 ∪ Web 设置面板中确认过的配对用户 ∪
  凭据 owner（扫码登录的账号本身）。信任集外的消息只记日志、绝不喂给模型。
- **扫码配对（bootstrap）**：信任集为空时，第一个扫码用户的微信 id 自动进入信任集
  （无需额外确认）；信任集非空后，新用户扫码**不会**自动入集，需在 Web 设置面板点
  「确认」才加入；更换账号扫码同样需面板确认后才切换凭据。面板可对已配对用户执行
  吊销（revoke）。
- **API 端点栅栏**：`/api/dsh-wechat-bridge/*` 带浏览器信任栅栏——Host 回环校验 +
  `sec-fetch-site` 拒绝跨站 + Origin 同源校验；非本机回环 Host 一律 403。
- **存储与日志**：状态与日志文件（state.json / seen.json / poll-cursor.json /
  debug.log / events.jsonl / media-captures.jsonl）权限为 0600（所在目录 0700）；
  日志中 context_token 只记尾 12 位，媒体 AES 密钥落盘前脱敏为 `<redacted>`。
- **`/video` 路径限制**：仅允许工作区（cwd）与媒体目录下的 .mp4 文件，校验扩展名、
  真实路径、普通文件与大小上限（10MB）。
- **入站媒体下载**：仅接受 CDN 域白名单（`*.cdn.weixin.qq.com`）+ HTTPS + 30s 超时
  + 20MB 上限，不自动跟随未校验重定向。
- **出站语义 at-least-once**：协议无幂等键，极端重试场景下可能重复投递。
- **媒体留存**：入站图片等缓存文件按 `mediaRetentionDays`（默认 30 天，0 关闭）
  自动删除——**包含用户发来的图片**。
- **群聊前瞻**：腾讯暂未向 bot 开放群事件；开放后房间内成员互信，共享会话与审批
  队列；引用消息在群聊中只保留标题、不携带正文。

## 已知限制（实测结论）

- **语音气泡外发不可用**：腾讯客户端不渲染 bot 语音消息（官方参考实现同样不可见，openclaw issue #215）。
- **群聊**：iLink 机器人身份暂无法被拉入普通微信群（腾讯侧限制），`allowGroups` 已就绪待开放。
- **工具进度卡片**：当前微信后端对卡片 item 静默丢弃，默认关闭（`progressToolPrefixes: []`），后端支持后填前缀即可启用。
- **限流/会话过期**：微信通道无限流公开数字（`ret=-2` 的 errmsg 区分限流与 token 过期，见 `docs/protocol.md §5`）。
  - 出站队列自适应退避（10s→30s→60s）；`prepare failed`（token 过期）自动做无 token 恢复重发。
  - **长任务默认静音**：中间工具叙述不再推送微信；最终答案在任务结束时一次送达；执行中仅低频「🔄 仍在处理中」心跳（120s）。
  - **关键消息必达**：审批提示、最终答案、出错/停止通知发送失败不放弃——通道恢复（你下一条消息）时自动补发。
  - 审批提示发送失败不静默：用户下一条消息到达时自动重推（审批必达手机）。
  - 请避免高频连续发送，可能触发服务端限流。

## 开发

```sh
pnpm install && pnpm verify   # build → bundle → node --check → 220 项测试
scripts/dry-run.sh --check    # 隔离干跑（临时 DSH_HOME，不动生产）
```

## 文档

- [docs/protocol.md](docs/protocol.md) — 协议规格（iLink 常量/消息结构/媒体流程/错误码，权威定义）
- [docs/verification-records.md](docs/verification-records.md) — 验证记录（Markdown 渲染矩阵、健壮性审计）
- [docs/porting-notes.md](docs/porting-notes.md) — 移植对照与探针矩阵
- [CHANGELOG.md](CHANGELOG.md)

## 许可

MIT。协议客户端与 Markdown 过滤器移植自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）；架构范式参照 [Jesse-njx/dsh-chatnode-wechat](https://github.com/Jesse-njx/dsh-chatnode-wechat)（MIT）。完整署名见 [LICENSE](LICENSE)。

> ⚠️ 本通道经腾讯微信机器人网关，腾讯可能限制账号；建议使用愿意承担风险的微信号。仅使用官方 iLink 通道，不涉及任何非官方协议。
