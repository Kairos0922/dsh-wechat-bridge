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
/** Classify one getUpdates batch for the poll loop's recovery dispatch. */
export function classifyPollBatch(batch) {
    const { ret, errcode } = batch;
    // ANY negative slot is a failure — do not let a bare { ret: -12 } through.
    const anyNegative = (ret !== undefined && ret < 0) || (errcode !== undefined && errcode < 0);
    if (!anyNegative)
        return 'ok';
    const cls = classifySendFailure(ret, errcode, batch.errmsg);
    // -14 and the stale-token ret=-2 pair (unknown error / prepare failed) both
    // recover by re-resolving credentials → the long session-expired pause.
    if (cls === 'session-expired' || cls === 'stale-session')
        return 'session-expired';
    if (cls === 'rate-limit')
        return 'rate-limit';
    return 'generic-negative';
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
/** Outbound message lifecycle: FINISH = the message is complete and renderable. */
export const MESSAGE_STATE_FINISH = 2;
/**
 * H1: normalize and validate a gateway base URL. Accepts a bare hostname
 * (https:// is prepended), requires WHATWG-parseable https with a trusted
 * hostname (`ilinkai.weixin.qq.com`, any `*.weixin.qq.com` subdomain, or an
 * exact `extraTrustedHosts` match). Any violation returns `fallback`.
 */
export function sanitizeBaseUrl(candidate, fallback, extraTrustedHosts) {
    if (typeof candidate !== 'string' || candidate.trim() === '')
        return fallback;
    const raw = candidate.trim();
    // Bare hostname (optionally with port) → prepend https://; anything with a
    // real `scheme://` is parsed as-is.
    const candidateUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
    let parsed;
    try {
        parsed = new URL(candidateUrl);
    }
    catch {
        return fallback;
    }
    if (parsed.protocol !== 'https:')
        return fallback;
    const host = parsed.hostname.toLowerCase();
    const extra = (extraTrustedHosts ?? []).map((h) => h.toLowerCase());
    const trusted = host === 'ilinkai.weixin.qq.com' || host.endsWith('.weixin.qq.com') || extra.includes(host);
    if (!trusted)
        return fallback;
    return parsed.toString();
}
/**
 * Hard cap for a single CDN media download (F4). Enforced both from
 * Content-Length and while streaming the body.
 */
export const MEDIA_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
/**
 * F4: validate a CDN media URL before any fetch/POST. Requires https and a
 * trusted hostname: `novac2c.cdn.weixin.qq.com`, any `*.cdn.weixin.qq.com`
 * subdomain, or an exact `extraTrustedHosts` match (case-insensitive).
 * Throws on any violation; returns the parsed URL on success.
 */
export function assertCdnUrl(rawUrl, extraTrustedHosts) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        throw new Error('CDN URL is not a valid URL');
    }
    if (parsed.protocol !== 'https:') {
        throw new Error('CDN URL must use https');
    }
    const host = parsed.hostname.toLowerCase();
    const extra = (extraTrustedHosts ?? []).map((h) => h.toLowerCase());
    if (host === 'novac2c.cdn.weixin.qq.com' || host.endsWith('.cdn.weixin.qq.com') || extra.includes(host)) {
        return parsed;
    }
    throw new Error(`CDN URL host not trusted: ${host}`);
}
//# sourceMappingURL=types.js.map