/**
 * WechatBridgeNode — the orchestration state behind the bridge plugin.
 *
 * Owns: the hard allowlist, per-peer session binding (multi-friend routing),
 * persistent prefs (model/cwd) and peer bindings, numbered choice menus
 * (mode/model/workspace), pending approvals, and the single rate-limit-aware
 * outbound queue. Session creation routes agent presets through the DSH
 * `agentPresets` service (dynamic multi-mode routing — differentiator #1)
 * and stamps the durable `origin: 'wechat'` header so DSH surfaces render
 * the 🟢 WeChat badge.
 *
 * @module dsh-wechat-bridge/node/core
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { InboundEvent, MessageItem } from '../gateway/types.ts'
import { attachApprovalBridge, type PendingApproval } from './approvals.ts'
import { listSessions, routeCommand } from './commands.ts'
import { handleInbound } from './inbound.ts'
import { attachSessionOutbound, sendTextToPeer, splitForWechat } from './outbound.ts'
import { attachMediaRetention } from './retention.ts'
import { resolveMode } from './presets.ts'
import { debugLog } from '../debug-log.ts'
import { BridgeState } from './state.ts'
import { Outbox, OUTBOX_PRIORITY, type OutboxEntry, type OutboxEntryKind } from './outbox.ts'
import type { MarkdownMode } from './markdown.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default-model service seam (provided by dsh-base; sibling loader entry). */
    agentDefaultModel?: {
      currentSelection(): { provider?: string; model?: string; reasoningEffort?: string }
    }
  }
}

/** Runtime shape of the node config (defaults applied). */
export interface ResolvedNodeConfig {
  allowFrom: string[]
  approvalTimeoutSec: number
  maxMessageChars: number
  /** Minimum spacing between outbound sends (rate-limit hygiene). */
  minSendIntervalMs: number
  /** Escalating pause steps after errcode -12 (rate limit). */
  rateLimitBackoffSecs: number[]
  /** Full outbound pause after errcode -14 (session expired). */
  sessionExpiredPauseMin: number
  /** How often the thinking digest refreshes while a turn is active (sec). */
  thinkingDigestSec: number
  /** Numbered choice menus expire after this (sec). */
  menuTimeoutSec: number
  /** WeChat-bound Markdown rendering policy. */
  markdownMode: MarkdownMode
  /** Tool-name prefixes that get progress cards; empty = cards disabled. */
  progressToolPrefixes: string[]
  cwd?: string
  defaultMode?: string
  agentProvider?: string
  agentModel?: string
  mediaDir?: string
  /** Answers longer than this (chars) ship as a file attachment. */
  fileThresholdChars: number
  /** Proactively announce task completion (turns ≥ notifyMinTurnSec only). */
  notifyOnComplete: boolean
  /** Minimum turn duration (sec) before completion notifications fire. */
  notifyMinTurnSec: number
  /** Delete media/export files older than this many days. */
  mediaRetentionDays: number
  /** Group chats the bridge may serve: room id → allowed senders. */
  allowGroups: Array<{ roomId: string; allowFrom: string[] }>
  /** Long-image card mode: 'off' | 'long'. */
  cardMode: 'off' | 'long'
  /** Chrome binary path for the long-card renderer (auto-detected when unset). */
  chromePath?: string
}

