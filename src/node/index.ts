/**
 * wechat-bridge-node plugin: WeChat ⇄ DSH conversation bridge.
 *
 * Consumes the `wechat` gateway service and dsh-base services (`sessions`,
 * `agents`, `approval`). Inbound WeChat text becomes a user message on the
 * sender's active session; session events become digest-style WeChat messages
 * (thinking digest, tool progress cards, todo snapshots, answers). Commands
 * (`/modes /new /use /sessions /stop /status /model /workspace /retry /close
 * /help`) are handled locally. The allowlist gate lives here — non-allowlisted
 * senders are never fed to the model.
 *
 * @module dsh-wechat-bridge/node
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_MESSAGE_CHARS } from '../gateway/types.ts'
import { WechatBridgeNode, type ResolvedNodeConfig } from './core.ts'
import { registerHostApi } from '../host-api.ts'
import type { MarkdownMode } from './markdown.ts'

/** Plugin config. `allowFrom` is REQUIRED and validated at apply time. */
export interface NodeConfig {
  /** Hard allowlist of WeChat sender ids. REQUIRED — no permissive default. */
  allowFrom?: string[]
  /** Approval prompt timeout before default-deny (seconds). */
  approvalTimeoutSec?: number
  /** Max chars per WeChat bubble. */
  maxMessageChars?: number
  /** Minimum spacing between outbound sends (rate-limit hygiene). */
  minSendIntervalMs?: number
  /** Escalating pause steps after errcode -12 (rate limit), seconds. */
  rateLimitBackoffSecs?: number[]
  /** Full outbound pause after errcode -14 (session expired), minutes. */
  sessionExpiredPauseMin?: number
  /** Liveness-digest interval while a turn is active (seconds). */
  thinkingDigestSec?: number
  /** Sliding-window send budget: max sends per window (server quota is not public). */
  sendBudgetWindowSec?: number
  /** Sliding-window send budget: max sends per window (server quota is not public). */
  sendBudgetMaxPerWindow?: number
  /** Re-send the typing indicator every N seconds during a long turn (0 = off). */
  typingHeartbeatSec?: number
  /** Numbered choice menus expire after this (seconds). */
  menuTimeoutSec?: number
  /** WeChat-bound Markdown rendering policy. */
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
  /** Provider route for `/new` agents. */
  agentProvider?: string
  /** Model id for `/new` agents. */
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
  /** Group chats the bridge may serve: room id → allowed senders. */
  allowGroups?: Array<{ roomId: string; allowFrom: string[] }>
  /** Long-image card mode: 'off' | 'long' (default off, skeleton). */
  cardMode?: 'off' | 'long'
  /** Notify trusted users when a non-allowlisted sender attempts contact. */
  notifyRejected?: boolean
  /** Chrome binary path for the long-card renderer (auto-detected when unset). */
  chromePath?: string
  /**
   * Directories `/video` may read from (default: the session cwd and the
   * media dir). A hard server-side allowlist — paths outside are refused.
   */
  videoRoots?: string[]
  /** Non-loopback authorities the settings panel may be served under (LAN). */
  webTrustedHosts?: string[]
}

