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
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { LOGIN_BASE_URL, fetchQrCode, getConfig, getUpdates, pollQrStatus, sendMessage, sendTyping, } from "./ilink-client.js";
import { ILINK_BASE_URL, ITEM_TEXT, MESSAGE_DEDUP_TTL_SECONDS, MESSAGE_TYPE_USER, SESSION_EXPIRED_ERRCODE, } from "./types.js";
export const Config = z.object({
    baseUrl: z.string().default(ILINK_BASE_URL),
    cdnBaseUrl: z.string().default(''),
    token: z.string().default(''),
    accountId: z.string().default(''),
});
export class WechatGateway extends Service {
    static Config = Config;
    status = 'unauthenticated';
    ctx;
    c;
    stopPolling = false;
    pollAbort = null;
    seenMsgIds = new Map();
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
        this.status = 'polling';
        void this.pollLoop(creds);
    }
    // ---------------------------------------------------------------- QR login
    /**
     * Run the iLink QR login flow. On success returns the credentials; the
     * caller persists them (e.g. via the credentials service).
     */
    async loginQr(opts = {}) {
        const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
        const pollIntervalMs = opts.qrPollIntervalMs ?? 1500;
        this.status = 'pairing';
        const startedAt = Date.now();
        let qr = await fetchQrCode({ botType: opts.botType });
        opts.onQr?.({ scanData: qr.qrcode, imgContent: qr.qrcode_img_content });
        let baseUrl = LOGIN_BASE_URL;
        while (Date.now() - startedAt < timeoutMs) {
            const st = await pollQrStatus({ baseUrl, qrcode: qr.qrcode });
            switch (st.status) {
                case 'confirmed':
                    this.status = 'polling';
                    return {
                        success: true,
                        credentials: {
                            accountId: st.ilink_bot_id,
                            botToken: st.bot_token,
                            baseUrl: st.baseurl || baseUrl,
                            ilinkUserId: st.ilink_user_id,
                        },
                        message: '登录成功',
                    };
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
                    opts.onQr?.({ scanData: qr.qrcode, imgContent: qr.qrcode_img_content });
                    break;
                case 'need_verifycode':
                    // M1: CLI flow can't supply the code interactively; surface and keep polling.
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
    // ---------------------------------------------------------------- poll loop
    async pollLoop(creds) {
        const baseUrl = creds.baseUrl || this.c.baseUrl;
        const token = creds.botToken;
        let buf = '';
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
                if (batch.errcode === SESSION_EXPIRED_ERRCODE) {
                    this.status = 'paused';
                    this.ctx.logger.warn('[dsh-wechat-bridge] 会话过期(-14)，10 分钟后重试');
                    await new Promise((r) => setTimeout(r, 10 * 60_000));
                    continue;
                }
                buf = batch.get_updates_buf ?? buf;
                this.handleBatch(batch.msgs ?? []);
                this.status = 'polling';
            }
            catch (err) {
                failures += 1;
                this.ctx.logger.warn('[dsh-wechat-bridge] poll 失败(%d/3): %s', failures, String(err));
                await new Promise((r) => setTimeout(r, 2_000));
            }
            finally {
                this.pollAbort = null;
            }
        }
        this.status = 'stopped';
    }
    handleBatch(msgs) {
        const now = Date.now();
        for (const msg of msgs) {
            if (msg.message_type !== MESSAGE_TYPE_USER)
                continue;
            const id = msg.message_id;
            if (id !== undefined && id !== null) {
                const seenAt = this.seenMsgIds.get(id);
                if (seenAt !== undefined && now - seenAt < MESSAGE_DEDUP_TTL_SECONDS * 1000)
                    continue;
                this.seenMsgIds.set(id, now);
                if (this.seenMsgIds.size > 500) {
                    for (const [k, v] of this.seenMsgIds) {
                        if (now - v > MESSAGE_DEDUP_TTL_SECONDS * 1000)
                            this.seenMsgIds.delete(k);
                    }
                }
            }
            const senderId = msg.from_user_id ?? '';
            if (!senderId)
                continue;
            const payload = {
                message: msg,
                senderId,
                contextToken: msg.context_token,
            };
            const text = msg.item_list
                ?.filter((item) => item.type === ITEM_TEXT)
                .map((item) => item.text_item?.text ?? '')
                .join('');
            this.ctx.emit('wechat/message', payload);
            if (text) {
                this.ctx.logger.info('[dsh-wechat-bridge] inbound from %s: %s', senderId, text.slice(0, 120));
            }
        }
    }
    // ---------------------------------------------------------------- outbound
    /** Send a text message to a peer. Returns true on success. */
    async sendText(params) {
        const creds = params.creds ?? (await this.resolveCredentials());
        if (!creds?.botToken)
            return false;
        try {
            await sendMessage({
                baseUrl: creds.baseUrl || this.c.baseUrl,
                token: creds.botToken,
                body: {
                    to_user_id: params.toUserId,
                    context_token: params.contextToken,
                    item_list: [{ type: ITEM_TEXT, text_item: { text: params.text } }],
                },
            });
            return true;
        }
        catch (err) {
            this.ctx.logger.warn('[dsh-wechat-bridge] sendText failed: %s', String(err));
            return false;
        }
    }
    /** Send a typing indicator (1 = typing, 2 = cancel). */
    async sendTypingIndicator(params) {
        const creds = params.creds ?? (await this.resolveCredentials());
        if (!creds?.botToken)
            return;
        try {
            const cfg = await getConfig({
                baseUrl: creds.baseUrl || this.c.baseUrl,
                token: creds.botToken,
                ilinkUserId: params.toUserId,
                contextToken: params.contextToken,
            });
            if (!cfg.typing_ticket)
                return;
            await sendTyping({
                baseUrl: creds.baseUrl || this.c.baseUrl,
                token: creds.botToken,
                ilinkUserId: params.toUserId,
                typingTicket: cfg.typing_ticket,
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