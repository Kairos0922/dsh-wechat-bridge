/**
 * WechatBridgeNode — the orchestration state behind the bridge plugin.
 *
 * Holds session targeting, the allowlist, pending approvals, and wires the
 * inbound/outbound/command/approval bridges onto the Cordis context.
 * Session creation routes agent presets through the PresetRegistry
 * (dynamic multi-mode routing — differentiator #1).
 *
 * @module dsh-wechat-bridge/node/core
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { InboundEvent } from '../gateway/types.ts'
import { attachApprovalBridge, type PendingApproval } from './approvals.ts'
import { listSessions, routeCommand } from './commands.ts'
import { handleInbound } from './inbound.ts'
import { attachSessionOutbound, sendTextToPeer } from './outbound.ts'
import { PresetRegistry } from './presets.ts'
import { debugLog } from '../debug-log.ts'

/** Runtime shape of the node config (defaults applied). */
export interface ResolvedNodeConfig {
  allowFrom: string[]
  digestIntervalSec: number
  approvalTimeoutSec: number
  maxMessageChars: number
  sendChunkDelayMs: number
  cwd?: string
  defaultMode?: string
  agentProvider?: string
  agentModel?: string
  mediaDir?: string
}

/** Default session id prefix for /new-created sessions. */
export function newSessionId(): SessionId {
  return SessionId(`wechat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
}

export class WechatBridgeNode {
  /** The active session the WeChat user drives. */
  activeSessionId: SessionId | null = null
  /** The allowlisted peer outbound text goes to (last inbound sender). */
  peerId: string | null = null
  /** Latest iLink context token echoed back on replies. */
  peerContextToken: string | null = null

  readonly ctx: Context
  readonly resolved: ResolvedNodeConfig
  readonly presets = new PresetRegistry()

  private readonly pending = new Map<number, PendingApproval>()
  private approvalCounter = 0
  private disposers: Array<() => void> = []

  constructor(ctx: Context, config: ResolvedNodeConfig) {
    this.ctx = ctx
    this.resolved = config
    if (!Array.isArray(config.allowFrom) || config.allowFrom.length === 0) {
      throw new Error(
        'dsh-wechat-bridge: allowFrom is REQUIRED and must list at least one WeChat sender id. ' +
          'An agent that accepts instructions from any WeChat contact is a prompt-injection front door.',
      )
    }
  }

  /** Mount the bridge: outbound digest, approval answerer, inbound gate. */
  attach(): void {
    this.disposers.push(attachSessionOutbound(this))
    this.disposers.push(attachApprovalBridge(this))
    this.disposers.push(
      this.ctx.on('wechat/message', (payload: InboundEvent) => {
        void handleInbound(this, payload)
      }),
    )
    this.pickDefaultSession()
  }

  dispose(): void {
    for (const disposer of this.disposers) disposer()
    this.disposers = []
    for (const number of [...this.pending.keys()]) this.clearApproval(number)
  }

  /** The active session, if any. */
  activeSession(): Session | undefined {
    if (!this.activeSessionId) return undefined
    return this.ctx.sessions.get(this.activeSessionId)
  }

  /** The agent driving the active session, if any. */
  activeAgent(): Agent | undefined {
    const session = this.activeSession()
    if (!session) return undefined
    return this.ctx.agents.get(session.id)
  }

  /** Whether this node drives the given agent (its session is active). */
  ownsAgent(agent: Agent): boolean {
    return this.activeSessionId !== null && agent.session.id === this.activeSessionId
  }

  /** Whether a WeChat sender may drive the bridge. */
  isAllowed(senderId: string): boolean {
    return this.resolved.allowFrom.includes(senderId)
  }

  /** Pick the most recent session as the default target. */
  pickDefaultSession(): void {
    const sessions = listSessions(this)
    if (sessions.length > 0) this.activeSessionId = sessions[0]!.id
  }

  /** Create a fresh agent+session for a mode (preset) and make it active. */
  async createSession(prompt: string, mode?: string): Promise<void> {
    const preset = this.presets.resolveMode(mode, this.resolved.defaultMode)
    const meta: Record<string, string> = {}
    if (this.resolved.cwd) meta.cwd = this.resolved.cwd
    if (preset) meta.agentPreset = preset
    try {
      const handle = await this.ctx.agents.create({
        sessionId: newSessionId(),
        meta,
        agentOptions: {
          ...(this.resolved.agentProvider ? { provider: this.resolved.agentProvider } : {}),
          ...(this.resolved.agentModel ? { model: this.resolved.agentModel } : {}),
        },
      })
      this.activeSessionId = handle.agent.session.id
      if (prompt) {
        handle.agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'user' },
          }),
        )
      }
      const modeLabel = preset ? ` · 模式 ${preset}` : ''
      await sendTextToPeer(
        this,
        `✅ 已创建新会话 ${handle.agent.session.id}${modeLabel}${prompt ? '，开始处理…' : ''}`,
      )
    } catch (error) {
      await sendTextToPeer(
        this,
        `❌ 创建会话失败: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Route one inbound text: commands first, then the active agent. */
  async handleText(text: string): Promise<void> {
    debugLog({
      event: 'text',
      from: this.peerId,
      isCommand: text.trim().startsWith('/'),
      text: text.slice(0, 120),
    })
    if (await routeCommand(this, text)) return
    const agent = this.activeAgent()
    if (!agent) {
      await sendTextToPeer(
        this,
        '💤 没有活动会话。发送 /new [模式] <prompt> 开始，/modes 查看可用模式，或 /sessions 查看已有会话。',
      )
      return
    }
    debugLog({ event: 'followup', session: this.activeSessionId })
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    )
    if (this.peerId) {
      await this.ctx.wechat.sendTypingIndicator({ toUserId: this.peerId, status: 1 }).catch(() => {})
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
   * most recent request; bare `1`/`2` only while exactly one is pending.
   */
  resolveApproval(text: string): boolean {
    const entries = [...this.pending.entries()]
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
