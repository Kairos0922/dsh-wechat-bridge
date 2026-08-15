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

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import QRCode from 'qrcode'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LOGIN_BASE_URL,
  fetchQrCode,
  getConfig,
  getUpdates,
  notifyStart,
  notifyStop,
  pollQrStatus,
  sendMessage,
  sendTyping,
  type QrLoginStatus,
} from './ilink-client.ts'
import {
  ILINK_BASE_URL,
  ITEM_TEXT,
  MESSAGE_DEDUP_TTL_SECONDS,
  MESSAGE_TYPE_USER,
  SESSION_EXPIRED_ERRCODE,
  type ImageItem,
  type InboundEvent,
  type InboundMessage,
  type WechatCredentials,
} from './types.ts'
import { downloadImage as downloadImageMedia } from './media.ts'
import { debugLog } from '../debug-log.ts'

export interface GatewayConfig {
  baseUrl?: string
  cdnBaseUrl?: string
  token?: string
  accountId?: string
}

export const Config = z.object({
  baseUrl: z.string().default(ILINK_BASE_URL),
  cdnBaseUrl: z.string().default(''),
  token: z.string().default(''),
  accountId: z.string().default(''),
})

export type GatewayStatus = 'unauthenticated' | 'pairing' | 'polling' | 'paused' | 'stopped'

export interface LoginQrOptions {
  /**
   * QR payload: `scanData` is the scannable content (a URL from the server's
   * `qrcode_img_content` field — NOT the polling token), `pollToken` is the
   * hex token used for `get_qrcode_status` polling only.
   */
  onQr?: (qr: { scanData: string; pollToken: string }) => void
  onStatus?: (status: QrLoginStatus | string) => void
  botType?: string
  /** Overall login timeout (ms). Default 5 minutes. */
  timeoutMs?: number
  /** Poll interval for QR status (ms). Default 1500. */
  qrPollIntervalMs?: number
}

export interface LoginQrResult {
  success: boolean
  credentials?: WechatCredentials
  message: string
}

export interface ResolvedGatewayConfig extends Required<GatewayConfig> {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The iLink gateway service provided by the wechat-gateway plugin. */
    wechat: WechatGateway
  }
  interface Events {
    /** One inbound iLink message, deduplicated at the gateway. */
    'wechat/message'(payload: InboundEvent): void
    /** Gateway connection status changed. */
    'wechat/status'(status: GatewayStatus): void
  }
}

export class WechatGateway extends Service {
  static Config = Config
  /** Pull the credentials service in from sibling loader entries. */
  static inject = ['credentials']

  status: GatewayStatus = 'unauthenticated'

  override readonly ctx: Context
  private c: ResolvedGatewayConfig
  private stopPolling = false
  private pollAbort: AbortController | null = null
  private seenMsgIds = new Map<number, number>()

  constructor(ctx: Context, config: GatewayConfig) {
    super(ctx, 'wechat')
    this.ctx = ctx
    this.c = config as ResolvedGatewayConfig
    ctx.effect(() => {
      this.ctx.logger.info(
        '[dsh-wechat-bridge] wechat-gateway mounted (status=%s, baseUrl=%s)',
        this.status,
        this.c.baseUrl,
      )
      void this.boot()
      return () => {
        this.status = 'stopped'
        this.stopPolling = true
        this.pollAbort?.abort()
        // Best-effort farewell so the server flips the channel state promptly.
        void this.resolveCredentials().then((creds) => {
          if (creds?.botToken) {
            return notifyStop({ baseUrl: creds.baseUrl || this.c.baseUrl, token: creds.botToken })
          }
          return undefined
        }).catch(() => {})
        this.ctx.logger.info('[dsh-wechat-bridge] wechat-gateway disposed')
      }
    })
  }

