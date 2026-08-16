# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本。
发布前版本 `<1.0.0`：破坏性变更会在 Minor 版本体现。

## [Unreleased] — WeChat UX 大版本

### 新增

- **`/modes` 全量模式**：列出全部 agent 预设（含中文名称与说明，读 DSH `agentPresets` 服务），
  每项附可复制快捷命令 `/new <id>`，且**回复编号直接创建**（菜单 60 秒内有效）。
- **`/model`**：桥内模型偏好。列表选择（供应商→模型）或显式 `/model <provider>/<model>`；
  `/model default` 恢复跟随 DSH 默认。仅对 `/new` 新建会话生效，持久化到桥状态文件。
- **`/workspace`**：桥内工作区偏好，仅允许选择 DSH 已注册工作区（安全默认）；
  `/workspace default` 恢复默认。仅对 `/new` 生效，持久化。
- **`/retry`**：重放本 peer 最后一条任务；**`/close`**：归档当前会话并解绑。
- **`//` 转义**：以 `//` 开头的文本原样发给 agent（`/` 开头不再必然被当作命令）。
- **`/help` 注册表化**：命令注册表是单一事实源，`/help` 与未知命令提示自动同步；`/help <命令>` 看详情。
- **会话来源徽标**：微信创建的会话写入持久化 `origin: 'wechat'` 头部，DSH 侧栏渲染 🟢 徽标
  （悬停"来自微信"；需 harness 补丁，见 `docs/harness-patch.md`）。取代早期方案——不再写
  `🟢 微信 ·` 标题前缀，会话标题回归干净的首句。
- **`/modes` 精简**：每模式一行（编号+中文名+id+22 字截断说明+默认标记），整体约 370 字；
  去掉逐条 `/new` 行（微信复制整条气泡，逐行命令无选择性复制价值）。
- **FILE 附件通道（P1）**：CDN 上传全流程逐字段移植（`docs/porting-notes.md §6`）。
  全矩阵探针证实本后端对 bot 外发媒体"消息可送达、内容取流不通"（官方/nanobot 参考实现同病），
  故 `fileThresholdChars` **默认 0=关闭**；`/export` 保留（后端支持后立即可用）。
- **`/thinking` 开关（P1）**：`/thinking on|off`（per-peer 持久化），开启后思考心跳附带最近 60 字原文。
- **任务完成主动推送（P1）**：`notifyOnComplete`（默认关）+ `notifyMinTurnSec`（默认 300s）；
  长任务完成后主动发完成摘要。存储 token 主动发送已探针 ack，端上可见性待实测。
- **媒体留存清理（P1）**：`mediaRetentionDays`（默认 30）每日清理媒体/导出文件。
- **群聊支持（P2）**：`allowGroups: [{roomId, allowFrom}]` room 级两层白名单；群内静默
  （无心跳/typing/进度卡片，只回命令结果与最终答复）；每 room 一个活跃会话。
  **实测判定（2026-08-16）**：iLink 机器人身份无法被拉入普通微信群（腾讯侧限制，
  官方参考实现 group_id 未实现、同协议项目文档同样标注），配置保持就绪待群事件投递开放。
- **长图骨架（P2）**：`cardMode: 'off'|'long'`（默认 off）+ `/card` 命令——Markdown→HTML→
  Chrome headless 两段式截图→IMAGE 发送；Chrome 路径自动探测（可配 `chromePath`）。
- **多好友绑定**：会话按 peer 绑定（持久化），回复/审批路由到会话所属 peer；context token 按 peer 保存。
- **Markdown 保真策略**：微信客户端对 iLink 机器人消息支持 Markdown 渲染（实测全格式通过）。
  默认 `passthrough`（仅把 `![图](url)` 转成可点 URL）；可选 `filter`（官方过滤器逐字段移植）与 `plain`。
- **思考进度**：`reasoning-delta` 聚合为 `🤔 思考中…（N 字）` 心跳（`thinkingDigestSec`，默认 10s）；
  `todo/write` 变化推任务清单快照；`turn/end` 错误附 `/retry` 引导。
- **工具进度卡片**：`TOOL_CALL_START/RESULT`（type 11/12）按官方 `reply-progress-sender` 逐字段对齐发送；
  **默认关闭**（`progressToolPrefixes: []`）——send-only 探针实测当前微信后端对卡片 item
  静默丢弃（200 空响应、不投递），手机端已核对确认无卡片显示；后端支持后填前缀即可启用。
  其余工具只进聚合心跳，防骚扰。
