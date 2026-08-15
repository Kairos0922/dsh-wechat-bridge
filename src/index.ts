/**
 * dsh-wechat-bridge — one DSH bundle, two separable Cordis plugins.
 *
 * 1. **wechat-gateway** (`WechatGateway`) — the iLink gateway as the `wechat`
 *    service: QR login, authenticated long-poll, reconnect/backoff, send
 *    retry, typing indicator, CDN media download (M1/M3).
 * 2. **wechat-bridge-node** (`wechatBridgeNode`) — the WeChat ⇄ DSH
 *    conversation bridge: allowlist gate, dynamic agent-preset routing
 *    (`/modes`, `/new <mode>`), approvals, digest outbound, image-in-session
 *    (M2/M3).
 *
 * Protocol client portions derived from Tencent/openclaw-weixin (MIT);
 * architecture informed by Jesse-njx/dsh-chatnode-wechat (MIT).
 * See LICENSE for attributions.
 *
 * @module dsh-wechat-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ILINK_BASE_URL, WEIXIN_CDN_BASE_URL } from './gateway/types.ts'
import { WechatGateway } from './gateway/index.ts'
import { wechatBridgeNode } from './node/index.ts'

export { WechatGateway } from './gateway/index.ts'
export { wechatBridgeNode } from './node/index.ts'
export * from './gateway/types.ts'

/** Cordis plugin name used by loader diagnostics and profile config. */
export const name = 'dsh-wechat-bridge'

/** Services the bundle needs (provided by dsh-base). */
export const inject = ['sessions', 'agents', 'approval', 'credentials']

/** Bundle config: gateway fields plus the node's policy. */
export interface Config {
  /** Hard allowlist of WeChat sender ids. REQUIRED — no permissive default. */
  allowFrom?: string[]
  /** Heartbeat interval for progress digests (seconds; 0 disables). */
  digestIntervalSec?: number
  /** Approval prompt timeout before default-deny (seconds). */
  approvalTimeoutSec?: number
  /** Max chars per WeChat bubble. */
  maxMessageChars?: number
  /** Throttle between outbound bubbles (ms). */
  sendChunkDelayMs?: number
  /** Working directory for `/new` sessions. */
  cwd?: string
  /** Default agent preset for sessions created without an explicit mode. */
  defaultMode?: string
  /** Provider route override for `/new` agents. */
  agentProvider?: string
  /** Model id override for `/new` agents. */
  agentModel?: string
  /** Media storage dir for inbound images (default: $DSH_HOME/storages/dsh-wechat-bridge/media). */
  mediaDir?: string
  /** iLink gateway base url (defaults to ilinkai.weixin.qq.com). */
  baseUrl?: string
  /** WeChat CDN base url for media. */
  cdnBaseUrl?: string
  /** Bot token override (prefer credentials). */
  token?: string
  /** Bot account id override (prefer credentials). */
  accountId?: string
}

export const Config = z.object({
  allowFrom: z.array(z.string()).default([]),
  digestIntervalSec: z.number().default(300),
  approvalTimeoutSec: z.number().default(600),
  maxMessageChars: z.number().default(2000),
  sendChunkDelayMs: z.number().default(1_500),
  cwd: z.string(),
  defaultMode: z.string(),
  agentProvider: z.string(),
  agentModel: z.string(),
  mediaDir: z.string(),
  baseUrl: z.string().default(ILINK_BASE_URL),
  cdnBaseUrl: z.string().default(WEIXIN_CDN_BASE_URL),
  token: z.string().default(''),
  accountId: z.string().default(''),
})

/**
 * Mount both plugins. The gateway starts polling only when credentials are
 * present (resolved from the `credentials` service at startup).
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(WechatGateway, {
    baseUrl: config.baseUrl,
    cdnBaseUrl: config.cdnBaseUrl,
    token: config.token,
    accountId: config.accountId,
  })
  ctx.plugin(wechatBridgeNode, {
    allowFrom: config.allowFrom ?? [],
    digestIntervalSec: config.digestIntervalSec,
    approvalTimeoutSec: config.approvalTimeoutSec,
    maxMessageChars: config.maxMessageChars,
    sendChunkDelayMs: config.sendChunkDelayMs,
    cwd: config.cwd,
    defaultMode: config.defaultMode,
    agentProvider: config.agentProvider,
    agentModel: config.agentModel,
    mediaDir: config.mediaDir,
  })
}

export default apply
