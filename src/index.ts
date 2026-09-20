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
import { assertCleanBaseUrl, assertNoUnknownKeys, schemaKeys } from './config-guard.ts'
import type { MarkdownMode } from './node/markdown.ts'

export { WechatGateway } from './gateway/index.ts'
export { wechatBridgeNode } from './node/index.ts'
export * from './gateway/types.ts'

/** Cordis plugin name used by loader diagnostics and profile config. */
export const name = 'dsh-wechat-bridge'

/** Services the bundle needs (provided by dsh-base and the web shell). */
export const inject = ['sessions', 'agents', 'approval', 'credentials', 'webServer']

/** Bundle config: gateway fields plus the node's policy. */
export interface Config {
  /** Hard allowlist of WeChat sender ids. REQUIRED — no permissive default. */
  allowFrom?: string[]
  /** Approval prompt timeout before default-deny (seconds). */
  approvalTimeoutSec?: number
  /**
   * How long an `ask_user_question` prompt waits for a WeChat answer before it
   * is reported to the agent as unanswered (seconds). Bounds a tool call that
   * blocks the whole turn — it must never hang forever.
   */
  questionTimeoutSec?: number
  /** Max chars per WeChat bubble. */
  maxMessageChars?: number
  /** Minimum spacing between outbound sends (rate-limit hygiene, ms). */
  minSendIntervalMs?: number
  /** Escalating pause steps after errcode -12 (rate limit), seconds. */
  rateLimitBackoffSecs?: number[]
  /** Full outbound pause after errcode -14 (session expired), minutes. */
  sessionExpiredPauseMin?: number
  /** Thinking-digest refresh interval while a turn is active (seconds). */
  thinkingDigestSec?: number
  /** Numbered choice menus expire after this (seconds). */
  menuTimeoutSec?: number
  /** WeChat-bound Markdown rendering policy: passthrough | filter | plain. */
  markdownMode?: MarkdownMode
  /**
   * Tool-name prefixes that get their own progress cards. Empty = disabled
   * (default): the backend currently drops TOOL_CALL items silently (verified
   * by send-only probes) — enable when the channel supports them.
   */
  progressToolPrefixes?: string[]
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
  /** Answers longer than this (chars) ship as a file attachment; 0 = disabled
   *  (default — the backend cannot fetch bot media content yet, probe-verified). */
  fileThresholdChars?: number
  /** Proactively announce task completion (turns ≥ notifyMinTurnSec only). */
  notifyOnComplete?: boolean
  /** Minimum turn duration (sec) before completion notifications fire. */
  notifyMinTurnSec?: number
  /** Delete media/export files older than this many days. */
  mediaRetentionDays?: number
  /** Coalesce rapid plain-text inbound messages (0 disables). */
  inboundDebounceMs?: number
  /** Group chats the bridge may serve: room id → allowed senders. */
  allowGroups?: Array<{ roomId: string; allowFrom: string[] }>
  /** Long-image card mode: 'off' | 'long' (default off, skeleton). */
  cardMode?: 'off' | 'long'
  /** Chrome binary path for the long-card renderer (auto-detected when unset). */
  chromePath?: string
  /** iLink gateway base url (defaults to ilinkai.weixin.qq.com). */
  baseUrl?: string
  /** WeChat CDN base url for media. */
  cdnBaseUrl?: string
  /** Bot token override (prefer credentials). */
  token?: string
  /** Bot account id override (prefer credentials). */
  accountId?: string
  /** Notify trusted users when a non-allowlisted sender attempts contact. */
  notifyRejected?: boolean
  /** Re-send the typing indicator every N seconds during a long turn (0 = off). */
  typingHeartbeatSec?: number
  /** Sliding-window send budget window (seconds). */
  sendBudgetWindowSec?: number
  /** Sliding-window send budget: max sends per window. */
  sendBudgetMaxPerWindow?: number
  /**
   * Server-side per-session-window send quota (protocol.md §5: ~10 sends per
   * user inbound window, then `prepare failed` until the next inbound).
   * Non-must entries beyond the quota are skipped; final answers / approvals
   * / error notices are exempt. 0 disables accounting.
   */
  sessionWindowSendMax?: number
  /** Directories `/video` may read from (default: cwd + media dir). */
  videoRoots?: string[]
  /** Extra trusted hosts for a server-provided baseUrl redirect (login/poll). */
  trustedBaseHosts?: string[]
  /** Extra trusted hosts for media download/upload CDN urls. */
  trustedMediaHosts?: string[]
  /** Non-loopback authorities the settings panel may be served under (LAN). */
  webTrustedHosts?: string[]
  /** P2-2: bot_agent declared in base_info (sanitized; observability only). */
  botAgent?: string
}

