/**
 * iLink protocol types shared by the gateway and the bridge node.
 *
 * Field names follow the official openclaw-weixin backend protocol
 * (Tencent/openclaw-weixin, MIT) — see README.md for the protocol table.
 *
 * @module dsh-wechat-bridge/gateway/types
 */
export declare const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export declare const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export declare const LONG_POLL_TIMEOUT_MS = 35000;
export declare const API_TIMEOUT_MS = 15000;
export declare const MESSAGE_DEDUP_TTL_SECONDS = 300;
export declare const MAX_MESSAGE_CHARS = 2000;
/** iLink errcodes (from the official backend protocol). */
export declare const RATE_LIMIT_ERRCODE = -12;
export declare const SESSION_EXPIRED_ERRCODE = -14;
/**
 * ret=-2 is the rate-limit/session-class business error (docs/protocol.md §5).
 * Its MEANING lives in `errmsg`: "prepare failed" / "unknown error" = stale
 * context_token (recover by resending WITHOUT the token — iLink accepts
 * tokenless sends as a degraded fallback); "rate limited" / "freq limit" =
 * frequency limit (recover by backing off). Any other -2 text is treated as
 * a frequency limit (hermes-agent classification, RATE_LIMIT_ERRCODE=-2).
 */
export declare const SESSION_CLASS_RET = -2;
export declare const STALE_SESSION_ERRMSG_MARKERS: readonly ["prepare failed", "unknown error"];
export declare const RATE_LIMIT_ERRMSG_MARKERS: readonly ["rate limited", "freq limit"];
/**
 * Business-level failure classes driving the outbox's recovery strategy.
 * `ret=-2` carries two meanings distinguished by `errmsg` (protocol.md §5).
 */
export type SendFailureClass = 'stale-session' | 'rate-limit' | 'session-expired' | 'generic';
/** Classify a server-side send failure (ret/errcode/errmsg verbatim). */
export declare function classifySendFailure(ret: number | undefined, errcode: number | undefined, errmsg: string | undefined): SendFailureClass;
/**
 * Poll-batch disposition for the gateway's long-poll loop. Same classifier
 * as outbound sends (dual-slot: ret===code || errcode===code) so a negative
 * `ret` without `errcode` can never fall into the success path.
 */
export type PollBatchClass = 'ok' | 'session-expired' | 'rate-limit' | 'generic-negative';
/** Classify one getUpdates batch for the poll loop's recovery dispatch. */
export declare function classifyPollBatch(batch: {
    ret?: number;
    errcode?: number;
    errmsg?: string;
}): PollBatchClass;
export declare const ITEM_TEXT = 1;
export declare const ITEM_IMAGE = 2;
export declare const ITEM_VOICE = 3;
export declare const ITEM_FILE = 4;
export declare const ITEM_VIDEO = 5;
/** Bot-only progress cards rendered natively by the WeChat client. */
export declare const ITEM_TOOL_CALL_START = 11;
export declare const ITEM_TOOL_CALL_RESULT = 12;
/** proto: UploadMediaType — the media_type of getUploadUrl requests. */
export declare const UPLOAD_MEDIA_IMAGE = 1;
export declare const UPLOAD_MEDIA_VIDEO = 2;
export declare const UPLOAD_MEDIA_FILE = 3;
export declare const UPLOAD_MEDIA_VOICE = 4;
export declare const MESSAGE_TYPE_USER = 1;
export declare const MESSAGE_TYPE_BOT = 2;
/** Outbound message lifecycle: FINISH = the message is complete and renderable. */
export declare const MESSAGE_STATE_FINISH = 2;
/**
 * H1: normalize and validate a gateway base URL. Accepts a bare hostname
 * (https:// is prepended), requires WHATWG-parseable https with a trusted
 * hostname (`ilinkai.weixin.qq.com`, any `*.weixin.qq.com` subdomain, or an
 * exact `extraTrustedHosts` match). Any violation returns `fallback`.
 */
export declare function sanitizeBaseUrl(candidate: string | null | undefined, fallback: string, extraTrustedHosts?: readonly string[]): string;
/**
 * Hard cap for a single CDN media download (F4). Enforced both from
 * Content-Length and while streaming the body.
 */
export declare const MEDIA_DOWNLOAD_MAX_BYTES: number;
/**
 * F4: validate a CDN media URL before any fetch/POST. Requires https and a
 * trusted hostname: `novac2c.cdn.weixin.qq.com`, any `*.cdn.weixin.qq.com`
 * subdomain, or an exact `extraTrustedHosts` match (case-insensitive).
 * Throws on any violation; returns the parsed URL on success.
 */
