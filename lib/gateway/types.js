/**
 * iLink protocol types shared by the gateway and the bridge node.
 *
 * Field names follow the official openclaw-weixin backend protocol
 * (Tencent/openclaw-weixin, MIT) — see README.zh.md for the protocol table.
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