  /** Resolve credentials: explicit config first, then the credentials service. */
  async resolveCredentials(): Promise<WechatCredentials | null> {
    if (this.c.token.trim()) {
      return { accountId: this.c.accountId, botToken: this.c.token, baseUrl: this.c.baseUrl }
    }
    try {
      const token = (await this.ctx.credentials.resolve(credentialRef('WEIXIN_BOT_TOKEN')))?.value
      const accountId = (await this.ctx.credentials.resolve(credentialRef('WEIXIN_ACCOUNT_ID')))?.value
      const baseUrl = (await this.ctx.credentials.resolve(credentialRef('WEIXIN_BASE_URL')))?.value
      if (typeof token === 'string' && token.trim()) {
        return {
          accountId: typeof accountId === 'string' ? accountId : undefined,
          botToken: token,
          baseUrl: typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl : this.c.baseUrl,
        }
      }
    } catch (err) {
      this.ctx.logger.warn('[dsh-wechat-bridge] credentials resolve failed: %s', String(err))
    }
    return null
  }

  private async boot(): Promise<void> {
    const creds = await this.resolveCredentials()
    if (!creds) {
      this.status = 'unauthenticated'
      return
    }
    // Announce this poller to the gateway — without it the server may accept
    // sends but never deliver them after an abrupt restart.
    try {
      await notifyStart({ baseUrl: creds.baseUrl || this.c.baseUrl, token: creds.botToken })
      debugLog({ event: 'notify-start', ok: true })
    } catch (err) {
      debugLog({ event: 'notify-start', ok: false, error: String(err).slice(0, 200) })
    }
    this.status = 'polling'
    void this.pollLoop(creds)
  }

  // ---------------------------------------------------------------- QR login

  /** Persist credentials through the dsh credentials service. */
  async saveCredentials(creds: WechatCredentials): Promise<void> {
    if (creds.accountId) await this.ctx.credentials.set(credentialRef('WEIXIN_ACCOUNT_ID'), creds.accountId)
    if (creds.botToken) await this.ctx.credentials.set(credentialRef('WEIXIN_BOT_TOKEN'), creds.botToken)
    if (creds.baseUrl) await this.ctx.credentials.set(credentialRef('WEIXIN_BASE_URL'), creds.baseUrl)
  }

  /** Shared QR pairing loop used by both the CLI login and the settings panel. */
  private async runPairing(opts: {
    botType?: string
    timeoutMs?: number
    qrPollIntervalMs?: number
    onQr?: (qr: { scanData: string; pollToken: string }) => void
    onStatus?: (status: QrLoginStatus | string) => void
    onConfirmed: (creds: WechatCredentials) => Promise<void>
  }): Promise<{ success: boolean; credentials?: WechatCredentials; message: string }> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000
    const pollIntervalMs = opts.qrPollIntervalMs ?? 1500
    this.status = 'pairing'
    const startedAt = Date.now()

    const emitQr = (qr: { qrcode: string; qrcode_img_content?: string }): void => {
      // `qrcode` is the POLLING token; `qrcode_img_content` is the scannable
      // URL (a plain string, not base64 — official client renders it as-is).
      opts.onQr?.({ scanData: qr.qrcode_img_content || qr.qrcode, pollToken: qr.qrcode })
    }

    let qr = await fetchQrCode({ botType: opts.botType })
    emitQr(qr)

    let baseUrl = LOGIN_BASE_URL
    while (Date.now() - startedAt < timeoutMs) {
      const st = await pollQrStatus({ baseUrl, qrcode: qr.qrcode })
      switch (st.status) {
        case 'confirmed': {
          const creds: WechatCredentials = {
            accountId: st.ilink_bot_id,
            botToken: st.bot_token,
            baseUrl: st.baseurl || baseUrl,
            ilinkUserId: st.ilink_user_id,
          }
          await opts.onConfirmed(creds)
          this.status = 'polling'
          return { success: true, credentials: creds, message: '登录成功' }
        }
        case 'scaned_but_redirect':
          baseUrl = st.redirect_host ? `https://${st.redirect_host}` : baseUrl
          opts.onStatus?.('scaned_but_redirect')
          break
        case 'binded_redirect':
          // Already bound: existing local credentials remain valid.
          this.status = 'polling'
          return { success: true, credentials: undefined, message: '已绑定，沿用现有凭据' }
        case 'expired':
          opts.onStatus?.('expired')
          qr = await fetchQrCode({ baseUrl, botType: opts.botType })
          emitQr(qr)
          break
        case 'need_verifycode':
          opts.onStatus?.('need_verifycode')
          break
        case 'verify_code_blocked':
          opts.onStatus?.('verify_code_blocked')
          break
        default:
          opts.onStatus?.(st.status)
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }
    this.status = 'unauthenticated'
    return { success: false, message: '登录超时' }
  }

