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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGE_TYPE_BOT, MESSAGE_STATE_FINISH } from "./types.js";
export const LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_BOT_TYPE = '3';
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
export const DEFAULT_API_TIMEOUT_MS = 15_000;
export const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
export const QR_LONG_POLL_TIMEOUT_MS = 35_000;
/** Walk up from this module looking for our own package.json. */
function readOwnPackageJson() {
    try {
        let dir = path.dirname(fileURLToPath(import.meta.url));
        const { root } = path.parse(dir);
        while (dir && dir !== root) {
            const candidate = path.join(dir, 'package.json');
            if (fs.existsSync(candidate)) {
                const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
                if (parsed.name === 'dsh-wechat-bridge')
                    return parsed;
            }
            dir = path.dirname(dir);
        }
    }
    catch {
        // fall through
    }
    return {};
}
const pkg = readOwnPackageJson();
const ILINK_APP_ID = pkg.ilink_appid ?? 'bot';
const CHANNEL_VERSION = pkg.version ?? 'unknown';
/** iLink-App-ClientVersion: uint32 0x00MMNNPP from the package version. */
function buildClientVersion(version) {
    const parts = version.split('.').map((p) => parseInt(p, 10));
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    const patch = parts[2] ?? 0;
    return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);
/**
 * P2-2: the default bot_agent follows the REAL package version (it was
 * hardcoded to 0.1.0 while the package moved on — observability lie).
 * UA-style `name/version`; for observability only, never auth/routing
 * (official BaseInfo.bot_agent docs).
 */
export const DEFAULT_BOT_AGENT = `dsh-wechat-bridge/${CHANNEL_VERSION}`;
/** Maximum length (bytes) of the sanitized bot_agent string (official 256). */
const BOT_AGENT_MAX_LEN = 256;
/**
 * P2-2: sanitize a bot_agent into a wire-safe UA-style string (port of the
 * official sanitizeBotAgent, api.ts:132-200). Tokens failing the grammar are
 * dropped; falls back to DEFAULT_BOT_AGENT when nothing survives or the
 * result exceeds the length cap after truncation.
 */
export function sanitizeBotAgent(raw) {
    if (!raw || typeof raw !== 'string')
        return DEFAULT_BOT_AGENT;
    const trimmed = raw.trim();
    if (!trimmed)
        return DEFAULT_BOT_AGENT;
    const productRe = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/;
    const commentCharRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/;
    // Tokenize on whitespace, re-attaching multi-word (comment) tokens.
    const rawTokens = trimmed.split(/\s+/);
    const tokens = [];
    for (let i = 0; i < rawTokens.length; i += 1) {
        const tok = rawTokens[i] ?? '';
        if (tok.startsWith('(') && !tok.endsWith(')')) {
            let acc = tok;
            while (i + 1 < rawTokens.length && !acc.endsWith(')')) {
                i += 1;
                acc += ' ' + (rawTokens[i] ?? '');
            }
            tokens.push(acc);
        }
        else {
            tokens.push(tok);
        }
    }
    const accepted = [];
    let pendingProduct = null;
    for (const tok of tokens) {
        if (tok.startsWith('(') && tok.endsWith(')')) {
            const inner = tok.slice(1, -1);
            if (pendingProduct && commentCharRe.test(inner)) {
                accepted.push(`${pendingProduct} (${inner})`);
                pendingProduct = null;
            }
            else {
                if (pendingProduct) {
                    accepted.push(pendingProduct);
                    pendingProduct = null;
                }
            }
            continue;
        }
        if (pendingProduct) {
            accepted.push(pendingProduct);
            pendingProduct = null;
        }
        if (productRe.test(tok)) {
            pendingProduct = tok;
        }
    }
    if (pendingProduct)
        accepted.push(pendingProduct);
    if (accepted.length === 0)
        return DEFAULT_BOT_AGENT;
    const joined = accepted.join(' ');
    if (Buffer.byteLength(joined, 'utf-8') <= BOT_AGENT_MAX_LEN)
        return joined;
    const truncated = [];
    let len = 0;
    for (const t of accepted) {
        const add = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(t, 'utf-8');
        if (len + add > BOT_AGENT_MAX_LEN)
            break;
        truncated.push(t);
        len += add;
    }
    return truncated.length > 0 ? truncated.join(' ') : DEFAULT_BOT_AGENT;
}
/** P2-2: optional configured bot_agent (set once at gateway boot). */
let botAgentOverride;
/** Install the configured bot_agent (sanitized on every use). */
export function setBotAgent(raw) {
    botAgentOverride = typeof raw === 'string' && raw.trim() ? raw : undefined;
}
function buildBaseInfo() {
    return {
        channel_version: CHANNEL_VERSION,
        bot_agent: sanitizeBotAgent(botAgentOverride),
    };
}
// ---------------------------------------------------------------- headers
function ensureTrailingSlash(url) {
    return url.endsWith('/') ? url : `${url}/`;
}
/** X-WECHAT-UIN: random uint32 -> decimal string -> base64. */
function randomWechatUin() {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32), 'utf-8').toString('base64');
}
function buildCommonHeaders() {
    return {
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    };
}
function buildHeaders(opts) {
    const headers = {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomWechatUin(),
        ...buildCommonHeaders(),
    };
    if (opts.token?.trim()) {
        headers.Authorization = `Bearer ${opts.token.trim()}`;
    }
    return headers;
}
// ---------------------------------------------------------------- fetch wrappers
/**
 * P2-1: classify a fetch-level error into a category for logging/diagnostics
 * (port of the official classifyFetchError, api.ts:260-288). Covers network
 * errors only — HTTP 4xx/5xx throw separately in apiPostFetch.
 */
