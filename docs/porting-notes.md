# 移植对照表（porting notes）

> 纪律（AGENTS.md A 类）：移植外部协议/实现时**逐字段、逐行为对齐官方源码**，禁止"按需裁剪"；
> 对齐结论写进本表，升级上游时逐项 diff。上游 = [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。

## 1. StreamingMarkdownFilter — `src/node/markdown.ts` ← `src/messaging/markdown-filter.ts`

| 上游 | 本仓库 | 对齐方式 |
|---|---|---|
| `StreamingMarkdownFilter` 状态机（sol/fence/inl、feed/flush、pump/pumpFence/pumpSOL/pumpBody/pumpInline） | 同名类，逐方法移植 | 行为保持；仅移除上游未使用的 `FENCE_RE` 常量 |
| 保留：代码围栏、行内代码、表格、分隔线、粗体、非 CJK 斜体/粗斜体、引用块、h1–h4 | 同 | 逐字符级一致 |
| 剥离：CJK 斜体/粗斜体（仅去标记留内容）、h5/h6（去标记留内容）、`![alt](url)` 图片 | 同 | 逐字符级一致 |
| 流式 chunk 不变性（one-shot = char-by-char = random chunks） | `test/markdown.test.ts` 镜像官方测试向量 | 向量共享证明行为等价 |
| 偏差：官方在 `sendWeixinOutbound` 对全部外发文本套 filter；本插件默认 `passthrough`（实测微信端全格式渲染），filter 为可选策略 | `renderForWechat(mode)` | 有意为之，见 README「Markdown 策略」 |

## 2. 工具调用进度卡片 — `src/node/outbound.ts` ← `src/messaging/reply-progress-sender.ts` + `src/api/types.ts`

| 上游 | 本仓库 | 对齐方式 |
|---|---|---|
| `MessageItemType.TOOL_CALL_START = 11` / `TOOL_CALL_RESULT = 12` | `ITEM_TOOL_CALL_START/RESULT`（gateway/types.ts） | 常量逐字段对齐 |
| `tool_call_start_item: { tool_name, tool_call_id }` | 同 | 字段名/语义一致 |
| `tool_call_result_item: { tool_name, tool_call_id, status }` | 同 | `status` 归一化：completed / failed / blocked / unknown → 本仓库 error→failed，否则 completed |
| `create_time_ms` / `is_completed` 随 item 发送 | 同 | 一致 |
| 官方每个 tool 事件都发卡片 | 本仓库按 `progressToolPrefixes` 过滤；**默认 `[]` = 关闭**（探针+手机核对：当前后端对卡片 item 静默丢弃，200 空响应不投递），后端支持后填前缀启用 | 有意偏差：降级默认 + 限流防护，见 README |
| 官方 `sendChain` 串行队列 | 本仓库 `Outbox`（优先级 + 合并 + 退避） | 语义超集：串行不变量保持 |

## 3. typing ticket 缓存 — `src/gateway/index.ts` ← `src/api/config-cache.ts`

| 上游 | 本仓库 | 对齐方式 |
|---|---|---|
| `CONFIG_CACHE_TTL_MS = 24h` | 同（`expiresAt`） | 一致 |
| `CONFIG_CACHE_INITIAL_RETRY_MS = 2s`、`MAX_RETRY_MS = 1h`（指数退避） | 同（`ticketBackoffMs` 2_000→×2→上限 1h） | 一致 |
| 每用户 `Map<user, entry>` + 24h 内随机刷新 | 单账号单票据缓存（桥只服务一个 bot） | 有意简化：语义不变 |
| 失败后 `nextFetchAt` 内不重试 | 同（`ticketRetryAt`） | 一致 |

## 4. 会话过期暂停 — `src/node/outbox.ts` ← `src/api/session-guard.ts`

| 上游 | 本仓库 | 对齐方式 |
|---|---|---|
| `STALE_TOKEN_ERRCODE = -14` | `SESSION_EXPIRED_ERRCODE = -14` | 一致 |
| `SESSION_PAUSE_DURATION_MS = 1h`，暂停**全部收发** API 调用 | 出站队列暂停 1h（`sessionExpiredPauseMin`，默认 60min）；轮询侧沿用网关原有 10min 退避 + 凭证重读 | 语义一致；收发两侧分别实现 |

## 5. 限流错误码

| 上游 | 本仓库 | 对齐方式 |
|---|---|---|
| 官方对发送侧 `-12` **不重试、只记日志** | `Outbox` 对 `-12` 做指数退避（10/30/60s，成功复位） | 有意增强：官方是聊天机器人通用节奏，本插件要跑长任务，必须有退避；`RATE_LIMIT_ERRCODE = -12` 常量对齐 |

## 6. CDN 上传（图片/文件外发）— 已实现（P1，`src/gateway/upload.ts` + `gateway/index.ts`）

上游 `src/cdn/upload.ts` + `src/cdn/aes-ecb.ts` + `src/cdn/cdn-upload.ts` + `src/cdn/cdn-url.ts`。
全流程已逐字段对齐并端到端探针验证（getUploadUrl → CDN 上传 → FILE item → 微信端收到附件）：

1. `getUploadUrl`（`GetUploadUrlReq` 全字段：filekey / media_type / to_user_id / rawsize / rawfilemd5 / filesize / no_need_thumb / aeskey）✅
2. 本地 AES-128-ECB（PKCS7）加密明文 → 密文尺寸 = `aesEcbPaddedSize(rawsize)` ✅（与入站解密器互验往返一致）
3. POST 密文到 `upload_full_url` / `upload_param` 拼装 URL（`Content-Type: application/octet-stream`），3 次重试、4xx 立即中止，响应头 `x-encrypted-param` ✅
4. `sendMessage` 携带 `ImageItem.media = { encrypt_query_param, aes_key(base64), encrypt_type: 1 }` + `mid_size = 密文大小`（FILE: `file_item = { media, file_name, len }`）✅
5. `UploadMediaType`：IMAGE=1 / VIDEO=2 / FILE=3 / VOICE=4 ✅
6. 每类媒体单独一条消息（caption 文本先行，官方 `sendMediaItems` 语义）✅

> **终局结论（2026-08-16 全证据链）**：本后端上 bot→用户外发媒体**内容取流不可用**。
> 官方客户端自己的媒体参数是"客户端上传流程生成、双重 base64、404 字节签名结构"，
> 服务器签发类参数（upload_param，495 字节）客户端渲染时不识别——bot 侧无法复现客户端格式，
> 官方 openclaw-weixin / nanobot 参考实现同样不通（xep 形状可送达但取流 400）。
> 协议保持官方客户端镜像形状（upload_param + base64(hex) key + full_url，无 encrypt_type，
> 图片带 image_item.aeskey），**功能默认关闭**；后端为 bot 提供可取流的媒体语义后按 §6 矩阵重测即开。
>
> **实测偏差（2026-08-16 探针矩阵 + 官方客户端入站抓取）**：
> 外发媒体必须**完整镜像官方客户端的外发形状**（从其入站消息捕获，逐字段一致）：
> `media = { encrypt_query_param: <getUploadUrl 的 upload_param 长结构>, aes_key: base64(hex字符串),
> full_url: 完整下载 URL }`，**不含 encrypt_type**；图片额外带 `image_item.aeskey`（hex）。
> 任何单字段偏差都会失败：xep 头可送达但取流 400；upload_param 配 24 字符 key/带 encrypt_type
> 被丢或 prepare failed。探针矩阵：
>
> | 变体 | 服务端 | 端上 |
> |---|---|---|
> | xep + aes_key=base64(hex 字符串,44 字符) | prepare failed (ret=-2) | — |
> | xep + aes_key=base64(原始 16 字节,24 字符)（官方形状） | ack | 气泡送达，文件"无法下载"/图片"已过期" |
> | upload_param 当引用 + 24 字符 key | ack | 消息被静默丢弃 |
> | encrypt_type 0 | prepare failed | — |
> | media.full_url 携带完整下载 URL | prepare failed | — |
> | 服务器自下载 upload_param（+filekey） | 200 + 密文，解密与原文一致 | — |
> | 服务器自下载 xep（各种拼接变体） | 400 invalid encrypted_param | — |
>
> 结论：**本后端对 bot 外发媒体的内容取流尚未打通**（参考实现同样无法工作）。
> 工程决策：协议保持官方形状（xep + base64 原始字节 key + encrypt_type 1），
> `fileThresholdChars` 默认 **0=关闭**，`/export` `/card` 保留为后端支持后立即可用。
> 后端升级后按本矩阵重测即可开关。

### §6.1 活体验证追加（2026-08-16 晚间，生产代码路径 `scripts/probe-media.mjs`）

用**生产同款 lib 产物** + 真实账号凭证，对用户微信实发探针，结论与早间矩阵一致
并新增关键证据（全部有日志记录）：

| 探针 | 变体 | 服务器 | 端上（手机核对） |
|---|---|---|---|
| A | 生产形状：upload_param(896字符) + aes_key=base64(hex,44字符) + full_url(绝对) + mid_size | ack (message_id) | **静默丢弃**（未收到） |
| B | 官方形状：xep(488字符) + aes_key=base64(原始字节,24字符) | ack | **静默丢弃** |
| C | A + context_token（官方文档 3.5 声称必填） | ack | **静默丢弃** → context_token 不是投递条件 |
| D | C + create_time_ms/update_time_ms/is_completed + 去掉 mid_size（完整镜像官方 item） | **prepare failed (ret=-2)** | — |
| E | C + item 字段但保留 mid_size | **prepare failed** | — |
| F | C + 仅 create_time_ms/update_time_ms | **prepare failed** | — |
| G | C + 仅 is_completed | **prepare failed** | — |
| H | **官方源码逐字段镜像**（Tencent/openclaw-weixin `sendImageMessageWeixin`：xep + base64(原始字节) + encrypt_type:1 + mid_size，无 full_url/aeskey）+ ctx | **prepare failed** | — |
| I | H 去掉 encrypt_type | **prepare failed** | — |
| K | mirror（upload_param + 44key + full_url + aeskey）去掉 mid_size | **prepare failed** → mid_size 为服务器必需字段 | — |
| L | mirror + encrypt_type:1 | **prepare failed** | — |
| J | 官方源码形状修正版（xep + 44字符key + encrypt_type:1 + mid_size，即 hermes/openclaw 真形状） | **prepare failed** | — |
| M | **hermes-flow 逐字段复刻**（hermes-agent 0.19.0 weixin.py 全流程：client version 2.2.0、base_info 仅 channel_version、caption 先行、xep 引用） | **连 caption 纯文本都 prepare failed** | — |
| N | **单发判决（用户许可窗口）**：生产形状 + thumb_size/thumb_height/thumb_width/hd_size 尺寸元数据（2026-08-16 完整捕获官方 item 发现我们缺失的唯一字段）+ 新 bot 新鲜 ctx | ack (message_id) | **静默丢弃**（新 bot 身份、手机核对） |

- **item 级字段二分**：官方客户端入站 item 带 create_time_ms/update_time_ms/is_completed，
  但 **bot 发送带任一字段即 prepare failed**——服务器对 bot 出站媒体 item 有独立校验，
  bot 形状必须**不带**这三个字段（我们原始形状正确，勿照抄客户端入站 item 全字段）。
- **完整捕获修正（2026-08-16 19:35，media-captures.jsonl）**：官方客户端 item **有 mid_size
  与 thumb_size/thumb_height/thumb_width/hd_size**（此前 1200 字符截断日志误导为无），
  无 thumb_media、无 encrypt_type、无 item 级可复刻差异。尺寸元数据补发后仍静默丢弃（探针 N）。
- **官方源码形状今天被服务器拒绝**：按 Tencent/openclaw-weixin `sendImageMessageWeixin`
  （v2.4.5，`src/messaging/send.ts`）逐字段镜像（xep + 24 字符 key + encrypt_type:1 +
  mid_size），服务器直接 prepare failed——**官方参考实现自己的形状都过不了今天的服务器校验**。
  hermes-agent 0.19.0 全流程逐字段复刻（含其信封/版本头/caption 先行）连纯文本都被拒——
  两个"支持媒体"的参考实现的当前形状在今天的后端上均不可用，与"今天后端在迁移"一致。
- **结构解码**：官方客户端 encrypt_query_param = base64( base64url( 404 字节二进制 ) )，
  服务器签发 upload_param = base64( base64url( 495–672 字节二进制，请求间可变 ) )——两者
  结构不同，客户端渲染器只认客户端生成结构；服务器侧两种结构均可下载（自下载闭环均
  200+解密一致），说明门禁在**客户端渲染/取流侧**，不在 CDN。
- **入站方向实测通过**：用户手机发照片 → bot 经 full_url 下载 + AES 解密落盘成功
  （`media/<session>/wechat-*.jpg` 为真实 JPEG）——M3 链路生产端到端可用。

**判定边界（终局，2026-08-16 全证据链）**：bot→微信 外发图片被客户端渲染门禁锁定——
客户端只渲染其自生成的 404B 签名结构；服务器签发结构（upload_param/xep）与任何可过
服务器校验的 item 字段组合均被客户端静默丢弃（A/B/C/N），而官方客户端形状与参考实现
形状（openclaw/hermes）在今天的服务器校验下被拒（D–M）。bot 侧无解；协议保持对齐、
代码保持服务器接受的唯一形状。**金丝雀重测条件**：`getUploadUrl` 的 upload_param 内层
尺寸（当前 495–672B）与官方客户端 404B 结构对齐时，或官方客户端捕获结构变化时，按
本矩阵重测即可开关；被动捕获（media-captures.jsonl）与探针工具（scripts/probe-media.mjs，
带 --consent 门）均就位。

### §6.2 终局推翻与根因定案（2026-08-17，端上验证成功）

> ⚠️ **§6 与 §6.1 的"客户端渲染门禁"结论错误，本节推翻之。** 历史矩阵保留作考古，
> 判定以本节为准。

**单发验证（用户开窗口，官方形状一发即中）**：
`xep(CDN 上传响应头) + aes_key=base64(hex字符串)44字符 + encrypt_type:1 + mid_size`，
openclaw 2.4.6 头环境（iLink-App-ClientVersion=132102、base_info.channel_version=2.4.6、
无 context_token）→ 服务器 ack（message_id）→ **手机端正常显示**。

**根因定案（为什么本地此前全灭）**：
1. **`encrypt_query_param` 必须用 CDN 上传响应头 `x-encrypted-param`**，本地生产形状用的
   getUploadUrl `upload_param` 不是客户端认识的下载引用（A/C/N 静默丢弃的根因）。
2. **`full_url`、`image_item.aeskey` 是本地自创附加字段，官方形状不带**——B 变体（带
   full_url/aeskey）手机端渲染不稳定（早间送达/晚间丢弃），去掉后稳定。
3. **`encrypt_type:1` 是服务器 item 校验必需**（本地旧形状缺失）。
4. **`aes_key` 必须 base64(hex字符串) 44 字符**——24 字符 base64(原始字节) 导致接收端
   解密失败（hermes 源码注释"grey boxes"同因；本地 B 变体"无法下载/已过期"即此）。
5. **`ret=-2` 是限流/会话类业务错误，不是形状被拒**——openclaw 官方 issue #216
   （连续媒体发送触发 ret=-2，paced 即成功）+ hermes 源码（RATE_LIMIT_ERRCODE=-2，
   errmsg="unknown error" = stale session）双重印证。探针 D–M 的连续轰炸触发的正是它。
6. **本地"xep 下载 400"是 bot 侧自拼 URL 缺 `taskid` 参数**（官方 full_url 带 taskid）；
   下载 URL 由客户端构造（客户端生成 taskid），bot 无需也不能生成——不影响发送可行性。
   只读验证（2026-08-17）：upload_param 可作下载参数（200 解密一致），但客户端渲染器
   不认 upload_param 作消息引用；xep bot 侧自测 400，客户端侧可取流（端上验证成功）。

**生产代码（2026-08-17 起）**：`buildOutboundMediaItem` = 官方形状（xep + 44key +
encrypt_type:1 + mid_size / file_item{file_name,len}），`src/gateway/index.ts` 上传后直接
用 `uploadBufferToCdn` 的 `downloadParam`。`/export`、`/card`、长文转文件（fileThresholdChars>0）
全部走此形状，立即可用。

**残余问题**：视频（video_item 需 play_length/video_md5）与语音（voice_item 需
encode_type/sample_rate 等）未端上验证；`taskid` 生成规则未逆向（客户端侧逻辑，bot 不需要）。
