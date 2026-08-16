# dsh-wechat-bridge

**在微信里控制你的 DSH agent**——[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的微信渠道插件（iLink 网关 + 会话桥），带几个生态里没有的能力：

1. **多模式动态路由**：运行时经 DSH `agentPresets` 服务发现**全部** agent 预设，`/modes` 列出（中文名称 + 说明 + 可复制快捷命令 + 回复编号直接创建），`/new <模式>` 按模式开会话——不写死任何角色
2. **移动端会话体验**：Markdown 保真渲染策略、思考进度心跳、协议原生工具进度卡片、任务清单快照、编号菜单，全部走一条**限流感知的出站队列**
3. **图片消息进会话**：微信发来的图片经 CDN 下载解密后存入本机工作区，交给 agent 会话处理
4. **Web 设置面板**：扫码配对、白名单、模式一览、桥内偏好（模型/工作区）、出站队列/限流状态——不用在终端里找二维码

## 架构

```
你的微信 ⇄ iLink 网关(腾讯) ⇄ wechat-gateway(ctx.wechat 服务) ⇄ wechat-bridge-node ⇄ DSH 会话
```

两个可独立挂载的 Cordis 插件：

| 插件 | 职责 |
|---|---|
| `wechat-gateway` | iLink 通道服务：QR 登录、认证长轮询、重连/退避、结构化发送结果、typing 票据缓存、持久化入站去重、CDN 媒体 |
| `wechat-bridge-node` | 微信 ⇄ DSH 桥：白名单门禁、per-peer 会话绑定、命令注册表、审批（含参数摘要）、限流感知出站队列、进度/正文输出 |

> 协议客户端与 Markdown 过滤器移植自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）；
> 架构范式参照 [Jesse-njx/dsh-chatnode-wechat](https://github.com/Jesse-njx/dsh-chatnode-wechat)（MIT）。
> 逐字段对齐记录见 [docs/porting-notes.md](docs/porting-notes.md)，完整署名见 LICENSE。

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
    allowFrom: ["<你的微信id>"]        # 硬白名单，必填，无宽容默认
    defaultMode: life-butler          # /new 不带模式时的默认预设
    cwd: /path/to/workspace           # /new 会话的默认工作目录
    approvalTimeoutSec: 600           # 审批超时默认拒绝（秒）
    maxMessageChars: 2000             # 微信单条气泡上限
    minSendIntervalMs: 5000           # 出站最小发送间隔（限流卫生）
    rateLimitBackoffSecs: [10, 30, 60] # errcode -12 限流退避阶梯（秒）
    sessionExpiredPauseMin: 60        # errcode -14 会话过期出站暂停（分钟）
    thinkingDigestSec: 10             # 思考摘要刷新间隔（active turn 内）
    menuTimeoutSec: 60                # 编号菜单有效期（秒）
    markdownMode: passthrough         # passthrough | filter | plain
    progressToolPrefixes: []          # 进度卡片工具前缀（默认 [] = 关闭，后端暂不支持）
    fileThresholdChars: 0             # 回复超过该字数 → 摘要 + .md 附件（默认 0=关闭；bot 外发媒体被客户端渲染门禁锁定，见 porting-notes §6.1）
    notifyOnComplete: false           # 任务完成主动推送（仅 ≥ notifyMinTurnSec 的任务）
    notifyMinTurnSec: 300             # 完成推送的最小任务时长（秒）
    mediaRetentionDays: 30            # 媒体/导出文件留存天数
    allowGroups: []                   # 群聊白名单: [{roomId, allowFrom:[...]}]
    cardMode: off                     # 长图模式: off | long
    chromePath: ''                    # 长图渲染的 Chrome 路径（默认自动探测）
```

`allowFrom` **必填**：白名单外的消息记日志后丢弃，**绝不喂给模型**。

> 相对 0.1.x 的破坏性配置变更：移除 `digestIntervalSec` 与 `sendChunkDelayMs`——
> 节拍由 `minSendIntervalMs`（队列）承担，进度可见性由 `thinkingDigestSec` 承担。见 [CHANGELOG.md](CHANGELOG.md)。

## 微信命令

`/modes` · `/new [模式] <prompt>` · `/sessions` · `/use N` · `/stop` · `/status` ·
`/model` · `/workspace` · `/retry` · `/close` · `/thinking` · `/export` · `/card` ·
`/yes` · `/no` · `/help [命令]`

- `/modes` 列出**全部**模式，每项带中文名称与说明、可复制 `/new <id>`，**回复编号直接创建**（`menuTimeoutSec` 内有效）
- `/model` `/workspace` 是桥内偏好，持久化在 `$DSH_HOME/storages/dsh-wechat-bridge/state.json`，只影响 `/new` 新建的会话，不污染 DSH 全局默认
- `//` 开头的文本原样转发给 agent（`/` 开头内容想当普通消息时的转义口）
- 会话按 peer 绑定（多好友互不串线）；微信创建的会话在 DSH 侧栏带 🟢 徽标（`origin: 'wechat'`，需 harness 补丁）
- 回复超过 `fileThresholdChars` 自动转 `.md` 附件（摘要 + 完整文件）；`/export` 导出会话全文；`/thinking` 开关思考原文

## Markdown 策略

微信客户端对 iLink 机器人消息**支持 Markdown 渲染**（h1–h4 标题、粗体、列表、表格、代码块、行内代码、分隔线、引用块——已端到端实测）。三种策略：

- `passthrough`（默认）：模型 Markdown 原样发送，仅 `![图](url)` 转为可点 URL
- `filter`：官方流式过滤器（逐字段移植，见移植对照表）——剥离 CJK 斜体、h5/h6、行内图片，跨客户端最保守
- `plain`：全剥离，给完全不渲染的客户端用

## 进度与限流

微信通道有限流且无公开数字，因此出站队列**自适应**而不是假设额度：

- 单条串行队列，优先级排序（审批 > 终态 > 正文 > 进度）；进度类消息按 key 合并（新摘要顶掉未发出的旧摘要）
- 最小发送间隔 `minSendIntervalMs`；`-12` 限流 → 阶梯退避；`-14` 会话过期 → 整体暂停（官方 session-guard 语义）
- 思考心跳 `thinkingDigestSec` 一次，且**有进展才发**；工具调用进度走聚合摘要（防骚扰）
- 进度卡片（type 11/12）：**默认关闭**（`progressToolPrefixes: []`）。send-only 探针已实测当前微信后端对卡片 item 静默丢弃（不投递不报错）——后端支持后可把工具前缀（如 `bash/fs/web`）填回来启用；卡片协议本身已按官方逐字段对齐，随时可开
- typing 票据缓存 24h（官方 config-cache 语义），发送链路不再每次多打 2 次 API

> 已知行为：从 DSH Web 端驱动某个微信会话时，回合进度与回复**也会**同步推送到微信（同一会话一条流，两端可见）。这是特性而非缺陷；如需"另一端操作时微信静默"，可加配置开关。

## 安全须知

- iLink 每个 bot token 只允许**一个**认证轮询者；同一微信号再跑其他微信桥会互相 403
- 本通道经腾讯微信机器人网关，腾讯有可能限制账号——建议使用愿意承担风险的微信号
- 微信消息只能进 DSH 会话流（`source.kind='plugin'`），**不能执行 shell**
- `allowFrom` 是安全边界，切勿随意放宽

## 开发

```sh
pnpm verify              # build → bundle → node --check → 测试（63 项）
scripts/dry-run.sh       # 隔离干跑：临时 DSH_HOME 真启动 web 组合，验证桥挂载与状态端点，不动生产
scripts/dry-run.sh --check  # 同上，自动退出（CI）
```

改代码后先 `pnpm verify` 再 `scripts/dry-run.sh --check`，全绿才允许重启生产 web profile（一次改对、一次重启）。

## 里程碑状态

- [x] M0 骨架：双插件结构、配置 schema、挂载验证
- [x] M1 通道：iLink 客户端（QR 登录 / 长轮询 / 文本收发 / typing）＋登录 CLI
- [x] M2 桥接：白名单 / 多模式动态路由 / 审批 / 长文分段 + 测试
- [x] M3 图片进会话：CDN 下载 + AES-128-ECB 解密 + 落本机工作区
- [x] M3 Web 设置面板：网关状态/扫码配对/白名单/模式一览
- [x] M4 移动端体验：/modes 全量中文 + /model /workspace /retry /close、🟢 徽标、per-peer 绑定、Markdown 策略、思考心跳、工具进度卡片、限流感知出站队列、持久化幂等
- [x] P1：FILE 附件通道（CDN 上传移植+探针验证）、/thinking 开关、完成主动推送（默认关，端上可见性待实测）、媒体留存清理
- [x] P2：`origin='wechat'` 结构化徽标（harness 补丁，见 docs/harness-patch.md）、群聊（room 两级白名单+静默，待群内实测）、长图骨架（/card，默认 off）

> **发图片（bot→微信）现状（2026-08-16 活体判定）**：服务器 ack、CDN 内容自取一致，
> 但微信客户端对 bot 外发媒体 item **静默丢弃**（3 个形状变体手机核对均未收到；
> item 级字段镜像则被服务器 prepare failed）。根因：客户端只渲染其自生成的 404 字节
> 签名结构，服务器签发结构（504 字节）不识别——bot 侧无解，参考实现同病。
> 重测工具与判定边界见 [docs/porting-notes.md](docs/porting-notes.md) §6.1。
> **入站图片（用户→bot）生产端到端可用**：照片下载 + AES 解密落盘实测通过。

> 本插件为 **web profile 专用**（client 面板 + webServer 端点）；headless 可加载网关但无设置面板。

## 发布前提（发布前需 Kairos 决策）

代码与构建已 publish-ready。**发布到 npm / 公共仓库属云端行为**，与 kairos-life「永不云端」红线冲突——是否开源发布、以什么形式，由 Kairos 单独决策后执行；未决策前仅在本仓库内维护。

## 文档

- [CHANGELOG.md](CHANGELOG.md)
- [docs/porting-notes.md](docs/porting-notes.md) — 相对 Tencent/openclaw-weixin 的逐字段移植对照表（升级 diff 清单）
- [docs/upgrade-runbook.md](docs/upgrade-runbook.md) — 生产上线手册（离线验证 → 重启 → 微信端验收清单 → 回滚）
- [docs/harness-patch.md](docs/harness-patch.md) — DSH harness 补丁记录（origin 徽标，升级 DSH 后需重打）

## License

MIT — 完整署名见 [LICENSE](LICENSE)（协议客户端与 Markdown 过滤器源自 Tencent/openclaw-weixin；架构参照 dsh-chatnode-wechat）。