export function classifyFetchError(err) {
    if (err instanceof Error && err.name === 'AbortError') {
        return { type: 'timeout', description: 'request timeout' };
    }
    const cause = err?.cause;
    const causeCode = cause?.code ?? '';
    const causeStr = String(cause ?? err ?? '') + ' ' + String(causeCode);
    const matchedCode = causeCode || (typeof cause === 'string' ? cause : '');
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(causeStr)) {
        return { type: 'dns', description: 'DNS resolution failed, check DNS configuration', ...(matchedCode ? { code: matchedCode } : {}) };
    }
    if (/ECONNREFUSED/i.test(causeStr)) {
        return { type: 'tcp', description: 'TCP connection refused', ...(matchedCode ? { code: matchedCode } : {}) };
    }
    if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(causeStr)) {
        return { type: 'tcp', description: 'TCP connection timeout or unreachable', ...(matchedCode ? { code: matchedCode } : {}) };
    }
    if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(causeStr)) {
        return { type: 'tls', description: 'TLS handshake error', ...(matchedCode ? { code: matchedCode } : {}) };
    }
    return { type: 'unknown', description: 'network request failed' };
}
async function apiPostFetch(params) {
    const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
    // M13: the timeout budget covers the ENTIRE exchange — including the
    // response body read, which used to run without any deadline after the
    // headers arrived. Default 60s when the caller does not specify one.
    const timeoutMs = params.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    params.abortSignal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
        const res = await fetch(url.toString(), {
            method: 'POST',
            headers: buildHeaders({ token: params.token }),
            body: params.body,
            signal: controller.signal,
        });
        const rawText = await res.text();
        if (!res.ok) {
            throw new Error(`POST ${params.endpoint} status=${res.status}: ${rawText.slice(0, 200)}`);
        }
        return rawText;
    }
    finally {
        clearTimeout(timer);
        params.abortSignal?.removeEventListener('abort', onExternalAbort);
    }
}
async function apiGetFetch(params) {
    const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
    const controller = params.timeoutMs !== undefined ? new AbortController() : undefined;
    const timer = controller !== undefined && params.timeoutMs !== undefined
        ? setTimeout(() => controller.abort(), params.timeoutMs)
        : undefined;
    try {
        const res = await fetch(url.toString(), {
            method: 'GET',
            headers: buildCommonHeaders(),
            signal: controller?.signal,
        });
        if (timer !== undefined)
            clearTimeout(timer);
        const rawText = await res.text();
        if (!res.ok) {
            throw new Error(`GET ${params.endpoint} status=${res.status}: ${rawText.slice(0, 200)}`);
        }
        return rawText;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * Long-poll getUpdates. On client-side timeout, returns an empty batch
 * (ret=0) so the caller can simply retry — normal for long-poll.
 */
export async function getUpdates(params) {
    const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    try {
        const rawText = await apiPostFetch({
            baseUrl: params.baseUrl,
            endpoint: 'ilink/bot/getupdates',
            body: JSON.stringify({
                get_updates_buf: params.getUpdatesBuf ?? '',
                base_info: buildBaseInfo(),
            }),
            token: params.token,
            timeoutMs: timeout,
            abortSignal: params.abortSignal,
        });
        return JSON.parse(rawText);
    }
    catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
        }
        throw err;
    }
}
/** Structured business-level send failure: ret/errcode/errmsg verbatim. */
export class IlinkSendError extends Error {
    ret;
    errcode;
    errmsg;
    constructor(ret, errcode, errmsg) {
        super(`sendMessage ret=${ret ?? '-'} errcode=${errcode ?? '-'} errmsg=${errmsg ?? '(none)'}`);
        this.name = 'IlinkSendError';
        this.ret = ret;
        this.errcode = errcode;
        this.errmsg = errmsg;
    }
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
export async function sendMessage(params) {
    const rawText = await apiPostFetch({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        body: JSON.stringify({
            msg: {
                from_user_id: '',
                to_user_id: params.body.to_user_id,
                client_id: crypto.randomUUID(),
                message_type: MESSAGE_TYPE_BOT,
                message_state: MESSAGE_STATE_FINISH,
                item_list: params.body.item_list,
                context_token: params.body.context_token ?? undefined,
                run_id: params.body.run_id ?? undefined,
            },
            base_info: buildBaseInfo(),
        }),
        token: params.token,
        timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    });
    const resp = JSON.parse(rawText);
    if (resp.ret && resp.ret !== 0) {
        throw new IlinkSendError(resp.ret, resp.errcode, resp.errmsg);
    }
    return resp;
}
/** Fetch bot config (includes the typing ticket) for a given user. */
export async function getConfig(params) {
    const rawText = await apiPostFetch({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/getconfig',
        body: JSON.stringify({
            ilink_user_id: params.ilinkUserId,
            context_token: params.contextToken,
            base_info: buildBaseInfo(),
        }),
        token: params.token,
        timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    });
    return JSON.parse(rawText);
}
/** Send a typing indicator. */
export async function sendTyping(params) {
    await apiPostFetch({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/sendtyping',
        body: JSON.stringify({
            ilink_user_id: params.ilinkUserId,
            typing_ticket: params.typingTicket,
            status: params.status,
            base_info: buildBaseInfo(),
        }),
        token: params.token,
        timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    });
}
/**
 * Request a CDN upload slot. Field-for-field port of the official
 * `getUploadUrl` (GetUploadUrlReq): filekey, media_type, to_user_id, rawsize,
 * rawfilemd5, filesize (ciphertext size), aeskey (hex), no_need_thumb.
 */
export async function getUploadUrl(params) {
    const rawText = await apiPostFetch({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/getuploadurl',
        body: JSON.stringify({
            filekey: params.filekey,
            media_type: params.mediaType,
            to_user_id: params.toUserId,
            rawsize: params.rawsize,
            rawfilemd5: params.rawfilemd5,
            filesize: params.filesize,
            no_need_thumb: true,
            aeskey: params.aeskey,
            base_info: buildBaseInfo(),
        }),
        token: params.token,
        timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    });
    return JSON.parse(rawText);
}
/**
 * Notify the gateway that this channel client is starting. Without it the
 * server may ack sends (ret=0) but never deliver them to the WeChat client —
 * observed after abrupt restarts. Called once at gateway boot.
 *
 * P0-3: returns the parsed response so the caller can check `ret` — a
 * rejected announce must not leave the gateway claiming a healthy 'polling'
 * state (the official client warns on ret!==0; channel.ts:431-441).
 */
export async function notifyStart(params) {
    const rawText = await apiPostFetch({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/msg/notifystart',
        body: JSON.stringify({ base_info: buildBaseInfo() }),
        token: params.token,
        timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    });
    return JSON.parse(rawText);
}
/** Notify the gateway that this channel client is stopping. Same ret check. */
export async function notifyStop(params) {
    const rawText = await apiPostFetch({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/msg/notifystop',
        body: JSON.stringify({ base_info: buildBaseInfo() }),
        token: params.token,
        timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    });
    return JSON.parse(rawText);
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
export async function fetchQrCode(params) {
    const localTokenList = (params.localTokenList ?? []).filter((t) => t.trim()).slice(0, 10);
    const rawText = await apiPostFetch({
        baseUrl: params.baseUrl ?? LOGIN_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(params.botType ?? DEFAULT_BOT_TYPE)}`,
        body: JSON.stringify({ local_token_list: localTokenList }),
        timeoutMs: params.timeoutMs,
    });
    return JSON.parse(rawText);
}
/**
 * Long-poll the QR status. Network errors and client-side timeouts degrade
 * to `wait` so the caller keeps polling.
 */
export async function pollQrStatus(params) {
    try {
        let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
        if (params.verifyCode) {
            endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
        }
        const rawText = await apiGetFetch({
            baseUrl: params.baseUrl ?? LOGIN_BASE_URL,
            endpoint,
            timeoutMs: params.timeoutMs ?? QR_LONG_POLL_TIMEOUT_MS,
        });
        return JSON.parse(rawText);
    }
    catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            return { status: 'wait' };
        }
        return { status: 'wait' };
    }
}
//# sourceMappingURL=ilink-client.js.map