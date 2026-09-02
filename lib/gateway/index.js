/**
 * wechat-gateway plugin: the iLink gateway as a Cordis service (`ctx.wechat`).
 *
 * Owns: QR login (loginQr), authenticated long-poll loop with reconnect
 * backoff, inbound dedup, send retry, the typing indicator, and credential
 * resolution (config fallback + dsh-credentials service). Emits scoped
 * `inbound` events consumed by the conversation node.
 *
 * Protocol client derived from Tencent/openclaw-weixin (MIT).
 *
 * @module dsh-wechat-bridge/gateway
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import QRCode from 'qrcode';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { LOGIN_BASE_URL, fetchQrCode, getConfig, getUpdates, getUploadUrl, notifyStart, notifyStop, classifyFetchError, setBotAgent, pollQrStatus, sendMessage, sendTyping, IlinkSendError, } from "./ilink-client.js";
import { ILINK_BASE_URL, ITEM_FILE, ITEM_IMAGE, ITEM_TEXT, ITEM_VIDEO, MESSAGE_TYPE_USER, UPLOAD_MEDIA_FILE, UPLOAD_MEDIA_IMAGE, UPLOAD_MEDIA_VIDEO, WEIXIN_CDN_BASE_URL, classifyPollBatch, classifySendFailure, sanitizeBaseUrl, } from "./types.js";
import { downloadImage as downloadImageMedia, downloadMediaObject as downloadMediaObjectMedia } from "./media.js";
import { aesEcbPaddedSize, buildOutboundMediaItem, md5Hex, randomHex, uploadBufferToCdn, UPLOAD_MAX_BYTES, } from "./upload.js";
import { debugLogEvent, debugLogMediaCapture } from "../debug-log.js";
import { PollCursorStore, SeenStore } from "../seen.js";
const POLL_RECONNECT_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];
export const Config = z.object({
    baseUrl: z.string().default(ILINK_BASE_URL),
    cdnBaseUrl: z.string().default(WEIXIN_CDN_BASE_URL),
    token: z.string().default(''),
    accountId: z.string().default(''),
    trustedBaseHosts: z.array(z.string()).default([]),
    trustedMediaHosts: z.array(z.string()).default([]),
    botAgent: z.string(),
});
/**
 * F5: log only the trailing 12 chars of a context token — the debug sinks
 * are plaintext JSONL under $DSH_HOME and must not carry full tokens.
 */
export function redactContextToken(token) {
    return token ? token.slice(-12) : null;
}
/**
 * F5: deep-copy the media-relevant layers of an inbound item (never mutate
 * the live object) and replace AES keys with '<redacted>' before any log or
 * capture sink sees them. Walks only the KNOWN layers — image/file/voice/
 * video items plus their media/thumb_media sub-objects — no full recursion.
 */
export function redactItemForCapture(item) {
    const redactObj = (obj) => {
        const out = { ...obj };
        for (const key of ['aeskey', 'aes_key']) {
            if (key in out)
                out[key] = '<redacted>';
        }
        for (const subKey of ['media', 'thumb_media']) {
            const sub = out[subKey];
            if (sub !== undefined && sub !== null && typeof sub === 'object') {
                out[subKey] = redactObj({ ...sub });
            }
        }
        return out;
    };
    const clone = { ...item };
    for (const layerKey of ['image_item', 'file_item', 'voice_item', 'video_item']) {
        const layer = clone[layerKey];
        if (!layer)
            continue;
        clone[layerKey] = redactObj({ ...layer });
    }
    return clone;
}
/**
 * P1-5: fetch a remote http(s) media object for outbound forwarding.
 * Guards: private/loopback/link-local hosts are refused (the URL comes from
 * model output and must not become an internal-network probe), the body is
 * streamed with the same byte cap as uploads, and the whole exchange runs
 * under a 30s timeout.
 */
