/**
 * Permission-request bridge: DSH `approval/request` → WeChat text prompt.
 *
 * WeChat personal accounts have no buttons, so a permission request is
 * rendered as a numbered text prompt and resolved by `/yes` or `/no` (bare
 * `1`/`2` also work while exactly one request is pending). The prompt now
 * includes a short argument summary (recovered from the session's logged
 * tool call via `callId`), so risky parameters are visible before consent.
 * A reply timeout falls back to DSH's default deny (`'rejected'`).
 *
 * The bridge only answers for agents whose session a WeChat peer owns; every
 * other request delegates via `next()`. Requests route to the owning peer —
 * never to whoever spoke last.
 *
 * @module dsh-wechat-bridge/node/approvals
 */

import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { WechatBridgeNode } from './core.ts'
import { sendTextToPeer } from './outbound.ts'

/** One pending approval awaiting a WeChat reply. */
export interface PendingApproval {
  number: number
  /** The peer the prompt was sent to — only that peer may answer. */
  peerId: string
  request: ApprovalRequest
  resolve: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

/** Short argument summary from the logged tool call, when callId links one. */
export function approvalArgsSummary(request: ApprovalRequest): string | null {
  if (!request.callId) return null
  for (const event of request.agent.session.events) {
    if (event.type === 'tool/call' && event.data.callId === request.callId) {
      const collapsed = event.data.arguments.replace(/\s+/g, ' ').trim()
      return collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed
    }
  }
  return null
}

/** Attach the `approval/request` answerer. Returns a disposer. */
export function attachApprovalBridge(node: WechatBridgeNode): () => void {
  const listener = async (
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    // Only answer for agents whose session a WeChat peer owns.
    const peer = node.peerOf(req.agent.session.id)
    if (peer === null) return next()

    const number = node.nextApprovalNumber()
    const timeoutSec = node.resolved.approvalTimeoutSec
    const args = approvalArgsSummary(req)
    const prompt = [
      `🔐 #${number} 需要你的确认`,
      `工具: ${req.toolName}`,
      ...(args !== null ? [`参数: ${args}`] : []),
      ...(req.reason ? [`原因: ${req.reason}`] : []),
      '回复 /yes 同意，/no 拒绝（仅一条待确认时也可回复 1/2）',
      `${Math.max(1, Math.round(timeoutSec / 60))} 分钟内未回复将自动拒绝。`,
    ].join('\n')

    // Show the question FIRST — the user cannot answer what they cannot see.
    void sendTextToPeer(node, peer, prompt, { kind: 'system' })

    const outcome = await new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        node.clearApproval(number)
        resolve('rejected') // default deny on timeout
      }, timeoutSec * 1000)
      timer.unref?.()
      node.registerApproval(number, { number, peerId: peer, request: req, resolve, timer })
    })

    const label =
      outcome === 'allowed-once' ? '✅ 已同意' : outcome === 'rejected' ? '❌ 已拒绝' : `⏳ ${outcome}`
    void sendTextToPeer(node, peer, `${label}（#${number}）`, { kind: 'system' })
    return outcome
  }

  const disposer = node.ctx.on('approval/request', listener)
  return () => {
    disposer()
  }
}