export declare function assertCdnUrl(rawUrl: string, extraTrustedHosts?: readonly string[]): URL;
export interface TextItem {
    text?: string;
}
export interface CdnMedia {
    encrypt_query_param?: string;
    aes_key?: string;
    /** 加密类型: 0=只加密fileid, 1=打包缩略图/中图等信息 */
    encrypt_type?: number;
    /** 完整下载 URL（服务端直接返回，无需客户端拼接） */
    full_url?: string;
}
export interface ImageItem {
    /** 原图 CDN 引用 */
    media?: CdnMedia;
    /** 缩略图 CDN 引用 */
    thumb_media?: CdnMedia;
    /** Raw AES-128 key as hex string (16 bytes); preferred for inbound decryption. */
    aeskey?: string;
    url?: string;
    mid_size?: number;
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
    hd_size?: number;
}
export interface VoiceItem {
    media?: CdnMedia;
    /** 语音编码类型：1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
    encode_type?: number;
    bits_per_sample?: number;
    sample_rate?: number;
    /** 语音长度 (毫秒) */
    playtime?: number;
    /** 语音转文字内容 */
    text?: string;
}
export interface FileItem {
    media?: CdnMedia;
    file_name?: string;
    md5?: string;
    len?: string;
}
export interface VideoItem {
    media?: CdnMedia;
    video_size?: number;
    play_length?: number;
    video_md5?: string;
    thumb_media?: CdnMedia;
}
/** Bot-only progress card: a tool invocation just started (client-rendered). */
export interface ToolCallStartItem {
    tool_name?: string;
    tool_call_id?: string;
}
/** Bot-only progress card: a tool invocation finished (client-rendered). */
export interface ToolCallResultItem {
    tool_name?: string;
    tool_call_id?: string;
    status?: string;
}
/** Quoted-message reference (official RefMessage, field-for-field). */
export interface RefMessage {
    message_item?: MessageItem;
    /** Summary/title of the quoted message. */
    title?: string;
}
export interface MessageItem {
    type?: number;
    create_time_ms?: number;
    update_time_ms?: number;
    is_completed?: boolean;
    msg_id?: string;
    ref_msg?: RefMessage;
    text_item?: TextItem;
    image_item?: ImageItem;
    voice_item?: VoiceItem;
    file_item?: FileItem;
    video_item?: VideoItem;
    tool_call_start_item?: ToolCallStartItem;
    tool_call_result_item?: ToolCallResultItem;
}
/**
 * Outcome of one outbound send attempt. Business errcodes are surfaced so the
 * queue can adapt (rate-limit backoff, session-expired pause) instead of
 * treating every failure alike.
 */
export interface SendResult {
    ok: boolean;
    ret?: number;
    errcode?: number;
    errmsg?: string;
    messageId?: number;
    /**
     * Server-side business classification (when `ret != 0`): stale-session and
     * rate-limit are RECOVERABLE (tokenless resend / backoff); generic is a
     * permanent rejection of this payload.
     */
    failureClass?: SendFailureClass;
    /**
     * Whether a retry may succeed. false = the SERVER explicitly rejected the
     * message with a business error other than the rate-limit/session-class
     * ret=-2 (protocol.md §5) — retrying is pointless. true or undefined =
     * transport-level failure (timeout/network/HTTP) — retryable.
     */
    retryable?: boolean;
}
/** Mirror the official WeixinMessage field set (Tencent/openclaw-weixin). */
export interface InboundMessage {
    seq?: number;
    message_id?: number;
    from_user_id?: string;
    to_user_id?: string;
    client_id?: string;
    create_time_ms?: number;
    update_time_ms?: number;
    delete_time_ms?: number;
    session_id?: string;
    /** Group id when the message belongs to a group chat (MVP: ignored). */
    group_id?: string;
    room_id?: string;
    chat_room_id?: string;
    msg_type?: number;
    message_type?: number;
    message_state?: number;
    item_list?: MessageItem[];
    context_token?: string;
    run_id?: string;
}
export interface UpdatesBatch {
    ret: number;
    errcode?: number;
    errmsg?: string;
    msgs?: InboundMessage[];
    get_updates_buf?: string;
    longpolling_timeout_ms?: number;
}
export interface WechatCredentials {
    accountId?: string;
    botToken?: string;
    baseUrl?: string;
    /** WeChat user id of the account that scanned the login QR. */
    ilinkUserId?: string;
}
/** Payload emitted by the gateway on `inbound` (scoped to the `wechat` service). */
export interface InboundEvent {
    message: InboundMessage;
    senderId: string;
    contextToken?: string;
    /** Echoed back on outbound sends — progress cards associate to it. */
    runId?: string;
}
//# sourceMappingURL=types.d.ts.map