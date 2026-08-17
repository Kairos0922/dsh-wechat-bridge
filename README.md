# dsh-wechat-bridge

**把微信变成 DeepSeek Harness（DSH）的移动遥控器。**

人在外面，智能体在电脑上干活——微信发一条消息，DSH 替你查资料、写代码、跑脚本、处理文件，结果直接回微信。走腾讯官方 iLink 通道，扫码即连，无需公网服务器、无需 webhook、无需固定 IP。

## 特性

- **多模式动态路由**：`/modes` 列出你 DSH 里的全部 agent 预设，回复编号直接开会话，不写死任何角色
- **媒体双向（图片 / 文件 / 视频）**：微信发来的图片经 CDN 下载、AES 解密后落本机工作区交给 agent；bot 也可外发图片、文件附件（`/export` 会话导出、长文转文件）与视频（`/video`），端上验证正常显示
- **多用户扫码即配对**：任何人在 Web 设置面板扫码即自动加入持久化白名单（后扫不顶先扫）；每个用户独立会话、上下文、模型/工作区偏好，互不可见
- **移动端完整体验**：Markdown 保真渲染、思考进度心跳、任务清单快照、编号菜单、长文自动分段
- **安全边界**：白名单外的消息只记日志、绝不喂给模型；危险操作经审批，微信里 `/yes` `/no` 或回复编号即决
- **工程化底座**：限流感知出站队列（自动退避）、typing 缓存、断线重连、持久化去重、崩溃可恢复
- **Web 设置面板**：扫码配对、白名单、模式一览、桥内偏好（模型/工作区）、出站队列状态——不用碰终端

## 快速开始

前置：本机已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` CLI 可用）。

**第 1 步：安装**（自动注册为 profile 插件层，装完重启 `dsh web`）：

```sh
dsh plugin --profile web add https://github.com/Kairos0922/dsh-wechat-bridge.git
```

> 若你的 profile 不叫 `web`，把 `--profile web` 换成你的 profile 名。

**第 2 步：扫码配对**——打开 DSH Web 界面 → 设置面板 → 插件 → 微信桥 → 「扫码配对」，用你的微信扫码确认。

> **扫码即信任，白名单全自动**：谁扫码，谁的微信 id 就被持久化加入白名单（无需手写配置）。**多用户**：其他人再扫一次码即自动接入，各自独立会话/上下文/偏好，后扫不顶先扫。`allowFrom` 仅用于预授权或收紧（见下表）。

然后直接在微信里给机器人发消息即可。常用命令见下节。

## 微信命令

| 命令 | 作用 |
|---|---|
| `/modes` | 列出全部 agent 预设，回复编号直接开会话 |
| `/new <模式> <任务>` | 按模式开新会话并投递任务 |
| `/sessions` `/use N` | 查看 / 切换本会话 |
| `/status` | 会话、模型、工作区、配对人数、出站状态 |
| `/model` `/workspace` | 桥内偏好（per-user，仅影响之后新建的会话） |
| `/video <路径>` | 把本机视频文件作为微信视频消息发送 |
| `/export` | 导出当前会话全文为 .md 附件 |
| `/card` | 把最近一条回复渲染成长图（需 `cardMode: long` + 本机 Chrome） |
| `/retry` `/stop` `/close` | 重试 / 停止 / 归档会话 |
| `/thinking on\|off` | 思考心跳是否附最近原文（per-user） |
| `/yes` `/no` | 审批（只回答你自己的待审批请求；也支持回复编号） |
| `/help [命令]` | 帮助 |
| `//开头` | 转义：原样把 `/` 开头的文本当普通消息发给 agent |

## 媒体能力（实测矩阵，2026-08-17）

| 方向 | 类型 | 状态 |
|---|---|---|
| 微信 → bot | 图片 | ✅ 生产可用（CDN 下载 + AES 解密落盘） |
| bot → 微信 | 图片 | ✅ 端上验证正常显示（`/card` 长图、agent 图片输出） |
| bot → 微信 | 文件附件 | ✅ 端上验证（`/export`、`fileThresholdChars` 长文转文件） |
| bot → 微信 | 视频 | ✅ 端上验证正常播放（`/video <路径>`；item 类型必须为 `ITEM_VIDEO=5`） |
| bot → 微信 | 语音气泡 | ❌ 腾讯客户端不渲染 bot 语音（官方参考实现实测同样不可见） |

协议规格见 [docs/protocol.md](docs/protocol.md)；历史探针矩阵与判定过程见 [docs/porting-notes.md](docs/porting-notes.md)（维护者内部）。

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
| `originBadge` | `false` | 会话来源徽标（🟢 侧栏标记）。默认关闭 = 零宿主依赖；开启需宿主支持（DSH 集成补丁或原生 origin 扩展），不支持时自动降级为普通会话 |
| `approvalTimeoutSec` | 600 | 审批等待超时（超时默认拒绝） |
| `notifyOnComplete` | false | 长任务完成时主动播报（仅私聊） |
| `allowGroups` | `[]` | 群聊两级白名单（腾讯暂未向机器人开放群事件，待用） |

完整配置见插件源码 `src/node/index.ts` 的 `Config`。

## 多用户（1:1）

- **接入**：每个用户各自在 Web 面板「扫码配对」扫一次码即可，无需任何手动配置。
- **隔离**：会话、iLink 上下文、模型/工作区偏好、思考开关全部 per-user；`/yes` `/no` 只回答你自己的审批。
- **信任边界**：白名单 = 所有扫码确认过的用户 ∪ `allowFrom` 配置。任何拿到二维码的人扫码即获得 DSH 操控权——二维码只在你的 Web 面板显示，请勿对外发布。

## 已知限制（实测结论）

- **语音气泡外发不可用**：腾讯客户端不渲染 bot 语音消息（官方参考实现同样不可见，openclaw issue #215）。
- **群聊**：iLink 机器人身份暂无法被拉入普通微信群（腾讯侧限制），`allowGroups` 已就绪待开放。
- **工具进度卡片**：当前微信后端对卡片 item 静默丢弃，默认关闭（`progressToolPrefixes: []`），后端支持后填前缀即可启用。
- **限流**：微信通道无限流公开数字，出站队列自适应退避，请勿高频连发（历史教训：连续探针触发过封禁）。

## 开发

```sh
pnpm install && pnpm verify   # build → bundle → node --check → 102 项测试
scripts/dry-run.sh --check    # 隔离干跑（临时 DSH_HOME，不动生产）
```

## 文档

- [docs/protocol.md](docs/protocol.md) — 协议规格（iLink 常量/消息结构/媒体流程/错误码，权威定义）
- [docs/dsh-integration.md](docs/dsh-integration.md) — DSH 集成说明（origin 徽标补丁原理与自查）
- [docs/verification-records.md](docs/verification-records.md) — 验证记录（Markdown 渲染矩阵、健壮性审计）
- [docs/porting-notes.md](docs/porting-notes.md) — 移植对照与探针矩阵（维护者内部）
- [CHANGELOG.md](CHANGELOG.md)

## 许可

MIT。协议客户端与 Markdown 过滤器移植自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）；架构范式参照 [Jesse-njx/dsh-chatnode-wechat](https://github.com/Jesse-njx/dsh-chatnode-wechat)（MIT）。完整署名见 [LICENSE](LICENSE)。

> ⚠️ 本通道经腾讯微信机器人网关，腾讯可能限制账号；建议使用愿意承担风险的微信号。仅使用官方 iLink 通道，不涉及任何非官方协议。
