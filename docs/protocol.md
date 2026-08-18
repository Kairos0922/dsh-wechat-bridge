# 协议规格（iLink + 媒体）

> 本文是 dsh-wechat-bridge 对腾讯 iLink 微信机器人协议的**正向规格**——常量、
> 消息结构、媒体流程与错误语义的权威定义。维护者升级上游
> [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 时按本表逐项
> diff；历史移植对照与探针矩阵见 [porting-notes.md](porting-notes.md)（维护者内部）。

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
| `ret: -2` + `errmsg="prepare failed"` | **stale session（context_token 过期）**——长任务/久无互动后规律出现（2026-08-18 事故即此） | 删除缓存 token → **无 token 重发一次**（iLink 接受降级发送）→ 仍失败则退避重试 |
| `ret: -2` + `errmsg="unknown error"` | 同上（hermes 分类器同款） | 同上 |
| `ret: -2` + `errmsg="rate limited"/"freq limit"`（及 -2 其他文本） | 限流（频率限制） | 退避重试（10s→30s→60s，预算 5 次） |
| `errcode: -12` | 限流（官方 `RATE_LIMIT_ERRCODE`） | 同上退避 |
| `errcode: -14` | 会话过期（`SESSION_EXPIRED_ERRCODE`） | 队列整体暂停 60min（对齐官方 session-guard） |
| CDN `x-error-code` | CDN 侧校验失败（如 -5102031 = 内容非法） | 立即停止，不重试 |

分类实现：`classifySendFailure()`（src/gateway/types.ts）→ `SendResult.failureClass`
（`stale-session` / `rate-limit` / `session-expired` / `generic`）→ dispatch 层做
tokenless 恢复（compare-and-delete 防并发刷新被误删），outbox 层做退避。

> `ret: -2` 曾被误读为"媒体形状被服务器拒绝"——实际是限流/会话类业务错误
> （openclaw 官方 issue #216 印证：连续媒体发送触发，paced 即成功；hermes
> agent issue #17228 + PR #80426 确认 "prepare failed" = stale session）。
> 一个数字两种含义，**必须读 errmsg 文本分派**。

## 6. context_token 语义

- 入站消息携带服务器签发的 `context_token`；bridge 按用户持久化（state.json），
  出站回带，使回复关联到微信对话窗口。
- **必须使用"当前入站消息"的 token，复用历史 token 会失效**（逆向文档与实测）；
  长任务执行超过时效即触发 §5 的 "prepare failed"。
- 会话过期（-14 / -2 + prepare failed / unknown error）时**去掉** context_token 重发
  可恢复（iLink 接受 tokenless 降级发送；2026-08-18 起自动执行：compare-and-delete +
  一次 tokenless 重发，不消耗出站重试预算，后续重试自然 tokenless）。
- 缺失/过期 context_token 是 ack 后"消息不投递"的已知因素之一，但不是投递充分条件。

## 7. 安全边界（bridge 强制）

- **白名单**：`allowFrom` 配置 ∪ 所有扫码配对确认的用户（持久化）。白名单外消息
  只记日志，绝不喂给模型。
- **审批**：危险操作经 `dsh-user-approval` 桥，微信 `/yes` `/no` 或回复编号即决；
  只回答**发起者本人**的待审批请求。
- **媒体内容**：入站仅接受 CDN 白名单域名；`media_dir` 限定工作区。

## 8. 限流卫生

- 出站最小间隔 `minSendIntervalMs`（默认 5000ms）全局限速；限流类错误（-12 或
  -2 + rate 文本）指数退避 10s→30s→60s（预算 5 次），成功即复位。
- 无公开限流数字；连续高频发送（探针轰炸）曾触发服务器封禁——生产通道禁止试探性
  发送，实验走 `scripts/probe-media.mjs`（带 `--consent` 门）+ 用户明示窗口。
- 审批提示（🔐 需要你的确认）发送失败不静默：标记待重推，用户下一条入站消息
  到达（= 通道恢复 + 用户在场）时自动重推，等待窗口内保证送达机会（2026-08-18 起）。