export const Config: z<Config> = z.object({
  allowFrom: z.array(z.string()).default([]),
  approvalTimeoutSec: z.number().default(600),
  // 30 minutes: a question blocks the whole turn, and the user may be away from
  // the phone — but it must never block forever (2026-09-20 incident).
  questionTimeoutSec: z.number().default(1800),
  maxMessageChars: z.number().default(2000),
  minSendIntervalMs: z.number().default(5_000),
  rateLimitBackoffSecs: z.array(z.number()).default([10, 30, 60]),
  sessionExpiredPauseMin: z.number().default(60),
  thinkingDigestSec: z.number().default(15),
  menuTimeoutSec: z.number().default(60),
  markdownMode: z.union(['passthrough', 'filter', 'plain']).default('passthrough'),
  progressToolPrefixes: z.array(z.string()).default([]),
  cwd: z.string(),
  defaultMode: z.string(),
  agentProvider: z.string(),
  agentModel: z.string(),
  mediaDir: z.string(),
  fileThresholdChars: z.number().default(0),
  notifyOnComplete: z.boolean().default(false),
  notifyMinTurnSec: z.number().default(300),
  mediaRetentionDays: z.number().default(30),
  inboundDebounceMs: z.number().min(0).default(2000),
  allowGroups: z.array(z.object({ roomId: z.string(), allowFrom: z.array(z.string()) })).default([]),
  cardMode: z.union(['off', 'long']).default('off'),
  /** Notify trusted users when a non-allowlisted sender attempts contact. */
  notifyRejected: z.boolean().default(false),
  typingHeartbeatSec: z.number().min(0).default(25),
  sendBudgetWindowSec: z.number().min(1).default(60),
  sendBudgetMaxPerWindow: z.number().min(1).default(4),
  // Observed server behavior (2026-08-18/19): ~10 successful sends per user
  // inbound window, then `prepare failed` until the peer's next inbound.
  sessionWindowSendMax: z.number().min(0).default(10),
  chromePath: z.string(),
  videoRoots: z.array(z.string()),
  baseUrl: z.string().default(ILINK_BASE_URL),
  cdnBaseUrl: z.string().default(WEIXIN_CDN_BASE_URL),
  trustedBaseHosts: z.array(z.string()),
  trustedMediaHosts: z.array(z.string()),
  webTrustedHosts: z.array(z.string()),
  botAgent: z.string(),
  token: z.string().default(''),
  accountId: z.string().default(''),
})

/**
 * Mount both plugins. The gateway starts polling only when credentials are
 * present (resolved from the `credentials` service at startup).
 */
export function apply(ctx: Context, config: Config): void {
  // P2-5: unknown keys fail the mount loudly — schemastery keeps them
  // silently, so a typo like `markdownmode` would otherwise just not apply.
  assertNoUnknownKeys(config as unknown as Record<string, unknown>, schemaKeys(Config as unknown as { dict?: Record<string, unknown> }), 'config')
  assertCleanBaseUrl(config.baseUrl, 'config.baseUrl')
  if (config.token) {
    // A token inline in the config file is readable by anyone with file
    // access and ends up in backups; the credentials service (macOS
    // Keychain / secrets manager) is the intended store. Warn, don't block —
    // some deployments legitimately manage their config file with vaults.
    ctx.logger.warn(
      '[dsh-wechat-bridge] `token` is set inline in the config file — prefer the credentials service; ' +
        'inline tokens leak into config backups',
    )
  }
  ctx.plugin(WechatGateway, {
    baseUrl: config.baseUrl,
    cdnBaseUrl: config.cdnBaseUrl,
    token: config.token,
    accountId: config.accountId,
    trustedBaseHosts: config.trustedBaseHosts,
    trustedMediaHosts: config.trustedMediaHosts,
    botAgent: config.botAgent,
  })
  ctx.plugin(wechatBridgeNode, {
    allowFrom: config.allowFrom ?? [],
    approvalTimeoutSec: config.approvalTimeoutSec,
    questionTimeoutSec: config.questionTimeoutSec,
    maxMessageChars: config.maxMessageChars,
    minSendIntervalMs: config.minSendIntervalMs,
    rateLimitBackoffSecs: config.rateLimitBackoffSecs,
    sessionExpiredPauseMin: config.sessionExpiredPauseMin,
    thinkingDigestSec: config.thinkingDigestSec,
    typingHeartbeatSec: config.typingHeartbeatSec,
    sendBudgetWindowSec: config.sendBudgetWindowSec,
    sendBudgetMaxPerWindow: config.sendBudgetMaxPerWindow,
    sessionWindowSendMax: config.sessionWindowSendMax,
    menuTimeoutSec: config.menuTimeoutSec,
    markdownMode: config.markdownMode,
    progressToolPrefixes: config.progressToolPrefixes,
    cwd: config.cwd,
    defaultMode: config.defaultMode,
    agentProvider: config.agentProvider,
    agentModel: config.agentModel,
    mediaDir: config.mediaDir,
    fileThresholdChars: config.fileThresholdChars,
    notifyOnComplete: config.notifyOnComplete,
    notifyMinTurnSec: config.notifyMinTurnSec,
    mediaRetentionDays: config.mediaRetentionDays,
    inboundDebounceMs: config.inboundDebounceMs,
    allowGroups: config.allowGroups,
    cardMode: config.cardMode,
    notifyRejected: config.notifyRejected,
    chromePath: config.chromePath,
    videoRoots: config.videoRoots,
    webTrustedHosts: config.webTrustedHosts,
  })
}

export default apply