/** Default session id prefix for /new-created sessions. */
export function newSessionId(): SessionId {
  return SessionId(`wechat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
}

/** First-run welcome message sent to the pairer right after QR confirmation. */
export function buildWelcomeMessage(opts: { allowFromEmpty: boolean }): string {
  const trust = opts.allowFromEmpty
    ? '🔓 你已通过扫码自动获得白名单，可直接使用。'
    : '🔒 白名单已按配置生效，可直接使用。'
  return [
    '✅ 微信桥配对成功，欢迎使用！',
    trust,
    '',
    '快速上手：',
    '· 发送 /modes 查看全部可用模式（回复编号直接开会话）',
    '· 发送 /new <模式> <任务> 指定模式开会话',
    '· /status 查看会话与通道状态 · /help 查看全部命令',
    '',
    '提示：危险操作会先征求你的批准（/yes 或 /no），放心使用。',
  ].join('\n')
}

/** One numbered choice menu pending for a peer. */
export interface PendingMenu {
  kind: 'mode' | 'provider' | 'model' | 'workspace'
  options: Array<{ label: string; value: string }>
  /** Extra choice context (e.g. the provider a model menu belongs to). */
  context?: string
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

export class WechatBridgeNode {
  readonly ctx: Context
  readonly resolved: ResolvedNodeConfig
  readonly state: BridgeState
  readonly outbox: Outbox

  /** peerId → active session (persisted through state). */
  private readonly peerSessions = new Map<string, SessionId>()
  /** sessionId → owning peer (so outbound events route back correctly). */
  private readonly sessionOwners = new Map<string, string>()
  /** Latest iLink context token per peer, echoed back on replies. */
  private readonly peerContextTokens = new Map<string, string>()
  /** Latest iLink run id per peer — progress cards associate to it. */
  private readonly peerRunIds = new Map<string, string>()
  /** Outbound target per peer: sender id for 1:1, room id for groups. */
  private readonly peerTargets = new Map<string, string>()
  private readonly menus = new Map<string, PendingMenu>()
  /** Last user prompt per peer (for /retry). */
  private readonly lastUserText = new Map<string, string>()
  private readonly pending = new Map<number, PendingApproval>()
  private approvalCounter = 0
  private disposers: Array<() => void> = []

  constructor(ctx: Context, config: ResolvedNodeConfig) {
    this.ctx = ctx
    this.resolved = config
    // allowFrom is OPTIONAL since 0.2.x: the QR pairing itself is the trust
    // action — the pairer's WeChat id (WEIXIN_ILINK_USER_ID) is auto-allowlisted
    // at runtime (see isAllowed). allowFrom stays as an extra restriction /
    // multi-user gate for power users.
    if (Array.isArray(config.allowFrom) && config.allowFrom.length === 0) {
      this.ctx.logger.warn(
        '[dsh-wechat-bridge] allowFrom is empty — relying on the paired WeChat id as the sole trusted sender. ' +
          'An agent that accepts instructions from any WeChat contact is a prompt-injection front door; ' +
          'only the account that scanned the pairing QR is trusted.',
      )
    }
    this.state = new BridgeState()
    this.outbox = new Outbox({
      minIntervalMs: config.minSendIntervalMs,
      backoffSecs: config.rateLimitBackoffSecs,
      sessionExpiredPauseMs: config.sessionExpiredPauseMin * 60_000,
      send: (entry) => this.dispatchOutboxEntry(entry),
    })
  }

  /** Mount the bridge: outbound digest, approval answerer, inbound gate. */
  attach(): void {
    // Restore persisted peer bindings and owner registry.
    for (const [peerId, sessionId] of this.state.listPeerSessions()) {
      this.peerSessions.set(peerId, SessionId(sessionId))
      this.sessionOwners.set(sessionId, peerId)
    }
    for (const [sessionId, peerId] of this.state.listSessionOwners()) {
      this.sessionOwners.set(sessionId, peerId)
    }
    // Restore context tokens: without them, sends after a restart carry no
    // context_token and the WeChat client may not associate them to a
    // conversation window (official client persists these per account).
    for (const [peerId, token] of this.state.listContextTokens()) {
      this.peerContextTokens.set(peerId, token)
    }
    this.disposers.push(attachSessionOutbound(this))
    this.disposers.push(attachApprovalBridge(this))
    this.disposers.push(attachMediaRetention(this))
    this.disposers.push(
      this.ctx.on('wechat/message', (payload: InboundEvent) => {
        void handleInbound(this, payload)
      }),
    )
    // First-run experience: a freshly confirmed pairing pushes a welcome
    // message straight into the pairer's chat — zero-config onboarding.
    this.disposers.push(
      this.ctx.on('wechat/paired', (payload: { userId: string; accountId: string | null }) => {
        if (!payload.userId) return
        this.enqueueText(
          payload.userId,
          buildWelcomeMessage({ allowFromEmpty: this.resolved.allowFrom.length === 0 }),
          { kind: 'system' },
        )
      }),
    )
    // Migration: sessions created before per-peer binding (id prefix `wechat-`,
    // no owner) belong to the allowlisted peers without a binding yet — an
    // upgrade never orphans an ongoing WeChat conversation. Newest-first
    // distribution across the unbound peers.
    const unbound = this.resolved.allowFrom.filter((peerId) => !this.peerSessions.has(peerId))
    const orphans = listSessions(this).filter(
      (session) => session.id.startsWith('wechat-') && this.sessionOwners.get(session.id) === undefined,
    )
    unbound.forEach((peerId, index) => {
      const orphan = orphans[index]
      if (orphan !== undefined) this.setActiveSession(peerId, orphan.id)
    })
  }

  dispose(): void {
    for (const disposer of this.disposers) disposer()
    this.disposers = []
    for (const menu of this.menus.values()) clearTimeout(menu.timer)
    this.menus.clear()
    for (const number of [...this.pending.keys()]) this.clearApproval(number)
    this.outbox.dispose()
    this.state.dispose()
  }

  // ---------------------------------------------------------------- outbox

  private async dispatchOutboxEntry(entry: OutboxEntry): Promise<{ ok: boolean; ret?: number; errcode?: number; errmsg?: string; messageId?: number }> {
    const to = entry.to
    if (!to) return { ok: false, errmsg: 'no peer bound to outbox entry' }
    const target = this.peerTargets.get(to) ?? to
    const token = this.peerContextTokens.get(to)
    const runId = this.peerRunIds.get(to)
    if (entry.kind === 'tool-start' || entry.kind === 'tool-result') {
      if (entry.item === undefined) return { ok: false, errmsg: 'missing item' }
      return this.ctx.wechat.sendItem({ toUserId: target, contextToken: token, runId, item: entry.item })
    }
    if (entry.kind === 'file' || entry.kind === 'image') {
      if (entry.media === undefined) return { ok: false, errmsg: 'missing media' }
      if (entry.kind === 'image') {
        return this.ctx.wechat.sendImage({ toUserId: target, filePath: entry.media.filePath, contextToken: token, runId })
      }
      const result = await this.ctx.wechat.sendFile({
        toUserId: target,
        filePath: entry.media.filePath,
        fileName: entry.media.fileName,
        contextToken: token,
        runId,
      })
      // Graceful degradation: when the file channel fails outright, deliver the
      // full answer as chunked text instead of losing it behind a dead digest.
      if (!result.ok && entry.text) {
        const chunks = splitForWechat(entry.text, this.resolved.maxMessageChars)
        for (const [index, chunk] of chunks.entries()) {
          this.enqueueText(to, index === 0 ? chunk : chunk, { kind: 'text' })
        }
      }
      return result
    }
    return this.ctx.wechat.sendText({ toUserId: target, text: entry.text ?? '', contextToken: token, runId })
  }

  /** Enqueue a text-ish bubble for a peer (chunking already applied by callers). */
  enqueueText(peerId: string, text: string, opts: { kind?: OutboxEntryKind; priority?: number; coalesceKey?: string } = {}): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const kind = opts.kind ?? 'text'
    const priority = opts.priority ?? (kind === 'system' ? OUTBOX_PRIORITY.system : kind === 'progress' ? OUTBOX_PRIORITY.progress : OUTBOX_PRIORITY.text)
    this.outbox.enqueue({
      kind,
      priority,
      to: peerId,
      text: trimmed,
      coalesceKey: opts.coalesceKey,
      createdAt: Date.now(),
    })
  }

  /** Enqueue a bot progress card item (TOOL_CALL_START / TOOL_CALL_RESULT). */
  enqueueToolCard(peerId: string, kind: 'tool-start' | 'tool-result', item: MessageItem): void {
    this.outbox.enqueue({
      kind,
      priority: OUTBOX_PRIORITY.tool,
      to: peerId,
      item,
      createdAt: Date.now(),
    })
  }

  /** Enqueue a local file/image artifact for CDN upload + send. */
  enqueueMedia(peerId: string, kind: 'file' | 'image', filePath: string, fileName: string, fallbackText?: string): void {
    this.outbox.enqueue({
      kind,
      priority: OUTBOX_PRIORITY.text,
      to: peerId,
      media: { filePath, fileName },
      text: fallbackText,
      createdAt: Date.now(),
    })
  }

  /** Whether this peer key routes to a group chat (quiet-mode rules apply). */
  isGroupPeer(peerId: string): boolean {
    return peerId.startsWith('group:')
  }

  /** Remember the peer's outbound target (room id for groups). */
  setPeerTarget(peerId: string, target: string): void {
    this.peerTargets.set(peerId, target)
  }

  outboxPausedUntil(): number | null {
    return this.outbox.getPausedUntil()
  }

  // ---------------------------------------------------------------- routing

  /** The owning peer of a session, if known. */
  peerOf(sessionId: string): string | null {
    return this.sessionOwners.get(sessionId) ?? null
  }

  /** The peer's active session, if any. */
  activeSession(peerId: string): Session | undefined {
    const id = this.peerSessions.get(peerId)
    if (id === undefined) return undefined
    return this.ctx.sessions.get(id)
  }

  /** The agent driving the peer's active session, if any. */
  activeAgent(peerId: string): Agent | undefined {
    const session = this.activeSession(peerId)
    if (!session) return undefined
    return this.ctx.agents.get(session.id)
  }

  /** Whether this node drives the given agent (its session belongs to a peer). */
  ownsAgent(agent: Agent): boolean {
    return this.sessionOwners.has(agent.session.id)
  }

  /** Public accessor for the status panel: the pairer's auto-allowlisted id. */
  async getPairedUserId(): Promise<string | null> {
    return this.pairedUserId()
  }

  /** The pairer's WeChat id (auto-allowlisted), read from credentials. */
  private pairedUserIdCache: string | null = null
  private pairedUserIdAt = 0
  private readonly pairedUserIdTtlMs = 30_000

  /**
   * The WeChat id of the account that scanned the pairing QR — the implicit
   * owner/trust anchor. Cached briefly; refreshed after a (re)pairing takes
   * effect within one TTL.
   */
  private async pairedUserId(): Promise<string | null> {
    const now = Date.now()
    if (this.pairedUserIdCache !== null && now - this.pairedUserIdAt < this.pairedUserIdTtlMs) {
      return this.pairedUserIdCache
    }
    let id: string | null = null
    try {
      // Typed via the dsh-credentials Context augmentation (same service the
      // gateway injects); resolved as an optional service at runtime.
      const credentials = this.ctx.get('credentials') as
        | { resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value?: unknown } | undefined> }
        | undefined
      const resolved = await credentials?.resolve(credentialRef('WEIXIN_ILINK_USER_ID'))
      const value = resolved?.value
      id = typeof value === 'string' && value.trim() ? value.trim() : null
    } catch {
      id = null
    }
    this.pairedUserIdCache = id
    this.pairedUserIdAt = now
    return id
  }

  /** Whether a WeChat sender may drive the bridge: configured allowFrom ∪ the pairer. */
  async isAllowed(senderId: string): Promise<boolean> {
    if (this.resolved.allowFrom.includes(senderId)) return true
    const owner = await this.pairedUserId()
    return owner !== null && senderId === owner
  }

  /** Set (and persist) the peer's active session. */
  setActiveSession(peerId: string, sessionId: SessionId | null): void {
    if (sessionId === null) {
      const previous = this.peerSessions.get(peerId)
      if (previous !== undefined) {
        this.peerSessions.delete(peerId)
        this.sessionOwners.delete(previous)
      }
      this.state.setPeerSession(peerId, null)
      this.state.setSessionOwner(previous ?? '', null)
      return
    }
    this.peerSessions.set(peerId, sessionId)
    this.sessionOwners.set(sessionId, peerId)
    this.state.setPeerSession(peerId, sessionId)
    this.state.setSessionOwner(sessionId, peerId)
  }

  /** Sessions this peer owns, most-recent-first. */
  sessionsForPeer(peerId: string): Session[] {
    return listSessions(this)
      .filter((session) => this.sessionOwners.get(session.id) === peerId)
      .slice(0, 50)
  }

  /** Remember the peer's latest context token (echoed on replies). */
  setPeerContextToken(peerId: string, token: string | null): void {
    if (token) {
      this.peerContextTokens.set(peerId, token)
      this.state.setContextToken(peerId, token)
    } else {
      this.peerContextTokens.delete(peerId)
      this.state.setContextToken(peerId, null)
    }
  }

  /** Remember the peer's latest run id (progress-card association). */
  setPeerRunId(peerId: string, runId: string | null): void {
    if (runId) this.peerRunIds.set(peerId, runId)
    else this.peerRunIds.delete(peerId)
  }

  getPeerContextToken(peerId: string): string | null {
    return this.peerContextTokens.get(peerId) ?? null
  }

  rememberUserText(peerId: string, text: string): void {
    this.lastUserText.set(peerId, text)
  }

  getUserText(peerId: string): string | null {
    return this.lastUserText.get(peerId) ?? null
  }

  // ---------------------------------------------------------------- menus

  /** Open (or replace) a numbered choice menu for a peer. */
  registerMenu(
    peerId: string,
    kind: PendingMenu['kind'],
    options: Array<{ label: string; value: string }>,
    context?: string,
  ): void {
    this.clearMenu(peerId)
    const expiresAt = Date.now() + this.resolved.menuTimeoutSec * 1000
    const timer = setTimeout(() => {
      this.menus.delete(peerId)
    }, this.resolved.menuTimeoutSec * 1000)
    timer.unref?.()
    this.menus.set(peerId, { kind, options, context, expiresAt, timer })
  }

  clearMenu(peerId: string): void {
    const menu = this.menus.get(peerId)
    if (menu) {
      clearTimeout(menu.timer)
      this.menus.delete(peerId)
    }
  }

  hasMenu(peerId: string): boolean {
    return this.menus.has(peerId)
  }

  /** Try to resolve a bare-number reply against the peer's open menu. */
  tryResolveMenu(peerId: string, text: string): boolean {
    const menu = this.menus.get(peerId)
    if (!menu) return false
    const trimmed = text.trim()
    if (!/^\d+$/.test(trimmed)) return false
    const index = parseInt(trimmed, 10)
    if (index === 0) {
      this.clearMenu(peerId)
      this.enqueueText(peerId, '已取消', { kind: 'system' })
      return true
    }
    const option = menu.options[index - 1]
    if (option === undefined) {
      // A typo must not end the whole menu interaction: keep it open.
      this.registerMenu(peerId, menu.kind, menu.options, menu.context)
      this.enqueueText(peerId, `❌ 无效编号（可选 1–${menu.options.length}，回复 0 取消）`, { kind: 'system' })
      return true
    }
    this.clearMenu(peerId)
    void this.onMenuChoice(peerId, menu, option.value)
    return true
  }

  private async onMenuChoice(peerId: string, menu: PendingMenu, value: string): Promise<void> {
    switch (menu.kind) {
      case 'mode':
        await this.createSession(peerId, '', value)
        return
      case 'provider': {
        const models = await this.listModels(value)
        if (models.length === 0) {
          this.enqueueText(peerId, `❌ 供应商 ${value} 没有可列出的模型，可用 /model <provider>/<model> 直接指定`, { kind: 'system' })
          return
        }
        this.registerMenu(
          peerId,
          'model',
          models.slice(0, 20).map((m) => ({ label: m, value: m })),
          value,
        )
        this.enqueueText(peerId, `🤖 选择模型（回复编号，0 取消）：\n${models.slice(0, 20).map((m, i) => `${i + 1}. ${m}`).join('\n')}`, { kind: 'system' })
        return
      }
      case 'model': {
        const provider = menu.context
        if (!provider) return
        this.state.setPrefs({ provider, model: value })
        this.enqueueText(peerId, `✅ 模型已设为 ${provider}/${value}（对 /new 新建的会话生效；/model default 恢复跟随 DSH 默认）`, { kind: 'system' })
        return
      }
      case 'workspace': {
        this.state.setPrefs({ cwd: value })
        this.enqueueText(peerId, `✅ 工作区已设为 ${value}（对 /new 新建的会话生效；/workspace default 恢复默认）`, { kind: 'system' })
        return
      }
    }
  }

  private async listModels(provider: string): Promise<string[]> {
    const llm = this.ctx.get('llm') as { listModels(provider: string): Promise<Array<{ id: string }>> } | undefined
    if (!llm) return []
    try {
      const models = await llm.listModels(provider)
      return models.map((m) => m.id)
    } catch {
      return []
    }
  }

  // ---------------------------------------------------------------- sessions

  /** Create a fresh agent+session for a mode (preset) and make it active. */
  async createSession(peerId: string, prompt: string, mode?: string): Promise<void> {
    const preset = await resolveMode(this.ctx, mode, this.resolved.defaultMode)
    const meta: Record<string, string> = {}
    // `{{cwd}}` in preset personas resolves from this meta; always provide one
    // (pref → explicit config → deployment working directory).
    meta.cwd = this.state.prefs.cwd || this.resolved.cwd || process.cwd()
    if (preset) meta.agentPreset = preset
    // Structured origin badge: DSH surfaces render the 🟢 WeChat marker from
    // the session header (harness patched to accept 'wechat').
    meta.origin = 'wechat'
    // Preset personas assemble template variables such as `{{model}}` — an
    // agent created without a model selection fails the assembly. Preference
    // chain: bridge prefs → bridge config → deployment default.
    const fallback = this.ctx.agentDefaultModel?.currentSelection?.() ?? {}
    const provider = this.state.prefs.provider ?? this.resolved.agentProvider ?? fallback.provider
    const model = this.state.prefs.model ?? this.resolved.agentModel ?? fallback.model
    try {
      // The agent factory does NOT compose presets from meta.agentPreset on its
      // own — the caller must supply `setup` that mounts the preset onto the
      // agent scope (exactly what the web host's composeAgent does). Without
      // this the session runs on the deployment's default persona.
      const setup = preset
        ? async (agentCtx: Context): Promise<void> => {
            await this.ctx.agentPresets.mount(agentCtx, preset)
          }
        : undefined
      const handle = await this.ctx.agents.create({
        sessionId: newSessionId(),
        meta,
        agentOptions: {
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        },
        ...(setup ? { setup } : {}),
      })
      const session = handle.agent.session
      this.setActiveSession(peerId, session.id)
      if (prompt) {
        this.rememberUserText(peerId, prompt)
        handle.agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'user' },
          }),
        )
      }
      const modeLabel = preset ? ` · 模式 ${preset}` : ''
      const modelLabel = provider || model ? ` · ${provider ?? '默认'}/${model ?? '默认'}` : ''
      this.enqueueText(
        peerId,
        `✅ 已创建新会话 ${session.id}${modeLabel}${modelLabel}${prompt ? '，开始处理…' : ''}`,
        { kind: 'system' },
      )
    } catch (error) {
      this.enqueueText(peerId, `❌ 创建会话失败: ${error instanceof Error ? error.message : String(error)}`, { kind: 'system' })
    }
  }

  /** Route one inbound text: menus/approvals → commands → the active agent. */
  async handleText(peerId: string, text: string): Promise<void> {
    debugLog({
      event: 'text',
      from: peerId,
      isCommand: text.trim().startsWith('/'),
      text: text.slice(0, 120),
    })
    if (this.resolveApproval(text, peerId)) return
    if (this.tryResolveMenu(peerId, text)) return
    const routed = await routeCommand(this, peerId, text)
    if (routed === 'handled') return
    const unescaped = routed === 'forward' ? text.replace(/^\/\//, '/') : text
    let agent = this.activeAgent(peerId)
    if (!agent && !this.activeSession(peerId)) {
      // No session at all: try to continue the peer's most recent WeChat
      // session before asking for /new — a restart or re-pair must not orphan
      // an ongoing chat.
      const orphanId = await this.pickOrphanSession(peerId)
      if (orphanId) {
        this.setActiveSession(peerId, SessionId(orphanId))
        agent = this.activeAgent(peerId)
        if (agent) {
          this.enqueueText(peerId, `🟢 已恢复会话 ${orphanId}，继续投递…`, { kind: 'system' })
        } else {
          this.enqueueText(
            peerId,
            `🟢 已绑定会话 ${orphanId}，但它尚未在 DSH 中激活——请先在 DSH Web 打开一次该会话，或 /new 开新会话。`,
            { kind: 'system' },
          )
        }
      }
    }
    if (!agent) {
      this.enqueueText(
        peerId,
        '💤 没有活动会话。发送 /new [模式] <prompt> 开始，/modes 查看可用模式，或 /sessions 查看已有会话。',
        { kind: 'system' },
      )
      return
    }
    this.rememberUserText(peerId, unescaped)
    debugLog({ event: 'followup', session: this.activeSession(peerId)?.id ?? null })
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: unescaped }],
        source: { kind: 'user' },
      }),
    )
    if (agent.status === 'running') {
      this.enqueueText(peerId, '⏳ 已排队，处理完当前任务后继续', { kind: 'progress', coalesceKey: 'queued' })
    }
  }

  /**
   * Most recent ownerless WeChat session id, for continuity migration. Live
   * sessions win; after a restart the persisted headers are consulted so the
   * binding survives even before the session is opened in the Web UI.
   */
  private async pickOrphanSession(peerId: string): Promise<string | null> {
    void peerId
    const live = listSessions(this).find(
      (session) => session.id.startsWith('wechat-') && this.sessionOwners.get(session.id) === undefined,
    )
    if (live) return live.id
    const persistence = this.ctx.get('sessionPersistence') as
      | { list(): Promise<Array<{ id: string; createdAt: number }>> }
      | undefined
    if (!persistence) return null
    try {
      const headers = await persistence.list()
      const candidates = headers
        .filter((header) => header.id.startsWith('wechat-') && this.sessionOwners.get(header.id) === undefined)
        .sort((a, b) => b.createdAt - a.createdAt)
      return candidates[0]?.id ?? null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- approvals

  nextApprovalNumber(): number {
    this.approvalCounter += 1
    return this.approvalCounter
  }

  registerApproval(number: number, approval: PendingApproval): void {
    this.pending.set(number, approval)
  }

  clearApproval(number: number): void {
    const entry = this.pending.get(number)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(number)
    }
  }

  /**
   * Resolve a pending approval from a WeChat reply. `/yes`/`/no` answer the
   * most recent request of THAT peer; bare `1`/`2` only while exactly one of
   * the peer's requests is pending.
   */
  resolveApproval(text: string, peerId: string): boolean {
    const entries = [...this.pending.entries()].filter(([, entry]) => entry.peerId === peerId)
    if (entries.length === 0) return false
    const outcome: ApprovalOutcome | undefined =
      text === '/yes' ? 'allowed-once' : text === '/no' ? 'rejected' : undefined
    if (outcome) {
      const [number, entry] = entries[entries.length - 1]!
      this.clearApproval(number)
      entry.resolve(outcome)
      return true
    }
    if ((text === '1' || text === '2') && entries.length === 1) {
      const [number, entry] = entries[0]!
      this.clearApproval(number)
      entry.resolve(text === '1' ? 'allowed-once' : 'rejected')
      return true
    }
    return false
  }
}
