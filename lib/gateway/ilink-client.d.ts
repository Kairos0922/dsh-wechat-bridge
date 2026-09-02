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
export declare const DEFAULT_LONG_POLL_TIMEOUT_MS = 35000;
export declare const DEFAULT_API_TIMEOUT_MS = 15000;
export declare const DEFAULT_CONFIG_TIMEOUT_MS = 10000;
export declare const QR_LONG_POLL_TIMEOUT_MS = 35000;
/**
 * P2-2: the default bot_agent follows the REAL package version (it was
 * hardcoded to 0.1.0 while the package moved on — observability lie).
 * UA-style `name/version`; for observability only, never auth/routing
 * (official BaseInfo.bot_agent docs).
 */
export declare const DEFAULT_BOT_AGENT: string;
/**
 * P2-2: sanitize a bot_agent into a wire-safe UA-style string (port of the
 * official sanitizeBotAgent, api.ts:132-200). Tokens failing the grammar are
 * dropped; falls back to DEFAULT_BOT_AGENT when nothing survives or the
 * result exceeds the length cap after truncation.
 */
export declare function sanitizeBotAgent(raw: string | undefined): string;
/** Install the configured bot_agent (sanitized on every use). */
export declare function setBotAgent(raw: string | undefined): void;
/**
 * P2-1: classify a fetch-level error into a category for logging/diagnostics
 * (port of the official classifyFetchError, api.ts:260-288). Covers network
 * errors only — HTTP 4xx/5xx throw separately in apiPostFetch.
 */
export declare function classifyFetchError(err: unknown): {
    type: 'dns' | 'tcp' | 'tls' | 'timeout' | 'unknown';
    description: string;
    code?: string;
};
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
 *
 * P0-3: returns the parsed response so the caller can check `ret` — a
 * rejected announce must not leave the gateway claiming a healthy 'polling'
 * state (the official client warns on ret!==0; channel.ts:431-441).
 */
export declare function notifyStart(params: {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
}): Promise<{
    ret?: number;
    errmsg?: string;
}>;
/** Notify the gateway that this channel client is stopping. Same ret check. */
export declare function notifyStop(params: {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
}): Promise<{
    ret?: number;
    errmsg?: string;
}>;
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
/**
 * Request a login QR code (bot_type 3, the standard WeChat channel).
 *
 * P0-2: `localTokenList` reports already-bound bot tokens (max 10) so the
 * server can recognize an existing binding and answer `binded_redirect`
 * instead of issuing a duplicate session (official login-qr.ts:64-90,
 * getLocalBotTokenList; CHANGELOG 2.3.1).
 *
 * P1-2: no short client-side timeout by default (official 2.1.4 removed it —
 * a slow server response must not fail QR acquisition); apiPostFetch's 60s
 * whole-exchange budget still applies as the outer bound.
 */
export declare function fetchQrCode(params: {
    baseUrl?: string;
    botType?: string;
    timeoutMs?: number;
    localTokenList?: string[];
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