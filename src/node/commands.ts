/**
 * WeChat command vocabulary: /modes /new /use /sessions /stop /status
 * /yes /no /help.
 *
 * Differentiator #1 lives here: `/modes` lists the agent presets discovered
 * at runtime (never hardcoded), and `/new [mode] <prompt>` creates the
 * session with that preset. `/yes`/`/no` and bare `1`/`2` resolve pending
 * approvals (see `approvals.ts`).
 *
 * @module dsh-wechat-bridge/node/commands
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { WechatBridgeNode } from './core.ts'
import { sendTextToPeer } from './outbound.ts'

/** The active session's first user prompt, for list labels. */
function sessionLabel(session: Session): string {
  for (const event of session.events) {
    if (event.type === 'user/message') {
      const blocks = event.data.content as unknown as Array<{ type: string; text?: string }>
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join(' ')
        .trim()
      if (text) return text.length > 24 ? `${text.slice(0, 24)}…` : text
    }
  }
  return '(空会话)'
}

/** Sessions ordered most-recent-first. */
export function listSessions(node: WechatBridgeNode): Session[] {
  return [...node.ctx.sessions.list()].sort((a, b) => {
    const diff = b.header.createdAt - a.header.createdAt
    if (diff !== 0) return diff
    return b.seq - a.seq
  })
}

/**
 * Parse `/new` arguments: an optional mode (matching a discovered preset)
 * followed by the initial prompt.
 */
export function parseNewArgs(node: WechatBridgeNode, rest: string[]): { mode?: string; prompt: string } {
  const first = rest[0] ?? ''
  if (first && node.presets.has(first)) {
    return { mode: first, prompt: rest.slice(1).join(' ').trim() }
  }
  return { prompt: rest.join(' ').trim() }
}

/** Try to route one command. Returns true when the text was a command. */
export async function routeCommand(node: WechatBridgeNode, text: string): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return false

  // Approval replies are handled by the bridge even when no agent is active.
  if (trimmed === '/yes' || trimmed === '/no' || /^[12]$/.test(trimmed)) {
    if (node.resolveApproval(trimmed)) return true
  }

  const [command, ...rest] = trimmed.slice(1).split(/\s+/)
  switch (command) {
    case 'help':
      await sendTextToPeer(node, helpText(node))
      return true

    case 'modes': {
      const presets = node.presets.list()
      if (presets.length === 0) {
        await sendTextToPeer(node, '📭 没有发现任何 agent 预设（$DSH_HOME/.agent-presets 为空）。')
        return true
      }
      const lines = presets.map((p, i) => `${i + 1}. ${p.id}${p.id === node.resolved.defaultMode ? '（默认）' : ''}`)
      await sendTextToPeer(node, `🎭 可用模式（/new <模式> 使用）\n${lines.join('\n')}`)
      return true
    }

    case 'sessions':
      await sendTextToPeer(node, renderSessions(node))
      return true

    case 'use': {
      const index = Number(rest[0])
      const sessions = listSessions(node)
      if (!Number.isInteger(index) || index < 1 || index > sessions.length) {
        await sendTextToPeer(node, `❌ 无效编号。可用: 1–${sessions.length}（/sessions 查看列表）`)
        return true
      }
      const session = sessions[index - 1]!
      node.activeSessionId = session.id
      await sendTextToPeer(node, `✅ 已切换到会话 #${index}（${session.id}）`)
      return true
    }

    case 'new': {
      const { mode, prompt } = parseNewArgs(node, rest)
      await node.createSession(prompt, mode)
      return true
    }

    case 'stop': {
      const agent = node.activeAgent()
      if (!agent) {
        await sendTextToPeer(node, '❌ 没有活动的 agent')
      } else {
        agent.cancel({ kind: 'user' })
        await sendTextToPeer(node, '⏹ 已请求停止')
      }
      return true
    }

    case 'status': {
      const agent = node.activeAgent()
      const session = node.activeSession()
      if (!session) {
        await sendTextToPeer(node, '💤 没有活动会话。发送 /new [模式] <prompt> 开始，/modes 查看可用模式。')
        return true
      }
      const status = agent?.status ?? 'idle'
      const lastTurn = [...session.events].reverse().find((e) => e.type === 'turn/end')
      const reason = lastTurn ? describeTurnEnd(lastTurn.data.reason) : '尚未运行'
      await sendTextToPeer(node, `📊 状态\n会话: ${session.id}\nagent: ${status}\n事件: ${session.seq} 条\n最近: ${reason}`)
      return true
    }

    default:
      await sendTextToPeer(node, `❓ 未知命令 /${command}\n${helpText(node)}`)
      return true
  }
}

function describeTurnEnd(reason: { kind: string }): string {
  switch (reason.kind) {
    case 'completed': return '✅ 完成'
    case 'error': return '❌ 出错'
    case 'aborted': return '⏹ 已停止'
    case 'blocked': return '⏸ 已阻塞'
    case 'max-tokens': return '⚠️ 输出截断'
    case 'interrupted': return '⚠️ 中断'
    default: return reason.kind
  }
}

function renderSessions(node: WechatBridgeNode): string {
  const sessions = listSessions(node)
  if (sessions.length === 0) return '📋 没有会话。发送 /new [模式] <prompt> 开始。'
  const lines = sessions.map((session, i) => {
    const marker = session.id === node.activeSessionId ? ' ▶' : ''
    return `${i + 1}. ${sessionLabel(session)} — ${session.id}${marker}`
  })
  return `📋 会话列表（/use N 切换）\n${lines.join('\n')}`
}

function helpText(node: WechatBridgeNode): string {
  const defaultLine = node.resolved.defaultMode
    ? `（/new 不带模式时默认 ${node.resolved.defaultMode}）`
    : ''
  return [
    '🤖 dsh-wechat-bridge 命令',
    '/modes — 列出可用模式（agent 预设，动态发现）',
    `/new [模式] <prompt> — 新建会话并开始${defaultLine}`,
    '/use N — 切换到会话 N（/sessions 查看列表）',
    '/sessions — 列出会话',
    '/stop — 停止当前任务',
    '/status — 查看状态',
    '/yes /no 或 1/2 — 回应权限请求',
    '/help — 本帮助',
  ].join('\n')
}