  /**
   * Run the iLink QR login flow. On success returns the credentials; the
   * caller persists them (e.g. via the credentials service).
   */
  async loginQr(opts: LoginQrOptions = {}): Promise<LoginQrResult> {
    const result = await this.runPairing({
      botType: opts.botType,
      timeoutMs: opts.timeoutMs,
      qrPollIntervalMs: opts.qrPollIntervalMs,
      onQr: opts.onQr,
      onStatus: opts.onStatus,
      onConfirmed: async () => {},
    })
    return result
  }

  /** Pairing state surfaced to the Web settings panel. */
  pairingQr: { scanData: string; svg: string } | null = null
  pairingMessage: string = ''

  /**
   * Start a pairing from the Web settings panel: renders the QR as SVG,
   * auto-refreshes on expiry, and persists credentials on confirm.
   */
  async startPairing(): Promise<{ svg: string; scanData: string }> {
    if (this.status === 'pairing') {
      if (this.pairingQr) return this.pairingQr
      throw new Error('pairing already in progress')
    }
    void this.runPairing({
      timeoutMs: 10 * 60_000,
      onQr: (qr) => {
        void QRCode.toString(qr.scanData, { type: 'svg', margin: 2, width: 420 })
          .then((svg) => {
            this.pairingQr = { scanData: qr.scanData, svg }
          })
          .catch(() => {})
      },
      onStatus: (status) => {
        this.pairingMessage = String(status)
      },
      onConfirmed: async (creds) => {
        await this.saveCredentials(creds)
        void this.pollLoop(creds)
      },
    })
    // Wait until the first QR is available.
    const deadline = Date.now() + 15_000
    while (!this.pairingQr && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!this.pairingQr) throw new Error('QR 获取超时')
    return this.pairingQr
  }

  // ---------------------------------------------------------------- poll loop

  private pollRunning = false

  private async pollLoop(creds: WechatCredentials): Promise<void> {
    if (this.pollRunning) return
    this.pollRunning = true
    try {
      let baseUrl = creds.baseUrl || this.c.baseUrl
      let token = creds.botToken
      let buf = ''
      let failures = 0
      while (!this.stopPolling) {
        if (failures >= 3) {
          this.status = 'paused'
          this.ctx.logger.warn('[dsh-wechat-bridge] 3 次连续失败，暂停 30s 后重试')
          await new Promise((r) => setTimeout(r, 30_000))
          failures = 0
        }
        this.pollAbort = new AbortController()
        try {
          const batch = await getUpdates({
            baseUrl,
            token,
            getUpdatesBuf: buf,
            abortSignal: this.pollAbort.signal,
          })
          failures = 0
          if (batch.errcode === SESSION_EXPIRED_ERRCODE) {
            // -14 session timeout: re-resolve credentials so a fresh pairing
            // (panel/CLI) takes effect without another restart.
            this.status = 'paused'
            this.pairingMessage = '会话过期(-14)，若重新扫码配对将自动恢复'
            debugLog({ event: 'poll-14' })
            this.ctx.logger.warn('[dsh-wechat-bridge] 会话过期(-14)，10 分钟后重试')
            await new Promise((r) => setTimeout(r, 10 * 60_000))
            const fresh = await this.resolveCredentials()
            if (fresh?.botToken) {
              baseUrl = fresh.baseUrl || this.c.baseUrl
              token = fresh.botToken
              buf = ''
            }
            continue
          }
          buf = batch.get_updates_buf ?? buf
          this.handleBatch(batch.msgs ?? [])
          this.status = 'polling'
        } catch (err) {
          failures += 1
          debugLog({ event: 'poll-error', failures, error: String(err).slice(0, 200) })
          this.ctx.logger.warn('[dsh-wechat-bridge] poll 失败(%d/3): %s', failures, String(err))
          await new Promise((r) => setTimeout(r, 2_000))
        } finally {
          this.pollAbort = null
        }
      }
      this.status = 'stopped'
    } finally {
      this.pollRunning = false
    }
  }

