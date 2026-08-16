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
import QRCode from 'qrcode';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { LOGIN_BASE_URL, fetchQrCode, getConfig, getUpdates, getUploadUrl, notifyStart, notifyStop, pollQrStatus, sendMessage, sendTyping, IlinkSendError, } from "./ilink-client.js";
import { ILINK_BASE_URL, ITEM_FILE, ITEM_IMAGE, ITEM_TEXT, ITEM_VIDEO, MESSAGE_TYPE_USER, RATE_LIMIT_ERRCODE, SESSION_EXPIRED_ERRCODE, UPLOAD_MEDIA_FILE, UPLOAD_MEDIA_IMAGE, WEIXIN_CDN_BASE_URL, } from "./types.js";
import { downloadImage as downloadImageMedia } from "./media.js";
import { aesEcbPaddedSize, buildOutboundMediaItem, md5Hex, randomHex, uploadBufferToCdn, UPLOAD_MAX_BYTES, } from "./upload.js";
import { debugLog, debugLogMediaCapture } from "../debug-log.js";
import { PollCursorStore, SeenStore } from "../seen.js";
export const Config = z.object({
    baseUrl: z.string().default(ILINK_BASE_URL),
    cdnBaseUrl: z.string().default(WEIXIN_CDN_BASE_URL),
    token: z.string().default(''),
    accountId: z.string().default(''),
});
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
    // ---- typing-ticket cache (port of the official WeixinConfigManager) ----
    // getConfig is an extra API call per indicator; caching keeps bursts from
    // consuming the channel's rate budget. TTL 24h, exponential backoff 2s→1h.
    // Keyed per user like the official per-account cache.
    typingTickets = new Map();
    ticketRetryAt = 0;
    ticketBackoffMs = 2_000;
    constructor(ctx, config) {
        super(ctx, 'wechat');
        this.ctx = ctx;
        this.c = config;
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
                    baseUrl: typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl : this.c.baseUrl,
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
            await notifyStart({ baseUrl: creds.baseUrl || this.c.baseUrl, token: creds.botToken });
            debugLog({ event: 'notify-start', ok: true });
        }
        catch (err) {
            debugLog({ event: 'notify-start', ok: false, error: String(err).slice(0, 200) });
        }
        this.status = 'polling';
        void this.pollLoop(creds);
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
        let qr = await fetchQrCode({ botType: opts.botType });
        emitQr(qr);
        let baseUrl = LOGIN_BASE_URL;
        while (Date.now() - startedAt < timeoutMs) {
            const st = await pollQrStatus({ baseUrl, qrcode: qr.qrcode });
            switch (st.status) {
                case 'confirmed': {
                    const creds = {
                        accountId: st.ilink_bot_id,
                        botToken: st.bot_token,
                        baseUrl: st.baseurl || baseUrl,
                        ilinkUserId: st.ilink_user_id,
                    };
                    await opts.onConfirmed(creds);
                    this.status = 'polling';
                    // Product event: the pairer's WeChat id is now the trust anchor —
                    // the bridge node reacts with a first-run welcome message.
                    if (creds.ilinkUserId) {
                        this.ctx.emit('wechat/paired', { userId: creds.ilinkUserId, accountId: creds.accountId ?? null });
                    }
                    return { success: true, credentials: creds, message: '登录成功' };
                }
                case 'scaned_but_redirect':
                    baseUrl = st.redirect_host ? `https://${st.redirect_host}` : baseUrl;
                    opts.onStatus?.('scaned_but_redirect');
                    break;
                case 'binded_redirect':
                    // Already bound: existing local credentials remain valid.
                    this.status = 'polling';
                    return { success: true, credentials: undefined, message: '已绑定，沿用现有凭据' };
                case 'expired':
                    opts.onStatus?.('expired');
                    qr = await fetchQrCode({ baseUrl, botType: opts.botType });
                    emitQr(qr);
                    break;
                case 'need_verifycode':
                    opts.onStatus?.('need_verifycode');
                    break;
                case 'verify_code_blocked':
                    opts.onStatus?.('verify_code_blocked');
                    break;
                default:
                    opts.onStatus?.(st.status);
            }
            await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
        this.status = 'unauthenticated';
        return { success: false, message: '登录超时' };
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
            onConfirmed: async () => { },
        });
        return result;
    }
    /** Pairing state surfaced to the Web settings panel. */
    pairingQr = null;
    pairingMessage = '';
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
            onConfirmed: async (creds) => {
                await this.saveCredentials(creds);
                void this.pollLoop(creds);
            },
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
    // ---------------------------------------------------------------- poll loop
    pollRunning = false;
    async pollLoop(creds) {
        if (this.pollRunning)
            return;
        this.pollRunning = true;
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
                if (failures >= 3) {
                    this.status = 'paused';
                    this.ctx.logger.warn('[dsh-wechat-bridge] 3 次连续失败，暂停 30s 后重试');
                    await new Promise((r) => setTimeout(r, 30_000));
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
                    failures = 0;
                    const errcode = batch.errcode;
                    if (errcode === SESSION_EXPIRED_ERRCODE || (errcode === -2 && /unknown error/i.test(batch.errmsg ?? ''))) {
                        // -14 / -2+unknown: session expiry — re-resolve credentials so a
                        // fresh pairing (panel/CLI) takes effect without another restart.
                        // The continuation cursor is KEPT (official monitor semantics): a
                        // stale-token pause is not a reason to replay or skip messages.
                        // Only an actual identity change (re-pair) resets the cursor.
                        this.status = 'paused';
                        this.pairingMessage = '会话过期，若重新扫码配对将自动恢复';
                        debugLog({ event: 'poll-session-expired', errcode, errmsg: batch.errmsg });
                        this.ctx.logger.warn('[dsh-wechat-bridge] 会话过期(%s)，10 分钟后重试', errcode);
                        await new Promise((r) => setTimeout(r, 10 * 60_000));
                        const fresh = await this.resolveCredentials();
                        if (fresh?.botToken) {
                            const identityChanged = fresh.botToken !== token;
                            baseUrl = fresh.baseUrl || this.c.baseUrl;
                            token = fresh.botToken;
                            accountId = fresh.accountId ?? accountId;
                            if (identityChanged) {
                                buf = '';
                                this.pollCursorStore.save(null);
                            }
                        }
                        continue;
                    }
                    if (errcode === RATE_LIMIT_ERRCODE) {
                        this.status = 'paused';
                        debugLog({ event: 'poll-rate-limited' });
                        await new Promise((r) => setTimeout(r, 30_000));
                        continue;
                    }
                    if (errcode !== undefined && errcode < 0) {
                        debugLog({ event: 'poll-negative-errcode', errcode, errmsg: batch.errmsg });
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
                }
                catch (err) {
                    // HTTP 403 = the iLink exclusive lock: another poller owns this
                    // token. Stop loudly instead of retrying forever.
                    if (/status=403/.test(String(err))) {
                        this.status = 'stopped';
                        this.stopPolling = true;
                        this.pairingMessage = '403：同一微信号存在另一个轮询者（唯一轮询锁）';
                        debugLog({ event: 'poll-403-fatal' });
                        this.ctx.logger.warn('[dsh-wechat-bridge] HTTP 403：另一个轮询者持有该微信号的轮询锁，已停止');
                        break;
                    }
                    failures += 1;
                    debugLog({ event: 'poll-error', failures, error: String(err).slice(0, 200) });
                    this.ctx.logger.warn('[dsh-wechat-bridge] poll 失败(%d/3): %s', failures, String(err));
                    await new Promise((r) => setTimeout(r, 2_000));
                }
                finally {
                    this.pollAbort = null;
                }
            }
            this.status = 'stopped';
        }
        finally {
            this.pollRunning = false;
        }
    }
    handleBatch(msgs) {
        for (const msg of msgs) {
            if (msg.message_type !== MESSAGE_TYPE_USER)
                continue;
            const id = msg.message_id;
            if (id !== undefined && id !== null) {
                if (this.seen.has(id))
                    continue;
                this.seen.mark(id);
            }
            const senderId = msg.from_user_id ?? '';
            if (!senderId)
                continue;
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
            debugLog({
                event: 'inbound',
                msgId: id ?? null,
                from: senderId,
                ctxToken: msg.context_token ?? null,
                runId: msg.run_id ?? null,
                itemTypes: (msg.item_list ?? []).map((i) => i.type),
                text: (text ?? '').slice(0, 120) || null,
                // Media-structure digest (short): the official client's OWN outbound
                // media shape — full-fidelity copies go to media-captures.jsonl.
                mediaItems: (msg.item_list ?? [])
                    .filter((item) => item.type === ITEM_IMAGE || item.type === ITEM_FILE || item.type === ITEM_VIDEO)
                    .map((item) => JSON.stringify(item).slice(0, 1200)),
            });
            // Full-fidelity media capture: complete inbound media items (verbatim,
            // no truncation) for byte-level shape comparison — the ground truth for
            // the outbound media gate (docs/porting-notes.md §6.1).
            for (const item of msg.item_list ?? []) {
                if (item.type === ITEM_IMAGE || item.type === ITEM_FILE || item.type === ITEM_VIDEO) {
                    debugLogMediaCapture({ msgId: id ?? null, item });
                }
            }
            this.ctx.emit('wechat/message', payload);
            if (text) {
                this.ctx.logger.info('[dsh-wechat-bridge] inbound from %s: %s', senderId, text.slice(0, 120));
            }
        }
    }
    // ---------------------------------------------------------------- outbound
    /** Download and decrypt an inbound image (M3: image-in-session). */
    async downloadImage(item) {
        return downloadImageMedia({ item, cdnBaseUrl: this.c.cdnBaseUrl });
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
            debugLog({
                event: 'send',
                to: params.toUserId,
                ok: true,
                itemType: params.item.type ?? null,
                len: params.item.text_item?.text?.length ?? null,
                ctxToken: params.contextToken ?? null,
                text: params.item.text_item?.text?.slice(0, 60) ?? null,
                resp,
            });
            return result;
        }
        catch (err) {
            // Failure classification: an IlinkSendError means the SERVER answered
            // with ret != 0 — retrying the same payload cannot succeed. Anything
            // else (fetch timeout/network/HTTP) is transport-level and retryable.
            const serverRejected = err instanceof IlinkSendError;
            const record = {
                ok: false,
                ret: serverRejected ? err.ret : undefined,
                errcode: serverRejected ? err.errcode : undefined,
                errmsg: err instanceof Error ? err.message : String(err),
                retryable: !serverRejected,
            };
            this.lastSendError = { errcode: record.errcode, errmsg: record.errmsg.slice(0, 200), at: Date.now() };
            debugLog({ event: 'send', to: params.toUserId, ...record });
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
     * Upload a local file to the WeChat CDN and send it as a message item.
     * Full pipeline per the official upload flow: getUploadUrl → AES-128-ECB →
     * CDN POST → sendMessage with the CDN reference. mediaType FILE or IMAGE.
     */
    async uploadAndSendMedia(params) {
        const creds = params.creds ?? (await this.resolveCredentials());
        if (!creds?.botToken)
            return { ok: false, errmsg: 'no credentials' };
        try {
            const plaintext = fs.readFileSync(params.filePath);
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
                debugLog({ event: 'send-media', to: params.toUserId, ok: false, ret: slot.ret, errcode: slot.errcode });
                return result;
            }
            const { downloadParam } = await uploadBufferToCdn({
                buf: plaintext,
                uploadFullUrl: slot.upload_full_url,
                uploadParam: slot.upload_param,
                filekey,
                cdnBaseUrl: this.c.cdnBaseUrl,
                aeskey,
            });
            const uploadParam = slot.upload_param?.trim();
            if (!uploadParam) {
                return { ok: false, errmsg: 'getUploadUrl returned no upload_param', retryable: false };
            }
            // full_url must be ABSOLUTE (official-client mirror). Config default is
            // WEIXIN_CDN_BASE_URL; the fallback guards deployments that pinned an
            // empty cdnBaseUrl before the default existed (see porting-notes §6).
            const cdnBase = this.c.cdnBaseUrl || WEIXIN_CDN_BASE_URL;
            const item = buildOutboundMediaItem({
                mediaType: params.mediaType,
                uploadParam,
                aeskey,
                cdnBaseUrl: cdnBase,
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
            debugLog({ event: 'send-media', to: params.toUserId, ok: false, error: record.errmsg.slice(0, 200) });
            return record;
        }
    }
    /** Send a local file as a WeChat file attachment. */
    async sendFile(params) {
        return this.uploadAndSendMedia({ ...params, mediaType: UPLOAD_MEDIA_FILE });
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
            this.ctx.logger.debug('[dsh-wechat-bridge] typing indicator failed: %s', String(err));
        }
    }
}
export default WechatGateway;
//# sourceMappingURL=index.js.map