- **限流感知出站队列**：单一串行队列 + 最小发送间隔（默认 5s）+ 优先级（审批>终态>正文>进度）
  + 进度合并（coalesce）+ `-12` 指数退避（10/30/60s）+ `-14` 全局暂停 1h（对齐官方 session-guard）。
- **typing ticket 缓存**：24h TTL + 指数退避（官方 config-cache 语义），不再每次发送都调 getConfig。
- **入站幂等持久化**：seen 集合落盘（TTL 10min / cap 2000），重启后游标重放不再重复执行任务。
- **审批参数摘要**：经 callId 反查会话日志中的工具参数，审批文案展示参数摘要。
- **图片回显修正**：微信端只回「已收到 N 张图片」，不再回显本机绝对路径。
- **Web 面板扩展**：模式中文名、桥内偏好（模型/工作区）、Markdown 策略、出站队列/限流状态、最近发送错误。

### 变更

- **移除配置** `digestIntervalSec`、`sendChunkDelayMs`（心跳与节流由 `thinkingDigestSec` 与
  `minSendIntervalMs` 取代）——**破坏性配置变更**，见 README 配置表。
- 默认心跳语义：active turn 内按 `thinkingDigestSec` 刷新思考摘要；无新进展不重复打扰。
- `/sessions`、`/use` 现在只列本 peer 的会话（多好友隔离）。
- `sendText` 返回结构化 `SendResult`（ok/ret/errcode/messageId），发送错误不再被吞。

### 修复

- **外发媒体 `full_url` 相对路径缺陷**：`cdnBaseUrl` 配置默认值为空时，媒体 item 的
  `full_url` 被拼成 `/download?...` 相对路径；现 Config 默认 `WEIXIN_CDN_BASE_URL`，
  且 `uploadAndSendMedia` 有兜底（`cdnBaseUrl || WEIXIN_CDN_BASE_URL`）。媒体 item 组装
  抽为纯函数 `buildOutboundMediaItem`（`src/gateway/upload.ts`），单测锁定官方形状
  （44 字符 key、无 encrypt_type、绝对 full_url、image.aeskey/mid_size、file.len）。
- **媒体外发探针工具**：`scripts/probe-media.mjs` —— 生产 lib 产物端到端探针
  （getUploadUrl → AES-ECB → CDN 上传 → sendMessage），形状变体
  current/official + item 字段二分 + context_token + 服务器自下载闭环；§6.1 重测工具。
- **`run_id` 协议缺口**：官方 `buildTextMessageReq` 的 `run_id` 字段此前漏移植——现已全链路补上
  （网关 `InboundEvent.runId` → per-peer 保存 → 出站 `sendMessage` 携带），工具进度卡片与 run 的关联对齐官方。
- 独立代码审查（子代理全量 diff）发现并修复：思考心跳空状态刷屏（H1）；模型菜单跨 peer 串线（M1）；
  重启后旧会话不可恢复（M2，改查 sessionPersistence + 激活提示）；`/status` token 字段名错误（M3）；
  `/model default` 空字符串阻断配置级回退（M4，`setPrefs` 空串=删除）；工具卡片跨调用串名（L1）；
  面板错误横幅不随成功清除（L2）；typing 票据跨用户复用（L3，改 per-user 缓存）；`/close` 不先取消运行中
  agent（L4）；暂停 sleep 未 unref（L5）；菜单编号越界即关菜单（L6，改为保留菜单）；死参数/死代码清理（L7/L8）。
- **侧栏 🟢 徽标不显示的根因**：`dsh-client-ui-workspace` 的 `sessionNode()` 以白名单拷贝字段，
  `origin` 未透传到行节点——已在 harness 补丁中补上（见 docs/harness-patch.md #6，与徽标渲染一并）。
- 状态与 seen 文件 dispose 时 flush 被跳过（先置 disposed 后 flush）——已修，测试覆盖。
- 出站队列在同步批量入队时的排序/合并竞态——泵启动改为微任务。

## [0.1.0] - 2026-08-15

- M0 骨架（双插件、配置 schema、挂载验证）
- M1 通道：iLink 客户端（QR 登录 / 长轮询 / 文本收发 / typing）+ 登录 CLI
- M2 桥接：白名单 / 多模式动态路由 / 审批 / 长文分段 + 测试
- M3 图片进会话（CDN 下载 + AES-128-ECB 解密）+ Web 设置面板
