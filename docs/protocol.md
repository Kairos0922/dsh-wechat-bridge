# 协议规格（iLink + 媒体）

> 本文是 dsh-wechat-bridge 对腾讯 iLink 微信机器人协议的**正向规格**——常量、
> 消息结构、媒体流程与错误语义的权威定义。维护者升级上游
> [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 时按本表逐项
> diff；历史移植对照与探针矩阵见 [porting-notes.md](porting-notes.md)。

## 1. 通道模型

- **传输**：HTTPS 长轮询（`/ilink/bot/getupdates`，超时 35s），游标（`buf`）推进去重。
- **鉴权**：`Authorization: Bearer <bot_token>`（登录后签发）+ `AuthorizationType: ilink_bot_token` +
  `X-WECHAT-UIN`（base64(随机 uint32 十进制)，防重放）+ `iLink-App-Id: bot` +
  `iLink-App-ClientVersion`（0x00MMNNPP 编码，例 2.4.6 → 132102）。
- **信封**：每个 API 请求体携带 `base_info = { channel_version, bot_agent? }`。
- **媒体**：全部经 CDN（`novac2c.cdn.weixin.qq.com/c2c`）传输，内容 AES-128-ECB(PKCS7) 加密。

## 2. 类型常量（发送消息与上传共用）

| 常量 | 值 | 说明 |
|---|---|---|
| `ITEM_TEXT` | 1 | 文本 |
| `ITEM_IMAGE` | 2 | 图片 |
| `ITEM_VOICE` | 3 | 语音（**bot 外发客户端不渲染**，勿用） |
| `ITEM_FILE` | 4 | 文件附件 |
| `ITEM_VIDEO` | 5 | 视频 |
| `ITEM_TOOL_CALL_START` / `RESULT` | 11 / 12 | 工具进度卡片（微信后端当前静默丢弃） |
| `UPLOAD_MEDIA_IMAGE` | 1 | getUploadUrl 的 `media_type` |
| `UPLOAD_MEDIA_VIDEO` | 2 | 同上 |
| `UPLOAD_MEDIA_FILE` | 3 | 同上 |
| `UPLOAD_MEDIA_VOICE` | 4 | 同上 |
| `MESSAGE_TYPE_BOT` | 2 | `msg.message_type` |
| `MESSAGE_STATE_FINISH` | 2 | `msg.message_state` |

> ⚠️ 常量必须以 `src/gateway/types.ts` 的 `ITEM_*` / `UPLOAD_MEDIA_*` 为准，
> **禁止手写数字**（历史上将 VIDEO 误写为 3=VOICE，导致服务器 ack 但客户端静默丢弃）。

## 3. 消息信封（sendMessage / 入站消息共用 `msg` 结构）

```
msg = {
  from_user_id: "" | sender,
  to_user_id:  目标 id,
  client_id:   客户端生成的消息 id（出站必须唯一），
  message_type: MESSAGE_TYPE_BOT（出站）| USER（入站），
  message_state: MESSAGE_STATE_FINISH,
  item_list:    [MessageItem, ...]（出站单条 item 一条消息），
  context_token?: 会话上下文令牌（见 §6），
  run_id?:      任务 id（进度卡片关联），
}
```

### MessageItem（出站官方形状，端上验证通过）

| item 类型 | 结构 | 端上状态 |
|---|---|---|
| 文本 | `{ type: 1, text_item: { text } }` | ✅ |
| 图片 | `{ type: 2, image_item: { media, mid_size } }` | ✅ 正常显示 |
| 文件 | `{ type: 4, file_item: { media, file_name, len } }` | ✅ 可打开 |
| 视频 | `{ type: 5, video_item: { media, video_size } }` | ✅ 可播放（无需缩略图） |
| 语音 | `{ type: 3, voice_item: {...} }` | ❌ 客户端不渲染 |

`media`（CDN 引用）：

```
media = {
  encrypt_query_param: <CDN 上传响应头 x-encrypted-param>，  ← 下载引用（见 §4）
  aes_key: base64(hex 字符串)（44 字符）——不是 base64(原始字节)，
  encrypt_type: 1,
}
```

- `mid_size` / `video_size`：密文尺寸（`aesEcbPaddedSize(明文尺寸)`）。
- `file_item.len`：**明文**尺寸（字符串）。
- 出站 item **不带** `full_url`、`image_item.aeskey`、`create_time_ms` 等客户端字段
  ——服务器对 bot 出站有独立校验，附加字段导致 prepare failed 或静默丢弃。

## 4. 媒体收发流程

### 出站（bot → 用户）

1. `getUploadUrl`：`filekey`(32 hex) + `media_type` + `to_user_id` + `rawsize` +
   `rawfilemd5` + `filesize`(= 密文尺寸) + `no_need_thumb: true` + `aeskey`(hex)。
2. 本地 AES-128-ECB 加密明文（随机 16 字节 key）。
3. POST 密文到 `upload_full_url`（或 `upload_param` 构造的 `/c2c/upload?...&filekey=`）：
   `Content-Type: application/octet-stream`。
4. 响应头 **`x-encrypted-param`** = 下载引用，填入 `media.encrypt_query_param`。
5. `sendMessage` 携带 §3 的 item（caption 文本先行，独立消息）。

> 实测（2026-08-17）：`getUploadUrl` 的 `upload_param` **不是**客户端认识的下载引用
> （消息被静默丢弃）；下载 URL 由客户端按其自身逻辑构造（含客户端侧 `taskid`），
> bot 不需要也无法生成。

### 入站（用户 → bot）

1. 长轮询收到 `item_list` 中的媒体 item（`media.full_url` = 服务器签发的完整下载 URL）。
2. 下载 → 按 `media.aes_key` 解密 → 落盘 `mediaDir/<session>/wechat-*.{jpg,...}`。
3. 图片进会话（本地路径交给 agent）；视频/文件当前记录不落盘。

## 5. 错误码语义

| 码 | 语义 | 处置 |
|---|---|---|
| `ret: 0` | 成功（ack；**不等于客户端已渲染**） | — |
| `ret: -2` + `errmsg="prepare failed"` | **会话窗口出站配额耗尽**——服务器对每个"用户入站窗口"（自用户上一条入站消息起算）允许约 10 次成功出站，超出即 `prepare failed`，直到用户下一条入站消息重置窗口（2026-08-18 事故归因为 token 时效，**2026-08-19 三次实测修正为窗口配额模型**：每次窗口恰好第 11 条失败） | **立即弃投，不重试、不退避**：非 must 条目静默跳过（心跳/进度/上下文行），must 条目（最终答案/审批/错误通知）入恢复重推队列，用户下一条入站消息时重推（此时窗口已重置）。tokenless 重发**实测 5/5 失败**，不再作为恢复手段 |
| `ret: -2` + `errmsg="unknown error"` | 同上（hermes 分类器同款） | 同上（会话窗口配额） |
| `ret: -2` + `errmsg="rate limited"/"freq limit"`（及 -2 其他文本） | 限流（频率限制） | 退避重试（10s→30s→60s，预算 5 次） |
| `errcode: -12` | 限流（官方 `RATE_LIMIT_ERRCODE`） | 同上退避 |
| `errcode: -14` | 会话过期（`SESSION_EXPIRED_ERRCODE`） | 队列整体暂停 60min（对齐官方 session-guard） |
| CDN `x-error-code` | CDN 侧校验失败（如 -5102031 = 内容非法） | 立即停止，不重试 |

分类实现：`classifySendFailure()`（src/gateway/types.ts）→ `SendResult.failureClass`
（`stale-session` / `rate-limit` / `session-expired` / `generic`）→ dispatch 层保留
一次 tokenless 尝试（best-effort），outbox 层按类处置：stale-session 立即弃投
（不暂停队列），限流退避，-14 暂停。

> **窗口配额模型（2026-08-19 实测证据，修正 08-18 的"token 时效"归因）**：
> `prepare failed` 不是 token 时效也不是形状被拒——是**每用户入站窗口的出站
> 发送预算**。实测三次完全一致：每次用户入站后恰好 10 条成功、第 11 条失败，
> 失败持续到用户下一条入站消息（窗口重置）。桥端应对：
> - **配额会计**：outbox 按 peer 计数窗口内成功发送（`sessionWindowSendMax`，
>   默认 10），入站消息重置（`resetWindow`）；
> - **must 豁免**：最终答案 / 审批提示 / 错误·停止通知 / critical 重推
>   （`OUTBOX_PRIORITY.must`）不受配额限制，永远尝试发送；
> - **非 must 让位**：心跳 / todo 快照 / 上下文行在窗口剩余 ≤3 时源头停发
>   （`HEARTBEAT_QUOTA_RESERVE`），超配额后由 outbox 直接跳过（drop 'quota'）；
> - **最终答案整段重推**：多分块答案任一块失败时，整段文本进入恢复重推队列，
>   用户下一条入站消息到达即重新分块补发（绝不出现只有 "(2/2)" 的残缺答案）。

> `ret: -2` 曾被误读为"媒体形状被服务器拒绝"——实际是限流/会话类业务错误
> （openclaw 官方 issue #216 印证：连续媒体发送触发，paced 即成功）。一个数字
> 多种含义，**必须读 errmsg 文本 + failureClass 分派**。

## 6. context_token 语义

- 入站消息携带服务器签发的 `context_token`；bridge 按用户持久化（state.json），
  出站回带，使回复关联到微信对话窗口。
- **必须使用"当前入站消息"的 token，复用历史 token 会失效**（逆向文档与实测）；
  长任务执行超过窗口即触发 §5 的 "prepare failed"（窗口配额模型：token 与
  ~10 条出站预算绑定，超出后同 token 的一切出站失败）。
- **tokenless 降级实测不恢复**（2026-08-18/19 观测 5/5 失败——服务器不接受
  无 token 发送作为窗口耗尽后的恢复手段）。恢复唯一路径：用户下一条入站消息
  （携带新 token + 新窗口）。
- 缺失/过期 context_token 是 ack 后"消息不投递"的已知因素之一，但不是投递充分条件。
- **typing 指标**（独立 `sendTyping` API，不经 `sendMessage`）不消耗窗口配额，
  窗口耗尽后仍可维持"正在输入"存活信号（2026-08-19 起观测验证中，
  `typing-failed` 事件日志）。

## 7. 安全边界（bridge 强制）

- **白名单**：`allowFrom` 配置 ∪ 所有扫码配对确认的用户（持久化）。白名单外消息
  只记日志，绝不喂给模型。
- **审批**：危险操作经 `dsh-user-approval` 桥，微信 `/yes` `/no` 或回复编号即决；
  只回答**发起者本人**的待审批请求。
- **媒体内容**：入站媒体仅接受 CDN 域白名单（`*.cdn.weixin.qq.com`）+ HTTPS +
  30s 超时 + 20MB 上限，**不自动跟随未校验重定向**；`media_dir` 限定工作区。

## 8. 限流卫生

- 出站最小间隔 `minSendIntervalMs`（默认 5000ms）全局限速；限流类错误（-12 或
  -2 + rate 文本）指数退避 10s→30s→60s（预算 5 次），成功即复位。
- 无公开限流数字；请避免高频连续发送，可能触发服务端限流——生产通道禁止无许可的
  试探性发送，实验走 `scripts/probe-media.mjs`（带 `--consent` 门）+ 用户明示窗口。
- 审批提示（🔐 需要你的确认）发送失败不静默：标记待重推，用户下一条入站消息
  到达（= 通道恢复 + 用户在场）时自动重推，等待窗口内保证送达机会（2026-08-18 起）。

## 9. 投递语义（2026-09-09 定案）

- **at-least-once**：`get_updates_buf` 游标在**拉取确认**时推进（与官方 monitor
  同构——sync buf 是拉取语义，不是处理确认）；消息级去重由 `seen.json`
  （按 `message_id`，按 bot 身份隔离）承担。崩溃窗口内最多重复处理一条，
  绝不跳过。
- **不确定发送结果**：发送请求超时且没有服务端回执时，结果记为 `uncertain`，不得自动重发（服务端可能已经投递，盲重发会造成重复）。仅 DNS/TCP/TLS 等明确未建立连接的失败可自动重试；下一次该用户入站时，agent 会收到一次系统备注，由对话自行恢复。
- **会话窗口配额**：服务器对每用户入站窗口允许约 10 条成功出站
  （`sessionWindowSendMax`），非 must 条目超配额直接跳过；must（最终答案/
  审批/错误通知）豁免并进入恢复重推队列，用户下一条入站消息触发整段重发。

## 10. 能力 ↔ 证明映射（契约执法）

> 能力行必须由测试或已归档验证记录证明；`verify` 链保证常量与文档不漂移。
> 维护规则：改 `src/gateway/types.ts` 常量或媒体流程时，同步更新本表，
> 否则视同破坏契约。

| 能力行 | 证明 |
|---|---|
| `ITEM_VIDEO=5`（外发视频） | `test/upload.test.ts`（buildOutboundMediaItem VIDEO）+ 2026-08-17 端上验证（verification-records） |
| 出站媒体形状（encrypt_type=1、aes_key=base64-of-hex、mid_size/video_size/len） | `test/upload.test.ts` 镜像官方形状 |
| `ITEM_TOOL_CALL_START/RESULT=11/12` | `test/outbound.test.ts`（常量对齐 + 卡片构建） |
| StreamingMarkdownFilter 行为等价 | `test/markdown.test.ts`（官方测试向量镜像） |
| AES-128-ECB PKCS7 padding 公式 | `test/upload.test.ts`（aesEcbPaddedSize） |
| 入站图片两形态 aeskey 解析 | `test/media.test.ts` |
| `sanitizeBotAgent` UA 语法/截断 | `test/upstream-alignment.test.ts` |
| `classifyFetchError` 错误分类 | `test/upstream-alignment.test.ts` |
| QR `local_token_list` 上报 | `test/upstream-alignment.test.ts` |
| mime 表覆盖 | `test/upstream-alignment.test.ts` |
| 远程媒体私网拒绝 | `test/upstream-alignment.test.ts` |
