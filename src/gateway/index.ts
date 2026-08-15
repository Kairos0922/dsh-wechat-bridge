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
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LOGIN_BASE_URL,
  fetchQrCode,
  getConfig,
  getUpdates,
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
  onQr?: (qr: { scanData: string; imgContent?: string }) => void
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
    this.status = 'polling'
    void this.pollLoop(creds)
  }

  // ---------------------------------------------------------------- QR login

  /**
   * Run the iLink QR login flow. On success returns the credentials; the
   * caller persists them (e.g. via the credentials service).
   */
  async loginQr(opts: LoginQrOptions = {}): Promise<LoginQrResult> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000
    const pollIntervalMs = opts.qrPollIntervalMs ?? 1500
    this.status = 'pairing'
    const startedAt = Date.now()

    let qr = await fetchQrCode({ botType: opts.botType })
    opts.onQr?.({ scanData: qr.qrcode, imgContent: qr.qrcode_img_content })

    let baseUrl = LOGIN_BASE_URL
    while (Date.now() - startedAt < timeoutMs) {
      const st = await pollQrStatus({ baseUrl, qrcode: qr.qrcode })
      switch (st.status) {
        case 'confirmed':
          this.status = 'polling'
          return {
            success: true,
            credentials: {
              accountId: st.ilink_bot_id,
              botToken: st.bot_token,
              baseUrl: st.baseurl || baseUrl,
              ilinkUserId: st.ilink_user_id,
            },
            message: '登录成功',
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
          opts.onQr?.({ scanData: qr.qrcode, imgContent: qr.qrcode_img_content })
          break
        case 'need_verifycode':
          // M1: CLI flow can't supply the code interactively; surface and keep polling.
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

  // ---------------------------------------------------------------- poll loop

  private async pollLoop(creds: WechatCredentials): Promise<void> {
    const baseUrl = creds.baseUrl || this.c.baseUrl
    const token = creds.botToken
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
          this.status = 'paused'
          this.ctx.logger.warn('[dsh-wechat-bridge] 会话过期(-14)，10 分钟后重试')
          await new Promise((r) => setTimeout(r, 10 * 60_000))
          continue
        }
        buf = batch.get_updates_buf ?? buf
        this.handleBatch(batch.msgs ?? [])
        this.status = 'polling'
      } catch (err) {
        failures += 1
        this.ctx.logger.warn('[dsh-wechat-bridge] poll 失败(%d/3): %s', failures, String(err))
        await new Promise((r) => setTimeout(r, 2_000))
      } finally {
        this.pollAbort = null
      }
    }
    this.status = 'stopped'
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
    if (!creds?.botToken) return false
    try {
      await sendMessage({
        baseUrl: creds.baseUrl || this.c.baseUrl,
        token: creds.botToken,
        body: {
          to_user_id: params.toUserId,
          context_token: params.contextToken,
          item_list: [{ type: ITEM_TEXT, text_item: { text: params.text } }],
        },
      })
      return true
    } catch (err) {
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