export const Config: z<NodeConfig> = z.object({
  allowFrom: z.array(z.string()).default([]),
  approvalTimeoutSec: z.number().min(1).default(600),
  maxMessageChars: z.number().min(1).default(MAX_MESSAGE_CHARS),
  minSendIntervalMs: z.number().min(0).default(5_000),
  rateLimitBackoffSecs: z.array(z.number().min(1)).default([10, 30, 60]),
  sessionExpiredPauseMin: z.number().min(1).default(60),
  thinkingDigestSec: z.number().min(0).default(120),
  typingHeartbeatSec: z.number().min(0).default(25),
  sendBudgetWindowSec: z.number().min(1).default(60),
  sendBudgetMaxPerWindow: z.number().min(1).default(4),
  menuTimeoutSec: z.number().min(1).default(60),
  markdownMode: z.union(['passthrough', 'filter', 'plain']).default('passthrough'),
  progressToolPrefixes: z.array(z.string()).default([]),
  cwd: z.string(),
  defaultMode: z.string(),
  agentProvider: z.string(),
  agentModel: z.string(),
  mediaDir: z.string(),
  fileThresholdChars: z.number().min(0).default(0),
  notifyOnComplete: z.boolean().default(false),
  notifyMinTurnSec: z.number().min(0).default(300),
  mediaRetentionDays: z.number().min(0).default(30),
  allowGroups: z.array(z.object({ roomId: z.string(), allowFrom: z.array(z.string()) })).default([]),
  cardMode: z.union(['off', 'long']).default('off'),
  notifyRejected: z.boolean().default(false),
  chromePath: z.string(),
  videoRoots: z.array(z.string()),
  webTrustedHosts: z.array(z.string()),
})

/** Plugin identity + service deps (object form, resolved per plugin row). */
export const name = 'wechat-bridge-node'
export const inject = ['wechat', 'sessions', 'agents', 'approval', 'webServer', 'agentDefaultModel', 'agentPresets', 'credentials']

function apply(ctx: Context, config: NodeConfig): void {
  const resolved: ResolvedNodeConfig = {
    allowFrom: config.allowFrom ?? [],
    approvalTimeoutSec: config.approvalTimeoutSec ?? 600,
    maxMessageChars: config.maxMessageChars ?? MAX_MESSAGE_CHARS,
    minSendIntervalMs: config.minSendIntervalMs ?? 5_000,
    rateLimitBackoffSecs: config.rateLimitBackoffSecs ?? [10, 30, 60],
    sessionExpiredPauseMin: config.sessionExpiredPauseMin ?? 60,
    thinkingDigestSec: config.thinkingDigestSec ?? 120,
    sendBudgetWindowSec: config.sendBudgetWindowSec ?? 60,
    sendBudgetMaxPerWindow: config.sendBudgetMaxPerWindow ?? 4,
    typingHeartbeatSec: config.typingHeartbeatSec ?? 25,
    menuTimeoutSec: config.menuTimeoutSec ?? 60,
    markdownMode: config.markdownMode ?? 'passthrough',
    progressToolPrefixes: config.progressToolPrefixes ?? [],
    cwd: config.cwd,
    defaultMode: config.defaultMode,
    agentProvider: config.agentProvider,
    agentModel: config.agentModel,
    mediaDir: config.mediaDir,
    fileThresholdChars: config.fileThresholdChars ?? 0,
    notifyOnComplete: config.notifyOnComplete ?? false,
    notifyMinTurnSec: config.notifyMinTurnSec ?? 300,
    mediaRetentionDays: config.mediaRetentionDays ?? 30,
    allowGroups: config.allowGroups ?? [],
    cardMode: config.cardMode ?? 'off',
    notifyRejected: config.notifyRejected ?? false,
    chromePath: config.chromePath,
    videoRoots: config.videoRoots,
  }
  const node = new WechatBridgeNode(ctx, resolved)
  node.attach()
  ctx.logger.info(
    '[dsh-wechat-bridge] wechat-bridge-node mounted (allowFrom=%d, defaultMode=%s, markdownMode=%s)',
    resolved.allowFrom.length,
    resolved.defaultMode || '(unset)',
    resolved.markdownMode,
  )
  // Settings-panel host API (differentiator #3) — registered here because the
  // node row can inject `wechat` while the bundle row cannot (same-scope mount).
  registerHostApi(ctx, ctx.wechat, node, { trustedHosts: config.webTrustedHosts ?? [] })
  ctx.effect(() => {
    return () => {
      node.dispose()
      ctx.logger.info('[dsh-wechat-bridge] wechat-bridge-node disposed')
    }
  })
}

export const wechatBridgeNode = { name, inject, Config, apply }
