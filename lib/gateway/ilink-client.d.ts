/**
 * iLink protocol client — self-contained, ported from Tencent/openclaw-weixin
 * (MIT, Copyright (C) 2026 Tencent). See LICENSE for attribution.
 *
 * Covers: authenticated POST/GET fetch wrappers, getUpdates long-poll,
 * sendMessage, getConfig, sendTyping, plus the QR login flow
 * (get_bot_qrcode / get_qrcode_status). CDN upload/download is added in M3.
 *
 * @module dsh-wechat-bridge/gateway/ilink-client
 */
import { type MessageItem, type UpdatesBatch } from './types.ts';
export declare const LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";
export declare const DEFAULT_BOT_TYPE = "3";
export declare const DEFAULT_BOT_AGENT = "dsh-wechat-bridge/0.1.0";
export declare const DEFAULT_LONG_POLL_TIMEOUT_MS = 35000;
export declare const DEFAULT_API_TIMEOUT_MS = 15000;
export declare const DEFAULT_CONFIG_TIMEOUT_MS = 10000;
export declare const QR_LONG_POLL_TIMEOUT_MS = 35000;
export interface GetUpdatesParams {
    baseUrl: string;
    token?: string;
    getUpdatesBuf?: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
}
/**
 * Long-poll getUpdates. On client-side timeout, returns an empty batch
 * (ret=0) so the caller can simply retry — normal for long-poll.
 */
export declare function getUpdates(params: GetUpdatesParams): Promise<UpdatesBatch>;
export interface SendMessageBody {
    to_user_id: string;
    context_token?: string;
    /** Echo of the inbound run_id — required for tool-progress card association. */
    run_id?: string;
    item_list: MessageItem[];
}
/** Structured business-level send failure: ret/errcode/errmsg verbatim. */
export declare class IlinkSendError extends Error {
    readonly ret?: number;
    readonly errcode?: number;
    readonly errmsg?: string;
    constructor(ret: number | undefined, errcode: number | undefined, errmsg: string | undefined);
}
/**
 * Send one complete WeixinMessage downstream. Returns the parsed response.
 *
 * The msg must be a COMPLETE WeixinMessage: the official client always fills
 * `from_user_id: ""`, a per-message `client_id`, `message_type: BOT` and
 * `message_state: FINISH` — messages missing them are acked (ret=0,
 * message_id assigned) but never delivered to the WeChat client.
 *
 * A business-level failure (ret != 0) throws {@link IlinkSendError} so callers
 * can classify rate-limit (-12) and session-expiry (-14) instead of parsing
 * error text.
 */
export declare function sendMessage(params: {
    baseUrl: string;
    token?: string;
    body: SendMessageBody;
    timeoutMs?: number;
}): Promise<{
    ret?: number;
    errcode?: number;
    errmsg?: string;
    message_id?: number;
}>;
/** Fetch bot config (includes the typing ticket) for a given user. */
export declare function getConfig(params: {
    baseUrl: string;
    token?: string;
    ilinkUserId: string;
    contextToken?: string;
    timeoutMs?: number;
}): Promise<{
    ret: number;
    typing_ticket?: string;
    errcode?: number;
    errmsg?: string;
}>;
/** Send a typing indicator. */
export declare function sendTyping(params: {
    baseUrl: string;
    token?: string;
    ilinkUserId: string;
    typingTicket: string;
    status: 1 | 2;
    timeoutMs?: number;
}): Promise<void>;
/**
 * Request a CDN upload slot. Field-for-field port of the official
 * `getUploadUrl` (GetUploadUrlReq): filekey, media_type, to_user_id, rawsize,
 * rawfilemd5, filesize (ciphertext size), aeskey (hex), no_need_thumb.
 */
export declare function getUploadUrl(params: {
    baseUrl: string;
    token?: string;
    filekey: string;
    mediaType: number;
    toUserId: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
    timeoutMs?: number;
}): Promise<{
    ret?: number;
    errcode?: number;
    errmsg?: string;
    upload_param?: string;
    thumb_upload_param?: string;
    upload_full_url?: string;
}>;
/**
 * Notify the gateway that this channel client is starting. Without it the
 * server may ack sends (ret=0) but never deliver them to the WeChat client —
 * observed after abrupt restarts. Called once at gateway boot.
 */
export declare function notifyStart(params: {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
}): Promise<void>;
/** Notify the gateway that this channel client is stopping. */
export declare function notifyStop(params: {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
}): Promise<void>;
export interface QrCodeResponse {
    qrcode: string;
    qrcode_img_content?: string;
}
export type QrLoginStatus = 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect';
export interface QrStatusResponse {
    status: QrLoginStatus;
    bot_token?: string;
    ilink_bot_id?: string;
    baseurl?: string;
    ilink_user_id?: string;
    redirect_host?: string;
}
/** Request a login QR code (bot_type 3, the standard WeChat channel). */
export declare function fetchQrCode(params: {
    baseUrl?: string;
    botType?: string;
    timeoutMs?: number;
}): Promise<QrCodeResponse>;
/**
 * Long-poll the QR status. Network errors and client-side timeouts degrade
 * to `wait` so the caller keeps polling.
 */
export declare function pollQrStatus(params: {
    baseUrl?: string;
    qrcode: string;
    verifyCode?: string;
    timeoutMs?: number;
}): Promise<QrStatusResponse>;
//# sourceMappingURL=ilink-client.d.ts.map