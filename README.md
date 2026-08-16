# dsh-wechat-bridge

**把微信变成 DeepSeek Harness（DSH）的移动遥控器。**

人在外面，智能体在电脑上干活——微信发一条消息，DSH 替你查资料、写代码、跑脚本、处理文件，结果直接回微信。走腾讯官方 iLink 通道，扫码即连，无需公网服务器、无需 webhook、无需固定 IP。

## 特性

- **多模式动态路由**：`/modes` 列出你 DSH 里的全部 agent 预设，回复编号直接开会话，不写死任何角色
- **移动端完整体验**：Markdown 保真渲染、思考进度心跳、任务清单快照、编号菜单、长文自动分段
- **安全边界**：扫码配对即自动白名单（谁扫码谁可信，白名单外消息直接丢弃，绝不喂给模型）；危险操作经审批，微信里 `/yes` `/no` 或回复编号即决
- **微信 ⇄ 图片**：微信发来的图片经 CDN 下载、AES 解密后落本机工作区，交给 agent 处理（入站图片生产可用）
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

> **白名单全自动**：扫码本身就是信任动作——谁扫码，谁的微信 id 就被自动加入白名单（存为 `WEIXIN_ILINK_USER_ID` 凭证），配好即可用，无需手写配置。`allowFrom` 仅在你需要限制更多/多用户时使用（见下表）。

然后直接在微信里给机器人发消息即可。常用命令见下节。

## 微信命令

| 命令 | 作用 |
|---|---|
| `/modes` | 列出全部 agent 预设，回复编号直接开会话 |
| `/new <模式> <任务>` | 按模式开新会话并投递任务 |
| `/sessions` `/use N` | 查看 / 切换本会话 |
| `/status` | 会话、模型、工作区、出站状态 |
| `/model` `/workspace` | 桥内偏好（仅影响之后新建的会话） |
| `/retry` `/stop` `/close` | 重试 / 停止 / 归档会话 |
| `/thinking on|off` | 思考心跳是否附最近原文 |
| `/yes` `/no` | 审批（也支持回复编号） |
| `/help [命令]` | 帮助 |
| `//开头` | 转义：原样把 `/` 开头的文本当普通消息发给 agent |

## 常用配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `allowFrom` | 空 = 信任配对扫码者 | 可选：额外白名单（多用户或收紧） |
| `defaultMode` | — | `/new` 不带模式时的默认预设 |
| `cwd` | — | `/new` 会话默认工作目录 |
| `markdownMode` | `passthrough` | `passthrough` / `filter` / `plain` 三种 Markdown 策略（渲染实测矩阵见 [docs/markdown-matrix.md](docs/markdown-matrix.md)） |
| `minSendIntervalMs` | 5000 | 出站最小发送间隔（限流卫生） |
| `typingHeartbeatSec` | 25 | 长任务期间重发「正在输入」的间隔（0=关闭） |
| `maxMessageChars` | 2000 | 单条气泡上限 |
| `allowGroups` | `[]` | 群聊两级白名单（腾讯暂未向机器人开放群事件） |

完整配置见插件源码 `src/node/index.ts` 的 Config 与 [docs/porting-notes.md](docs/porting-notes.md)。

## 已知限制（实测结论）

- **bot → 微信 发图片/附件暂不可用**：微信客户端只渲染其客户端自生成的媒体参数结构，服务器签发的结构会被静默丢弃；官方参考实现（openclaw / hermes）当前同样不通。判定证据与金丝雀重测条件见 [docs/porting-notes.md §6.1](docs/porting-notes.md)。**入站图片（微信 → bot）完全可用。**
- **群聊**：iLink 机器人身份暂无法被拉入普通微信群（腾讯侧限制），`allowGroups` 已就绪待开放。
- **工具进度卡片**：当前微信后端对卡片 item 静默丢弃，默认关闭（`progressToolPrefixes: []`），后端支持后填前缀即可启用。
- **限流**：微信通道无限流公开数字，出站队列自适应退避，请勿高频连发。

## 开发

```sh
pnpm install && pnpm verify   # build → bundle → node --check → 84 项测试
scripts/dry-run.sh --check    # 隔离干跑（临时 DSH_HOME，不动生产）
```

## 文档

- [docs/porting-notes.md](docs/porting-notes.md) — 相对 Tencent/openclaw-weixin 的逐字段移植对照表（协议对齐 diff 清单）
- [docs/harness-patch.md](docs/harness-patch.md) — DSH harness 补丁记录（origin 徽标，升级 DSH 后需重打）
- [CHANGELOG.md](CHANGELOG.md)

## 许可

MIT。协议客户端与 Markdown 过滤器移植自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）；架构范式参照 [Jesse-njx/dsh-chatnode-wechat](https://github.com/Jesse-njx/dsh-chatnode-wechat)（MIT）。完整署名见 [LICENSE](LICENSE)。

> ⚠️ 本通道经腾讯微信机器人网关，腾讯可能限制账号；建议使用愿意承担风险的微信号。仅使用官方 iLink 通道，不涉及任何非官方协议。