  private handleBatch(msgs: InboundMessage[]): void {
    const now = Date.now()
    for (const msg of msgs) {
      if (msg.message_type !== MESSAGE_TYPE_USER) continue
      const id = msg.message_id
      if (id !== undefined && id !== null) {
        const seenAt = this.seenMsgIds.get(id)
        if (seenAt !== undefined && now - seenAt < MESSAGE_DEDUP_TTL_SECONDS * 1000) continue
        this.seenMsgIds.set(id, now)
        if (this.seenMsgIds.size > 500) {
          for (const [k, v] of this.seenMsgIds) {
            if (now - v > MESSAGE_DEDUP_TTL_SECONDS * 1000) this.seenMsgIds.delete(k)
          }
        }
      }
      const senderId = msg.from_user_id ?? ''
      if (!senderId) continue
      const payload: InboundEvent = {
        message: msg,
        senderId,
        contextToken: msg.context_token,
      }
      const text = msg.item_list
        ?.filter((item) => item.type === ITEM_TEXT)
        .map((item) => item.text_item?.text ?? '')
        .join('')
      debugLog({
        event: 'inbound',
        msgId: id ?? null,
        from: senderId,
        ctxToken: msg.context_token ?? null,
        itemTypes: (msg.item_list ?? []).map((i) => i.type),
        text: (text ?? '').slice(0, 120) || null,
      })
      this.ctx.emit('wechat/message', payload)
      if (text) {
        this.ctx.logger.info('[dsh-wechat-bridge] inbound from %s: %s', senderId, text.slice(0, 120))
      }
    }
  }

  // ---------------------------------------------------------------- outbound

  /** Download and decrypt an inbound image (M3: image-in-session). */
  async downloadImage(item: ImageItem): Promise<{ data: Buffer; ext: string }> {
    return downloadImageMedia({ item, cdnBaseUrl: this.c.cdnBaseUrl })
  }

  /** Send a text message to a peer. Returns true on success. */
  async sendText(params: {
    toUserId: string
    text: string
    contextToken?: string
    creds?: WechatCredentials
  }): Promise<boolean> {
    const creds = params.creds ?? (await this.resolveCredentials())
    if (!creds?.botToken) {
      debugLog({ event: 'send', to: params.toUserId, ok: false, error: 'no credentials' })
      return false
    }
    try {
      const resp = await sendMessage({
        baseUrl: creds.baseUrl || this.c.baseUrl,
        token: creds.botToken,
        body: {
          to_user_id: params.toUserId,
          context_token: params.contextToken,
          item_list: [{ type: ITEM_TEXT, text_item: { text: params.text } }],
        },
      })
      debugLog({
        event: 'send',
        to: params.toUserId,
        ok: true,
        len: params.text.length,
        ctxToken: params.contextToken ?? null,
        text: params.text.slice(0, 60),
        resp,
      })
      return true
    } catch (err) {
      debugLog({ event: 'send', to: params.toUserId, ok: false, error: String(err).slice(0, 200) })
      this.ctx.logger.warn('[dsh-wechat-bridge] sendText failed: %s', String(err))
      return false
    }
  }

  /** Send a typing indicator (1 = typing, 2 = cancel). */
  async sendTypingIndicator(params: {
    toUserId: string
    status: 1 | 2
    contextToken?: string
    creds?: WechatCredentials
  }): Promise<void> {
    const creds = params.creds ?? (await this.resolveCredentials())
    if (!creds?.botToken) return
    try {
      const cfg = await getConfig({
        baseUrl: creds.baseUrl || this.c.baseUrl,
        token: creds.botToken,
        ilinkUserId: params.toUserId,
        contextToken: params.contextToken,
      })
      if (!cfg.typing_ticket) return
      await sendTyping({
        baseUrl: creds.baseUrl || this.c.baseUrl,
        token: creds.botToken,
        ilinkUserId: params.toUserId,
        typingTicket: cfg.typing_ticket,
        status: params.status,
      })
    } catch (err) {
      this.ctx.logger.debug('[dsh-wechat-bridge] typing indicator failed: %s', String(err))
    }
  }
}

export default WechatGateway
