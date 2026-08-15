/**
 * iLink protocol types shared by the gateway and the bridge node.
 *
 * Field names follow the official openclaw-weixin backend protocol
 * (Tencent/openclaw-weixin, MIT) — see README.zh.md for the protocol table.
 *
 * @module dsh-wechat-bridge/gateway/types
 */
export declare const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export declare const WEIXIN_CDN_BASE_URL = "https://weixin-cdn.weixin.qq.com";
export declare const LONG_POLL_TIMEOUT_MS = 35000;
export declare const API_TIMEOUT_MS = 15000;
export declare const MESSAGE_DEDUP_TTL_SECONDS = 300;
export declare const MAX_MESSAGE_CHARS = 2000;
/** iLink errcodes (from the official backend protocol). */
export declare const RATE_LIMIT_ERRCODE = -12;
export declare const SESSION_EXPIRED_ERRCODE = -14;
export declare const ITEM_TEXT = 1;
export declare const ITEM_IMAGE = 2;
export declare const ITEM_VOICE = 3;
export declare const ITEM_FILE = 4;
export declare const ITEM_VIDEO = 5;
export declare const MESSAGE_TYPE_USER = 1;
export declare const MESSAGE_TYPE_BOT = 2;
export interface TextItem {
    text?: string;
}
export interface CdnMedia {
    encrypt_query_param?: string;
    aes_key?: string;
}
export interface ImageItem {
    url?: string;
    aes_key?: string;
    thumb_url?: string;
    thumb_aes_key?: string;
    width?: number;
    height?: number;
}
export interface MessageItem {
    type: number;
    text_item?: TextItem;
    image_item?: ImageItem;
    ref_msg?: unknown;
}
export interface InboundMessage {
    seq?: number;
    message_id?: number;
    from_user_id?: string;
    to_user_id?: string;
    create_time_ms?: number;
    session_id?: string;
    message_type?: number;
    message_state?: number;
    item_list?: MessageItem[];
    context_token?: string;
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
//# sourceMappingURL=types.d.ts.map