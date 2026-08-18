/**
 * iLink protocol types shared by the gateway and the bridge node.
 *
 * Field names follow the official openclaw-weixin backend protocol
 * (Tencent/openclaw-weixin, MIT) — see README.md for the protocol table.
 *
 * @module dsh-wechat-bridge/gateway/types
 */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const LONG_POLL_TIMEOUT_MS = 35_000;
export const API_TIMEOUT_MS = 15_000;
export const MESSAGE_DEDUP_TTL_SECONDS = 300;
export const MAX_MESSAGE_CHARS = 2000;
/** iLink errcodes (from the official backend protocol). */
export const RATE_LIMIT_ERRCODE = -12;
export const SESSION_EXPIRED_ERRCODE = -14;
/**
 * ret=-2 is the rate-limit/session-class business error (docs/protocol.md §5).
 * Its MEANING lives in `errmsg`: "prepare failed" / "unknown error" = stale
 * context_token (recover by resending WITHOUT the token — iLink accepts
 * tokenless sends as a degraded fallback); "rate limited" / "freq limit" =
 * frequency limit (recover by backing off). Any other -2 text is treated as
 * a frequency limit (hermes-agent classification, RATE_LIMIT_ERRCODE=-2).
 */
export const SESSION_CLASS_RET = -2;
export const STALE_SESSION_ERRMSG_MARKERS = ['prepare failed', 'unknown error'];
export const RATE_LIMIT_ERRMSG_MARKERS = ['rate limited', 'freq limit'];
/** Classify a server-side send failure (ret/errcode/errmsg verbatim). */
export function classifySendFailure(ret, errcode, errmsg) {
    const hasCode = (code) => ret === code || errcode === code;
    if (hasCode(SESSION_EXPIRED_ERRCODE))
        return 'session-expired';
    if (hasCode(RATE_LIMIT_ERRCODE))
        return 'rate-limit';
    if (hasCode(SESSION_CLASS_RET)) {
        const msg = (errmsg ?? '').toLowerCase();
        if (STALE_SESSION_ERRMSG_MARKERS.some((marker) => msg.includes(marker)))
            return 'stale-session';
        return 'rate-limit';
    }
    return 'generic';
}
export const ITEM_TEXT = 1;
export const ITEM_IMAGE = 2;
export const ITEM_VOICE = 3;
export const ITEM_FILE = 4;
export const ITEM_VIDEO = 5;
/** Bot-only progress cards rendered natively by the WeChat client. */
export const ITEM_TOOL_CALL_START = 11;
export const ITEM_TOOL_CALL_RESULT = 12;
/** proto: UploadMediaType — the media_type of getUploadUrl requests. */
export const UPLOAD_MEDIA_IMAGE = 1;
export const UPLOAD_MEDIA_VIDEO = 2;
export const UPLOAD_MEDIA_FILE = 3;
export const UPLOAD_MEDIA_VOICE = 4;
export const MESSAGE_TYPE_USER = 1;
export const MESSAGE_TYPE_BOT = 2;
//# sourceMappingURL=types.js.map