function isPrivateAddress(address) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (net.isIPv4(normalized)) {
        const octets = normalized.split('.').map(Number);
        const first = octets[0] ?? -1;
        const second = octets[1] ?? -1;
        return first === 0 || first === 10 || first === 100 && second >= 64 && second <= 127 || first === 127 ||
            first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 ||
            first === 192 && second === 0 || first === 192 && second === 168 || first === 198 && second >= 18 && second <= 19 ||
            first >= 224;
    }
    if (!net.isIPv6(normalized))
        return false;
    const compact = normalized.replace(/^::ffff:/, '');
    if (compact !== normalized && net.isIPv4(compact))
        return isPrivateAddress(compact);
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
        normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
}
async function assertPublicMediaUrl(url) {
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        throw new Error(`refusing to fetch media from private/loopback host: ${host}`);
    }
    const addresses = net.isIP(host) ? [host] : await dns.lookup(host, { all: true }).then((results) => results.map((r) => r.address));
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
        throw new Error(`refusing to fetch media from private/loopback host: ${host}`);
    }
}
export async function fetchRemoteMedia(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        throw new Error(`invalid media URL: ${rawUrl.slice(0, 120)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error(`unsupported media URL scheme: ${url.protocol}`);
    for (let hop = 0; hop <= 3; hop += 1) {
        await assertPublicMediaUrl(url);
        const res = await fetch(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (!location || hop === 3)
                throw new Error('remote media redirect rejected');
            url = new URL(location, url);
            if (url.protocol !== 'http:' && url.protocol !== 'https:')
                throw new Error('remote media redirect scheme rejected');
            continue;
        }
        if (!res.ok)
            throw new Error(`remote media download failed: ${res.status} ${res.statusText}`);
        const contentLength = Number(res.headers.get('content-length') ?? '') || 0;
        if (contentLength > UPLOAD_MAX_BYTES)
            throw new Error(`remote media too large: ${contentLength} bytes > ${UPLOAD_MAX_BYTES}`);
        const chunks = [];
        let total = 0;
        if (res.body)
            for await (const chunk of res.body) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buf.length;
                if (total > UPLOAD_MAX_BYTES)
                    throw new Error(`remote media too large: ${total} bytes > ${UPLOAD_MAX_BYTES}`);
                chunks.push(buf);
            }
        return Buffer.concat(chunks);
    }
    throw new Error('remote media redirect rejected');
}
export class WechatGateway extends Service {
    static Config = Config;
    /** Pull the credentials service in from sibling loader entries. */
    static inject = ['credentials'];
    status = 'unauthenticated';
    ctx;
    c;
    stopPolling = false;
    pollAbort = null;
    /** Durable inbound dedup — survives restart. */
    seen = new SeenStore();
    /** Durable get_updates_buf cursor, tagged with its bot identity. */
    pollCursorStore = new PollCursorStore();
    /** Last send failure facts for the status panel and outbox pause display. */
    lastSendError = null;
    // ---- C3/H4: pending pairing (new account scanned while another is paired) ----
    /** Full stashed credentials of the pending pairing (kept private). */
    pendingCreds = null;
    /** P2-6: when the held identity switch was stashed (TTL-checked on use). */
    pendingCredsAt = 0;
    static PENDING_CREDS_TTL_MS = 10 * 60_000;
    get pendingCredsFresh() {
        if (this.pendingCreds === null)
            return false;
        if (Date.now() - this.pendingCredsAt <= WechatGateway.PENDING_CREDS_TTL_MS)
            return true;
        this.pendingCreds = null;
        this.pendingCredsAt = 0;
        this.pairingMessage = '';
        debugLogEvent({ event: 'pairing-pending-expired' });
        return false;
    }
    /**
     * C3: a pairing awaiting panel confirmation. Only the pairer's ids are
     * exposed — the full credentials stay private until confirmPairing().
     */
    get pendingPair() {
        if (!this.pendingCreds || !this.pendingCredsFresh)
            return null;
        return { userId: this.pendingCreds.ilinkUserId ?? null, accountId: this.pendingCreds.accountId ?? null };
    }
    // ---- M2: unified poll-loop lifecycle (single concurrent loop) ----
    pollRunning = false;
    /** Bumped on every stop/start so a superseded loop exits promptly. */
    pollGeneration = 0;
    /** Lifetime promise of the current loop (its wrapper chain). */
    pollLoopPromise = null;
    // ---- typing-ticket cache (port of the official WeixinConfigManager) ----
    // getConfig is an extra API call per indicator; caching keeps bursts from
    // consuming the channel's rate budget. TTL 24h, exponential backoff 2s→1h.
    // Keyed per user like the official per-account cache.
    typingTickets = new Map();
    ticketRetryAt = 0;
    ticketBackoffMs = 2_000;
    // ---- P2-3: health snapshot inputs (single-account equivalent of the
    // official ChannelAccountSnapshot + named-reason health policy) ----
    bootedAt = Date.now();
    /** Consecutive poll failures right now (0 = healthy flow). */
    pollFailures = 0;
    lastInboundAt = null;
    lastOutboundAt = null;
    constructor(ctx, config) {
        super(ctx, 'wechat');
        this.ctx = ctx;
        this.c = config;
        // P2-2: install the configured bot_agent before any API call.
        setBotAgent(this.c.botAgent);
        ctx.effect(() => {
            this.ctx.logger.info('[dsh-wechat-bridge] wechat-gateway mounted (status=%s, baseUrl=%s)', this.status, this.c.baseUrl);
            void this.boot();
            return () => {
                this.status = 'stopped';
                this.stopPolling = true;
                this.pollAbort?.abort();
                this.seen.dispose();
                this.pollCursorStore.dispose();
                // Best-effort farewell so the server flips the channel state promptly.
                void this.resolveCredentials().then((creds) => {
                    if (creds?.botToken) {
                        return notifyStop({ baseUrl: creds.baseUrl || this.c.baseUrl, token: creds.botToken });
                    }
                    return undefined;
                }).catch(() => { });
                this.ctx.logger.info('[dsh-wechat-bridge] wechat-gateway disposed');
            };
        });
    }
    /** Resolve credentials: explicit config first, then the credentials service. */
    async resolveCredentials() {
        if (this.c.token.trim()) {
            return { accountId: this.c.accountId, botToken: this.c.token, baseUrl: this.c.baseUrl };
        }
        try {
            const token = (await this.ctx.credentials.resolve(credentialRef('WEIXIN_BOT_TOKEN')))?.value;
            const accountId = (await this.ctx.credentials.resolve(credentialRef('WEIXIN_ACCOUNT_ID')))?.value;
            const baseUrl = (await this.ctx.credentials.resolve(credentialRef('WEIXIN_BASE_URL')))?.value;
            if (typeof token === 'string' && token.trim()) {
                return {
                    accountId: typeof accountId === 'string' ? accountId : undefined,
                    botToken: token,
                    // H1: re-validate the persisted baseUrl (self-heal historical
                    // pollution: http URLs, foreign hosts, bare hostnames).
                    baseUrl: typeof baseUrl === 'string' && baseUrl.trim()
                        ? sanitizeBaseUrl(baseUrl, LOGIN_BASE_URL, this.c.trustedBaseHosts)
                        : this.c.baseUrl,
                };
            }
        }
        catch (err) {
            this.ctx.logger.warn('[dsh-wechat-bridge] credentials resolve failed: %s', String(err));
        }
        return null;
    }
    async boot() {
        const creds = await this.resolveCredentials();
        if (!creds) {
            this.status = 'unauthenticated';
            return;
        }
        // Announce this poller to the gateway — without it the server may accept
        // sends but never deliver them after an abrupt restart.
        try {
            const announced = await notifyStart({ baseUrl: creds.baseUrl || this.c.baseUrl, token: creds.botToken });
            // P0-3: a rejected announce (ret!==0) must not leave the gateway
            // claiming a healthy 'polling' state — surface it as 'paused' with a
            // pairing hint, mirroring the official ret!==0 warning.
            if (announced.ret !== undefined && announced.ret !== 0) {
                debugLogEvent({ event: 'notify-start', ok: false, ret: announced.ret, errmsg: announced.errmsg });
                this.ctx.logger.warn('[dsh-wechat-bridge] notifyStart 被拒绝 (ret=%s errmsg=%s) — 置为 paused，请重新扫码配对', announced.ret, announced.errmsg ?? '');
                this.status = 'paused';
                this.pairingMessage = '上线通告被服务器拒绝，请重新扫码配对';
                return;
            }
            debugLogEvent({ event: 'notify-start', ok: true });
        }
        catch (err) {
            debugLogEvent({ event: 'notify-start', ok: false, error: String(err).slice(0, 200) });
            this.status = 'paused';
            this.pairingMessage = '上线通告失败，请检查网络后重新配对';
            this.ctx.logger.warn('[dsh-wechat-bridge] notifyStart 失败，暂停轮询: %s', String(err).slice(0, 200));
            return;
        }
        this.status = 'polling';
        void this.startPollLoop(creds);
    }
    // ---------------------------------------------------------------- QR login
    /** Persist credentials through the dsh credentials service. */
    async saveCredentials(creds) {
        if (creds.accountId)
            await this.ctx.credentials.set(credentialRef('WEIXIN_ACCOUNT_ID'), creds.accountId);
        if (creds.botToken)
            await this.ctx.credentials.set(credentialRef('WEIXIN_BOT_TOKEN'), creds.botToken);
        if (creds.baseUrl)
            await this.ctx.credentials.set(credentialRef('WEIXIN_BASE_URL'), creds.baseUrl);
        // The pairer's own WeChat id: the QR scan IS the trust action, so this id
        // is auto-allowlisted by the bridge node (allowFrom becomes optional).
        if (creds.ilinkUserId)
            await this.ctx.credentials.set(credentialRef('WEIXIN_ILINK_USER_ID'), creds.ilinkUserId);
    }
    /** Shared QR pairing loop used by both the CLI login and the settings panel. */
    async runPairing(opts) {
        const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
        const pollIntervalMs = opts.qrPollIntervalMs ?? 1500;
        this.status = 'pairing';
        const startedAt = Date.now();
        const emitQr = (qr) => {
            // `qrcode` is the POLLING token; `qrcode_img_content` is the scannable
            // URL (a plain string, not base64 — official client renders it as-is).
            opts.onQr?.({ scanData: qr.qrcode_img_content || qr.qrcode, pollToken: qr.qrcode });
        };
        try {
            // P0-2: report already-bound bot tokens so the server can answer
            // binded_redirect for an existing binding instead of issuing a
            // duplicate session (official getLocalBotTokenList, max 10).
            const existingToken = (await this.resolveCredentials())?.botToken;
            let qr = await fetchQrCode({ botType: opts.botType, localTokenList: existingToken ? [existingToken] : [] });
            emitQr(qr);
            let baseUrl = LOGIN_BASE_URL;
            // P0-1: shared refresh budget for expired / verify_code_blocked — the
            // official MAX_QR_REFRESH_COUNT=3 caps both (login-qr.ts:331-388) so a
            // risk-controlled login cannot spin until the overall timeout.
            const MAX_QR_REFRESH_COUNT = 3;
            let qrRefreshCount = 0;
            let pendingVerifyCode = null;
            while (Date.now() - startedAt < timeoutMs) {
                const st = await pollQrStatus({ baseUrl, qrcode: qr.qrcode, verifyCode: pendingVerifyCode ?? undefined });
                switch (st.status) {
                    case 'confirmed': {
                        const creds = {
                            accountId: st.ilink_bot_id,
                            botToken: st.bot_token,
                            baseUrl: sanitizeBaseUrl(st.baseurl, baseUrl, this.c.trustedBaseHosts),
                            ilinkUserId: st.ilink_user_id,
                        };
                        const existing = await this.resolveCredentials();
                        const sameIdentity = existing != null &&
                            ((existing.accountId != null && existing.accountId === creds.accountId) ||
                                (existing.botToken != null && existing.botToken === creds.botToken));
                        if (!existing || sameIdentity) {
                            // Same account (or first pairing): keep the current behavior.
                            await opts.onConfirmed(creds);
                            const tokenChanged = existing != null && existing.botToken != null && existing.botToken !== creds.botToken;
                            // M2: a refreshed token for the SAME account must tear down the
                            // old loop (abort + await exit) and restart via the unified entry.
                            if (opts.startPolling && (!existing || tokenChanged)) {
                                void this.startPollLoop(creds);
                            }
                            this.status = 'polling';
                            // Product event: the pairer's WeChat id is now the trust anchor —
                            // the bridge node reacts with a first-run welcome message.
                            if (creds.ilinkUserId) {
                                this.ctx.emit('wechat/paired', { userId: creds.ilinkUserId, accountId: creds.accountId ?? null });
                            }
                            return { success: true, credentials: creds, message: '登录成功' };
                        }
                        // C3/H4: a DIFFERENT account scanned. Never overwrite the saved
                        // credentials — stash them pending panel confirmation; the
                        // existing poll loop keeps running with the old account.
                        this.pendingCreds = creds;
                        this.pendingCredsAt = Date.now();
                        this.pairingMessage = '检测到新账号扫码，等待面板确认';
                        this.status = 'polling';
                        this.ctx.emit('wechat/pair-pending', {
                            userId: creds.ilinkUserId ?? null,
                            accountId: creds.accountId ?? null,
                        });
                        return { success: true, credentials: creds, message: '检测到新账号扫码，等待面板确认' };
                    }
                    case 'scaned_but_redirect':
                        // H1: only follow redirects to trusted hosts.
                        baseUrl = sanitizeBaseUrl(st.redirect_host, baseUrl, this.c.trustedBaseHosts);
                        opts.onStatus?.('scaned_but_redirect');
                        break;
                    case 'binded_redirect':
                        // Already bound: existing local credentials remain valid.
                        this.status = 'polling';
                        return { success: true, credentials: undefined, message: '已绑定，沿用现有凭据' };
                    case 'expired': {
                        opts.onStatus?.('expired');
                        qrRefreshCount += 1;
                        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
                            // Official login-qr.ts:331-336: give up after the cap instead of
                            // spinning fresh QRs until the overall timeout.
                            const creds0 = await this.resolveCredentials();
                            this.status = creds0?.botToken ? 'polling' : 'unauthenticated';
                            return { success: false, message: `二维码已过期 ${qrRefreshCount - 1} 次，请重新发起配对` };
                        }
                        pendingVerifyCode = null;
                        qr = await fetchQrCode({ baseUrl, botType: opts.botType, localTokenList: existingToken ? [existingToken] : [] });
                        emitQr(qr);
                        break;
                    }
                    case 'need_verifycode': {
                        opts.onStatus?.('need_verifycode');
                        if (!opts.onVerifyCodeNeeded)
                            break;
                        const code = await opts.onVerifyCodeNeeded();
                        if (code && code.trim()) {
                            // Carry the code into the very next poll (official resumes
                            // polling with verify_code immediately, login-qr.ts:321-330).
                            pendingVerifyCode = code.trim();
                        }
                        break;
                    }
                    case 'verify_code_blocked': {
                        opts.onStatus?.('verify_code_blocked');
                        qrRefreshCount += 1;
                        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
                            const creds0 = await this.resolveCredentials();
                            this.status = creds0?.botToken ? 'polling' : 'unauthenticated';
                            return { success: false, message: '验证码尝试过多被临时限制，请稍后再试' };
                        }
                        // Official: drop the stale code and reissue a fresh QR.
                        pendingVerifyCode = null;
                        qr = await fetchQrCode({ baseUrl, botType: opts.botType, localTokenList: existingToken ? [existingToken] : [] });
                        emitQr(qr);
                        break;
                    }
                    default:
                        opts.onStatus?.(st.status);
                }
                await new Promise((r) => setTimeout(r, pollIntervalMs));
            }
            // Timeout (M3): keep 'polling' when credentials exist — a timed-out
            // pairing must not fake an unauthenticated gateway.
            const creds = await this.resolveCredentials();
            this.status = creds?.botToken ? 'polling' : 'unauthenticated';
            return { success: false, message: '登录超时' };
        }
        catch (err) {
            // M3: any pairing exception (including fetchQrCode failures) must be
            // contained — log, reset status per credentials, drop the stale QR.
            this.ctx.logger.warn('[dsh-wechat-bridge] pairing failed: %s', String(err));
            const creds = await this.resolveCredentials();
            this.status = creds?.botToken ? 'polling' : 'unauthenticated';
            this.pairingQr = null;
            return { success: false, message: `配对失败: ${err instanceof Error ? err.message : String(err)}` };
        }
        finally {
            // Defensive: never leave the gateway stuck in 'pairing'.
            if (this.status === 'pairing') {
                const creds = await this.resolveCredentials();
                this.status = creds?.botToken ? 'polling' : 'unauthenticated';
            }
        }
    }
    /**
     * Run the iLink QR login flow. On success returns the credentials; the
     * caller persists them (e.g. via the credentials service).
     */
    async loginQr(opts = {}) {
        const result = await this.runPairing({
            botType: opts.botType,
            timeoutMs: opts.timeoutMs,
            qrPollIntervalMs: opts.qrPollIntervalMs,
            onQr: opts.onQr,
            onStatus: opts.onStatus,
            onVerifyCodeNeeded: opts.onVerifyCodeNeeded,
            onConfirmed: async () => { },
        });
        return result;
    }
    /** Pairing state surfaced to the Web settings panel. */
    pairingQr = null;
    pairingMessage = '';
    /** P0-1: true while the pairing loop is waiting for a numeric verify code. */
    needVerifyCode = false;
    verifyCodeResolver = null;
    /**
     * Panel-side verify-code source: parks the pairing loop on a deferred that
     * `submitVerifyCode` resolves. Times out to null after 2 minutes so the
     * loop re-arms on the next need_verifycode until the overall timeout.
     */
    awaitPanelVerifyCode() {
        if (this.verifyCodeResolver)
            this.verifyCodeResolver(null);
        return new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    this.verifyCodeResolver = null;
                    this.needVerifyCode = false;
                    resolve(null);
                }
            }, 2 * 60_000);
            timer.unref?.();
            this.verifyCodeResolver = (code) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                this.verifyCodeResolver = null;
                this.needVerifyCode = false;
                resolve(code);
            };
            this.needVerifyCode = true;
            this.pairingMessage = '需要验证码：请在微信查看数字验证码并填入输入框';
        });
    }
    /** P0-1: submit a numeric verify code from the panel (or tests). */
    submitVerifyCode(code) {
        const trimmed = code.trim();
        if (!this.verifyCodeResolver)
            return false;
        this.verifyCodeResolver(trimmed || null);
        return true;
    }
    /**
     * Start a pairing from the Web settings panel: renders the QR as SVG,
     * auto-refreshes on expiry, and persists credentials on confirm.
     */
    async startPairing() {
        if (this.status === 'pairing') {
            if (this.pairingQr)
                return this.pairingQr;
            throw new Error('pairing already in progress');
        }
        void this.runPairing({
            timeoutMs: 10 * 60_000,
            startPolling: true,
            onQr: (qr) => {
                void QRCode.toString(qr.scanData, { type: 'svg', margin: 2, width: 420 })
                    .then((svg) => {
                    this.pairingQr = { scanData: qr.scanData, svg };
                })
                    .catch(() => { });
            },
            onStatus: (status) => {
                this.pairingMessage = String(status);
            },
            onVerifyCodeNeeded: () => this.awaitPanelVerifyCode(),
            onConfirmed: async (creds) => {
                // Persisting here; the poll-loop start/restart is handled by the
                // confirmed branch through the unified entry (M2).
                await this.saveCredentials(creds);
            },
        }).catch((err) => {
            this.ctx.logger.warn('[dsh-wechat-bridge] pairing failed: %s', String(err));
        });
        // Wait until the first QR is available.
        const deadline = Date.now() + 15_000;
        while (!this.pairingQr && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 250));
        }
        if (!this.pairingQr)
            throw new Error('QR 获取超时');
        return this.pairingQr;
    }
    /**
     * C3: accept the pending pairing — persist the stashed credentials, stop
     * the old poll loop (abort + await full exit), then restart polling with
     * the new account through the unified entry.
     */
    async confirmPairing() {
        if (!this.pendingCreds || !this.pendingCredsFresh)
            return false;
        const creds = this.pendingCreds;
        this.pendingCreds = null;
        await this.saveCredentials(creds);
        // M2: the old loop must be fully torn down before the new one starts.
        await this.stopPollLoop();
        this.status = 'polling';
        if (creds.ilinkUserId) {
            this.ctx.emit('wechat/paired', { userId: creds.ilinkUserId, accountId: creds.accountId ?? null });
        }
        this.pairingMessage = '';
        void this.startPollLoop(creds);
        return true;
    }
    /** C3: reject the pending pairing — discard the stashed credentials. */
    rejectPairing() {
        if (!this.pendingCreds)
            return false;
        this.pendingCreds = null;
        this.pairingMessage = '';
        return true;
    }
    // ---------------------------------------------------------------- poll loop
    /**
     * M2: unified polling entry — the ONLY place a poll loop is started. If a
     * loop is already running it is superseded (generation bump + in-flight
     * abort) and awaited to full exit before the fresh loop starts, so two
     * loops can never run concurrently, even across a credential switch.
     * Returns the new loop's lifetime promise (callers normally `void` it).
     */
    startPollLoop(creds) {
        // P2-9: a new polling generation may use a new bot identity; never reuse
        // typing tickets issued under the previous credential set.
        this.typingTickets.clear();
        this.pollGeneration += 1;
        const gen = this.pollGeneration;
        const prev = this.pollLoopPromise;
        this.pollAbort?.abort();
        const next = (async () => {
            if (prev)
                await prev;
            if (gen !== this.pollGeneration)
                return; // superseded while waiting
            await this.runPollLoop(creds, gen);
        })();
        this.pollLoopPromise = next;
        void next.catch((err) => this.ctx.logger.warn('[dsh-wechat-bridge] poll loop error: %s', String(err)));
        return next;
    }
    /** M2: stop the current loop and wait for its full exit (no replacement). */
    async stopPollLoop() {
        this.pollGeneration += 1;
        const prev = this.pollLoopPromise;
        this.pollAbort?.abort();
        if (prev)
            await prev;
    }
    /**
     * M2: in-loop sleep that resolves EARLY when the loop is superseded
     * (generation bumped by a stop/start) — a credential switch must not be
     * delayed by a pending 10-minute pause.
     */
    pollSleep(ms) {
        const started = this.pollGeneration;
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            const iv = setInterval(() => {
                if (this.pollGeneration !== started) {
                    clearTimeout(timer);
                    clearInterval(iv);
                    resolve();
                }
            }, 250);
            timer.unref?.();
            iv.unref?.();
        });
    }
    async runPollLoop(creds, gen) {
        if (this.pollRunning)
            return;
        this.pollRunning = true;
        this.status = 'polling';
        try {
            let baseUrl = creds.baseUrl || this.c.baseUrl;
            let token = creds.botToken;
            let accountId = creds.accountId ?? '';
            // Restore the continuation cursor ONLY when it belongs to this bot
            // identity — a re-paired bot must not reuse the old identity's cursor.
            const savedCursor = this.pollCursorStore.load();
            let buf = savedCursor !== null && savedCursor.accountId === accountId ? savedCursor.buf : '';
            let failures = 0;
            while (!this.stopPolling) {
                if (gen !== this.pollGeneration)
                    break; // superseded by a newer loop
                this.pollFailures = failures;
                if (failures >= 3) {
                    this.status = 'paused';
                    this.ctx.logger.warn('[dsh-wechat-bridge] 3 次连续失败，暂停 30s 后重试');
                    await this.pollSleep(30_000);
                    failures = 0;
                }
                this.pollAbort = new AbortController();
                try {
                    const batch = await getUpdates({
                        baseUrl,
                        token,
                        getUpdatesBuf: buf,
                        abortSignal: this.pollAbort.signal,
                    });
                    if (gen !== this.pollGeneration)
                        break;
                    const wasDown = failures > 0;
                    failures = 0;
                    if (wasDown) {
                        // Back online after consecutive failures — tell the peers (the
                        // bridge node broadcasts to trusted senders).
                        this.ctx.emit('wechat/back-online');
                        debugLogEvent({ event: 'poll-recovered' });
                    }
                    // M1: unified dispatch — session-expiry/stale-token (-14, -2+unknown
                    // error, -2+prepare failed) → 10-min pause; rate-limit (-12) → 30s;
                    // any other negative → 5s retry. A bare { ret: -12 } (no errcode)
                    // can never fall into the success path.
                    const cls = classifyPollBatch(batch);
                    if (cls === 'session-expired') {
                        // Session expiry — re-resolve credentials so a fresh pairing
                        // (panel/CLI) takes effect without another restart. The
                        // continuation cursor is KEPT (official monitor semantics): a
                        // stale-token pause is not a reason to replay or skip messages.
                        // Only an actual identity change (re-pair) resets the cursor.
                        this.status = 'paused';
                        this.pairingMessage = '会话过期，若重新扫码配对将自动恢复';
                        debugLogEvent({ event: 'poll-session-expired', ret: batch.ret, errcode: batch.errcode, errmsg: batch.errmsg });
                        this.ctx.logger.warn('[dsh-wechat-bridge] 会话过期(ret=%s errcode=%s)，10 分钟后重试', batch.ret, batch.errcode);
                        await this.pollSleep(10 * 60_000);
                        if (gen !== this.pollGeneration)
                            break; // superseded during the pause
                        const fresh = await this.resolveCredentials();
                        if (fresh?.botToken) {
                            const identityChanged = fresh.botToken !== token;
                            if (identityChanged) {
                                // M2: an actual credential switch mid-poll — tear down this
                                // loop (it is superseded) and restart via the unified entry.
                                // The old identity's cursor must not leak into the new loop.
                                this.pollCursorStore.save(null);
                                void this.startPollLoop(fresh);
                                return;
                            }
                            baseUrl = fresh.baseUrl || this.c.baseUrl;
                            token = fresh.botToken;
                            accountId = fresh.accountId ?? accountId;
                        }
                        continue;
                    }
                    if (cls === 'rate-limit') {
                        this.status = 'paused';
                        debugLogEvent({ event: 'poll-rate-limited', ret: batch.ret, errcode: batch.errcode });
                        await new Promise((r) => setTimeout(r, 30_000));
                        continue;
                    }
                    if (cls === 'generic-negative') {
                        debugLogEvent({ event: 'poll-negative-errcode', ret: batch.ret, errcode: batch.errcode, errmsg: batch.errmsg });
                        await new Promise((r) => setTimeout(r, 5_000));
                        continue;
                    }
                    const nextBuf = batch.get_updates_buf;
                    if (nextBuf && nextBuf !== buf) {
                        buf = nextBuf;
                        this.pollCursorStore.save({ accountId, buf });
                    }
                    this.handleBatch(batch.msgs ?? []);
                    this.status = 'polling';
                    this.pollFailures = 0;
                }
                catch (err) {
                    if (gen !== this.pollGeneration)
                        break;
                    // HTTP 403 = the iLink exclusive lock: another poller owns this
                    // token. Stop loudly instead of retrying forever.
                    if (/status=403/.test(String(err))) {
                        this.status = 'stopped';
                        this.stopPolling = true;
                        this.pairingMessage = '403：同一微信号存在另一个轮询者（唯一轮询锁）';
                        debugLogEvent({ event: 'poll-403-fatal' });
                        this.ctx.logger.warn('[dsh-wechat-bridge] HTTP 403：另一个轮询者持有该微信号的轮询锁，已停止');
                        break;
                    }
                    failures += 1;
                    const classified = classifyFetchError(err);
                    debugLogEvent({ event: 'poll-error', failures, error: String(err).slice(0, 200), type: classified.type, code: classified.code, description: classified.description });
                    this.ctx.logger.warn('[dsh-wechat-bridge] poll 失败(%d/3): %s [type=%s code=%s]', failures, String(err).slice(0, 120), classified.type, classified.code ?? '-');
                    const reconnectDelay = POLL_RECONNECT_BACKOFF_MS[Math.min(failures - 1, POLL_RECONNECT_BACKOFF_MS.length - 1)] ?? 30_000;
                    await new Promise((r) => setTimeout(r, reconnectDelay));
                }
                finally {
                    this.pollAbort = null;
                }
            }
            if (gen === this.pollGeneration)
                this.status = 'stopped';
        }
        finally {
            this.pollRunning = false;
        }
    }
    handleBatch(msgs) {
        for (const msg of msgs) {
            // Observation (2026-08-19): does the server echo non-USER messages
            // (the bot's own sends / system notices) carrying a FRESH
            // context_token? If it does, the bridge could refresh the session
            // window during long turns instead of waiting for the user's next
            // inbound message. Log only token-bearing messages — they are the
            // evidence that matters.
            if (msg.message_type !== MESSAGE_TYPE_USER) {
                if (msg.context_token) {
                    debugLogEvent({
                        event: 'poll-token-bearer',
                        messageType: msg.message_type,
                        token: redactContextToken(msg.context_token),
                        runId: msg.run_id ?? null,
                    });
                }
                continue;
            }
            const id = msg.message_id;
            if (id !== undefined && id !== null) {
                if (this.seen.has(id))
                    continue;
                this.seen.mark(id);
            }
            const senderId = msg.from_user_id ?? '';
            if (!senderId)
                continue;
            this.lastInboundAt = Date.now();
            const payload = {
                message: msg,
                senderId,
                contextToken: msg.context_token,
                runId: msg.run_id,
            };
            const text = msg.item_list
                ?.filter((item) => item.type === ITEM_TEXT)
                .map((item) => item.text_item?.text ?? '')
                .join('');
            debugLogEvent({
                event: 'inbound',
                msgId: id ?? null,
                from: senderId,
                // F5: log only the trailing 12 chars of the context token.
                ctxToken: redactContextToken(msg.context_token),
                runId: msg.run_id ?? null,
                itemTypes: (msg.item_list ?? []).map((i) => i.type),
                text: (text ?? '').slice(0, 120) || null,
                // Media-structure digest (short): the official client's OWN outbound
                // media shape — full-fidelity copies go to media-captures.jsonl.
                mediaItems: (msg.item_list ?? [])
                    .filter((item) => item.type === ITEM_IMAGE || item.type === ITEM_FILE || item.type === ITEM_VIDEO)
                    .map((item) => JSON.stringify(redactItemForCapture(item)).slice(0, 1200)),
            });
            // Full-fidelity media capture: complete inbound media items (verbatim,
            // no truncation) for byte-level shape comparison — the ground truth for
            // the outbound media gate (docs/porting-notes.md §6.1). AES keys are
            // redacted before the item leaves the gateway (F5).
            for (const item of msg.item_list ?? []) {
                if (item.type === ITEM_IMAGE || item.type === ITEM_FILE || item.type === ITEM_VIDEO) {
                    debugLogMediaCapture({ msgId: id ?? null, item: redactItemForCapture(item) });
                }
            }
            this.ctx.emit('wechat/message', payload);
            if (text) {
                this.ctx.logger.info('[dsh-wechat-bridge] inbound from %s: %s', senderId, text.slice(0, 120));
            }
        }
    }
    // ---------------------------------------------------------------- outbound
    /**
     * P2-3: bridge-level health snapshot — the single-account equivalent of the
     * official ChannelAccountSnapshot + named-reason health policy
     * (channel-health-policy.ts / channels-status-issues.ts): health is a
     * named reason, never a bare boolean, and every issue carries a fix hint.
     * Purely read-only — no probes, no sends.
     */
    healthSnapshot() {
        const now = Date.now();
        const uptimeMs = now - this.bootedAt;
        // Named reason: startup grace (60s) so a fresh boot does not read as
        // stale; then consecutive-failure and cursor-staleness reasons.
        let reason = 'healthy';
        let fix = null;
        if (this.status === 'unauthenticated') {
            reason = 'unauthenticated';
            fix = '在设置面板扫码配对';
        }
        else if (this.status === 'pairing') {
            reason = 'pairing';
        }
        else if (uptimeMs < 60_000) {
            reason = 'starting';
        }
        else if (this.status === 'paused') {
            reason = 'paused';
            fix = this.pairingMessage || '等待自动恢复，或重新扫码配对';
        }
        else if (this.pollFailures > 0) {
            reason = 'reconnecting';
            fix = `轮询重试中（${this.pollFailures}/3）——检查本机网络与 DNS；持续失败会自动退避`;
        }
        else if (this.status !== 'polling') {
            reason = 'stopped';
            fix = '重启 dsh web 或检查插件挂载日志';
        }
        const issues = [];
        if (fix)
            issues.push({ reason, fix });
        // Inbound death outranks everything cosmetic: a poll loop that is
        // "up" but not advancing the cursor silently loses messages.
        if (this.status === 'polling' && reason === 'healthy' && this.lastInboundAt === null && uptimeMs > 30 * 60_000) {
            issues.push({
                reason: 'no-inbound-since-boot',
                fix: '启动以来没有收到任何消息——如确有人发过消息，检查 debug.log 的 poll 事件',
            });
        }
        return {
            status: this.status,
            reason,
            issues,
            pollFailures: this.pollFailures,
            lastInboundAt: this.lastInboundAt,
            lastOutboundAt: this.lastOutboundAt,
            uptimeMs,
        };
    }
    /** Download and decrypt an inbound image (M3: image-in-session). */
    async downloadImage(item) {
        return downloadImageMedia({ item, cdnBaseUrl: this.c.cdnBaseUrl, extraTrustedHosts: this.c.trustedMediaHosts });
    } /**
     * P1-1: download and decrypt an inbound file/video object (same hardened
     * CDN pipeline as images; callers name the output file).
     */
    async downloadMediaObject(media) {
        return downloadMediaObjectMedia({ media, cdnBaseUrl: this.c.cdnBaseUrl, extraTrustedHosts: this.c.trustedMediaHosts });
    }
    /** Send one structured message item (text or bot progress card). */
    async sendItem(params) {
        const creds = params.creds ?? (await this.resolveCredentials());
        if (!creds?.botToken) {
            return { ok: false, errmsg: 'no credentials' };
        }
        try {
            const resp = await sendMessage({
                baseUrl: creds.baseUrl || this.c.baseUrl,
                token: creds.botToken,
                body: {
                    to_user_id: params.toUserId,
                    context_token: params.contextToken,
                    run_id: params.runId,
                    item_list: [params.item],
                },
            });
            const result = {
                ok: true,
                ret: resp.ret,
                errcode: resp.errcode,
                errmsg: resp.errmsg,
                messageId: resp.message_id,
            };
            // A success clears the sticky failure banner on the settings panel.
            this.lastSendError = null;
            this.lastOutboundAt = Date.now();
            debugLogEvent({
                event: 'send',
                to: params.toUserId,
                ok: true,
                itemType: params.item.type ?? null,
                len: params.item.text_item?.text?.length ?? null,
                ctxToken: params.contextToken ? `…${params.contextToken.slice(-12)}` : null,
                text: params.item.text_item?.text?.slice(0, 60) ?? null,
            });
            return result;
        }
        catch (err) {
            // Failure classification: an IlinkSendError means the SERVER answered
            // with ret != 0. Most such errors are genuinely non-retryable — except
            // the rate-limit/session-class ret=-2 (protocol.md §5), which the
            // dispatch/outbox layers recover from (tokenless resend / backoff) via
            // `failureClass`. Anything else (fetch timeout/network/HTTP) is
            // transport-level.
            const serverRejected = err instanceof IlinkSendError;
            const failureClass = serverRejected ? classifySendFailure(err.ret, err.errcode, err.errmsg) : undefined;
            // P2-1: network-level classification for the debug sink (dns/tcp/tls/…).
            const netClass = serverRejected ? undefined : classifyFetchError(err);
            // P0 (OpenClaw 2.0 alignment #104632): a send TIMEOUT is an UNCERTAIN
            // outcome — the server may have processed the message, so blind retry
            // risks the "likely duplicate" upstream explicitly avoids. Only a
            // connection that never established (dns/tcp/tls) proves not-sent.
            const uncertain = !serverRejected && netClass?.type === 'timeout';
            const record = {
                ok: false,
                ret: serverRejected ? err.ret : undefined,
                errcode: serverRejected ? err.errcode : undefined,
                errmsg: err instanceof Error ? err.message : String(err),
                retryable: !serverRejected && !uncertain,
                uncertain,
                failureClass,
            };
            this.lastSendError = { errcode: record.errcode, errmsg: (record.errmsg ?? '').slice(0, 200), at: Date.now() };
            debugLogEvent({
                event: 'send',
                to: params.toUserId,
                ...record,
                netErrorType: netClass?.type ?? null,
                netErrorCode: netClass?.code ?? null,
                failureClass: failureClass ?? null,
                itemType: params.item.type ?? null,
                len: params.item.text_item?.text?.length ?? null,
                ctxToken: params.contextToken ? `…${params.contextToken.slice(-12)}` : null,
            });
            return record;
        }
    }
    /** Send a text message to a peer. Returns a structured result. */
    async sendText(params) {
        return this.sendItem({
            toUserId: params.toUserId,
            contextToken: params.contextToken,
            runId: params.runId,
            creds: params.creds,
            item: { type: ITEM_TEXT, text_item: { text: params.text } },
        });
    }
    /**
     * Upload a local file (or a remote http(s) URL, P1-5) to the WeChat CDN and
     * send it as a message item. Full pipeline per the official upload flow:
     * getUploadUrl → AES-128-ECB → CDN POST → sendMessage with the CDN
     * reference. mediaType FILE or IMAGE.
     */
    async uploadAndSendMedia(params) {
        const creds = params.creds ?? (await this.resolveCredentials());
        if (!creds?.botToken)
            return { ok: false, errmsg: 'no credentials' };
        try {
            // P1-5: remote http(s) URLs are fetched first (official
            // downloadRemoteImageToTemp flow), then the rest of the pipeline is
            // identical. Private/loopback hosts are refused: the URL comes from
            // model output, and fetching it must not become an internal-network
            // probe (DNS-rebinding-level defenses are out of scope and noted in
            // docs/porting-notes.md).
            const plaintext = /^https?:\/\//i.test(params.filePath)
                ? await fetchRemoteMedia(params.filePath)
                : fs.readFileSync(params.filePath);
            if (plaintext.length > UPLOAD_MAX_BYTES) {
                return { ok: false, errmsg: `file too large (${plaintext.length} bytes > ${UPLOAD_MAX_BYTES})`, retryable: false };
            }
            const rawsize = plaintext.length;
            const filesize = aesEcbPaddedSize(rawsize);
            const filekey = randomHex(16);
            const aeskey = Buffer.from(randomHex(16), 'hex');
            const slot = await getUploadUrl({
                baseUrl: creds.baseUrl || this.c.baseUrl,
                token: creds.botToken,
                filekey,
                mediaType: params.mediaType,
                toUserId: params.toUserId,
                rawsize,
                rawfilemd5: md5Hex(plaintext),
                filesize,
                aeskey: aeskey.toString('hex'),
            });
            if (slot.ret && slot.ret !== 0) {
                const result = { ok: false, ret: slot.ret, errcode: slot.errcode, errmsg: slot.errmsg, retryable: false };
                this.lastSendError = { errcode: slot.errcode, errmsg: (slot.errmsg ?? '').slice(0, 200), at: Date.now() };
                debugLogEvent({ event: 'send-media', to: params.toUserId, ok: false, ret: slot.ret, errcode: slot.errcode });
                return result;
            }
            const { downloadParam } = await uploadBufferToCdn({
                buf: plaintext,
                uploadFullUrl: slot.upload_full_url,
                uploadParam: slot.upload_param,
                filekey,
                cdnBaseUrl: this.c.cdnBaseUrl,
                aeskey,
                extraTrustedHosts: this.c.trustedMediaHosts,
            });
            if (!downloadParam) {
                return { ok: false, errmsg: 'CDN upload returned no x-encrypted-param', retryable: false };
            }
            // Official outbound shape (verified end-to-end 2026-08-17): the CDN
            // upload response header is the download reference; getUploadUrl's
            // upload_param is NOT recognized by the client renderer (see
            // porting-notes §6.1 FINAL).
            const item = buildOutboundMediaItem({
                mediaType: params.mediaType,
                xep: downloadParam,
                aeskey,
                rawsize,
                fileName: params.fileName,
            });
            return this.sendItem({
                toUserId: params.toUserId,
                contextToken: params.contextToken,
                runId: params.runId,
                creds,
                item,
            });
        }
        catch (err) {
            const record = { ok: false, errmsg: err instanceof Error ? err.message : String(err), retryable: true };
            this.lastSendError = { errmsg: record.errmsg.slice(0, 200), at: Date.now() };
            debugLogEvent({ event: 'send-media', to: params.toUserId, ok: false, error: record.errmsg.slice(0, 200) });
            return record;
        }
    }
    /** Send a local file as a WeChat file attachment. */
    async sendFile(params) {
        return this.uploadAndSendMedia({ ...params, mediaType: UPLOAD_MEDIA_FILE });
    }
    /** Send a local video as a WeChat video message (type=5, verified 2026-08-17). */
    async sendVideo(params) {
        return this.uploadAndSendMedia({ ...params, fileName: path.basename(params.filePath), mediaType: UPLOAD_MEDIA_VIDEO });
    }
    /** Send a local image as a WeChat image message (long-card pipeline). */
    async sendImage(params) {
        return this.uploadAndSendMedia({ ...params, fileName: path.basename(params.filePath), mediaType: UPLOAD_MEDIA_IMAGE });
    }
    /**
     * Resolve a cached typing ticket (port of the official WeixinConfigManager:
     * 24h TTL, exponential backoff 2s→1h on failure), per-user like the
     * official per-account cache.
     */
    async resolveTypingTicket(creds, ilinkUserId, contextToken) {
        const cached = this.typingTickets.get(ilinkUserId);
        if (cached !== undefined && Date.now() < cached.expiresAt) {
            return cached.value;
        }
        // P2-7: stale-while-revalidate — an EXPIRED ticket is still servable
        // (the server tolerates it for a grace window); return it immediately
        // and refresh in the background instead of stalling the typing indicator
        // behind a getConfig round-trip. With no previous ticket at all, fall
        // back to the synchronous fetch.
        if (cached !== undefined && cached.value) {
            if (Date.now() >= this.ticketRetryAt) {
                void this.refreshTypingTicket(creds, ilinkUserId, contextToken);
            }
            return cached.value;
        }
        if (Date.now() < this.ticketRetryAt)
            return null;
        return this.refreshTypingTicket(creds, ilinkUserId, contextToken);
    }
    /** Synchronous ticket refresh used by resolveTypingTicket (also fires async). */
    async refreshTypingTicket(creds, ilinkUserId, contextToken) {
        if (Date.now() < this.ticketRetryAt)
            return null;
        try {
            const cfg = await getConfig({
                baseUrl: creds.baseUrl || this.c.baseUrl,
                token: creds.botToken,
                ilinkUserId,
                contextToken,
            });
            if (cfg.typing_ticket) {
                this.typingTickets.set(ilinkUserId, { value: cfg.typing_ticket, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
                this.ticketBackoffMs = 2_000;
                return cfg.typing_ticket;
            }
        }
        catch {
            // fall through to backoff
        }
        this.ticketRetryAt = Date.now() + this.ticketBackoffMs;
        this.ticketBackoffMs = Math.min(this.ticketBackoffMs * 2, 60 * 60 * 1000);
        return null;
    }
    /** Send a typing indicator (1 = typing, 2 = cancel). */
    async sendTypingIndicator(params) {
        const creds = params.creds ?? (await this.resolveCredentials());
        if (!creds?.botToken)
            return;
        try {
            const ticket = await this.resolveTypingTicket(creds, params.toUserId, params.contextToken);
            if (!ticket)
                return;
            await sendTyping({
                baseUrl: creds.baseUrl || this.c.baseUrl,
                token: creds.botToken,
                ilinkUserId: params.toUserId,
                typingTicket: ticket,
                status: params.status,
            });
        }
        catch (err) {
            // Observation (2026-08-19): typing uses the separate sendTyping API —
            // if it keeps failing while the session window is spent, the indicator
            // shares the same session wall and cannot substitute for heartbeats.
            this.ctx.logger.debug('[dsh-wechat-bridge] typing indicator failed: %s', String(err));
            debugLogEvent({ event: 'typing-failed', to: redactContextToken(params.toUserId), error: String(err).slice(0, 120) });
        }
    }
}
export default WechatGateway;
//# sourceMappingURL=index.js.map