/**
 * User-question bridge: DSH `user-questions/request` → WeChat numbered prompt.
 *
 * The `ask_user_question` tool BLOCKS the whole turn until a human answers, and
 * WeChat personal accounts have no buttons — so before this bridge existed the
 * request was claimed by the remote/browser answerer and quietly parked there
 * while the WeChat user saw nothing at all.
 *
 * 2026-09-20 incident (the reason this file exists): a session asked one
 * confirmation question via `ask_user_question`. The bridge was not an
 * answerer, so `dsh-api-remotes` forwarded the request to the browser client;
 * no browser was watching that session. The turn sat blocked for 32 minutes
 * with zero outbound messages, the stall watchdog reported it as a *model
 * channel* failure (可能是模型通道异常), the user's "看下任务进度啊" queued as a
 * next-turn message that could never answer the pending question, and only
 * `/stop` ended it. `ask_user_question` is now answerable from the phone.
 *
 * Design notes:
 * - Registration is `prepend: true`: the WeChat peer is the human at the
 *   keyboard, so the bridge must claim BEFORE `dsh-api-remotes` parks the
 *   request in a browser the user is not looking at. Sessions with no WeChat
 *   owner still delegate via `next()` — the browser keeps its behaviour.
 * - A slash command is never swallowed as an answer, so `/stop` stays the
 *   escape hatch while a question is pending.
 * - Multiple questions in one request are asked SEQUENTIALLY: one prompt per
 *   question, so a phone reply is never ambiguous about which question it
 *   answers. Concurrent requests from one peer are answered oldest-first.
 * - The wait is bounded (`questionTimeoutSec`): an unanswered question ends as
 *   an explicit tool error the agent can react to, never as an endless hang.
 *
 * @module dsh-wechat-bridge/node/questions
 */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { WechatBridgeNode } from './core.ts'

/** Cap on the rendered `detail` (plan-review plans can be very long). */
const DETAIL_MAX_CHARS = 600

/**
 * One pending question request awaiting a WeChat reply.
 *
 * The prompt/answer state machine lives in the closures behind `submit` and
 * `discard`; the node only stores this object so inbound routing can find the
 * peer's pending request and feed it a reply.
 */
export interface PendingQuestion {
  number: number
  /** The peer the prompt was sent to — only that peer may answer. */
  peerId: string
  request: AskUserQuestionRequest
  /** Index of the question currently displayed. */
  index: number
  /**
   * Offer one inbound message to this request. Accepts it (answering the
   * displayed question and pushing the next one, or resolving the request) and
   * returns `'accepted'`; returns `'ignored'` when the message is not an answer
   * at all (slash command, empty) so normal routing may continue. A malformed
   * reply is answered with a clarification and reported as `'accepted'` — the
   * question stays pending.
   */
  submit: (text: string) => 'accepted' | 'ignored'
  /** Drop the pending state without answering (timeout/abort/dispose). */
  discard: () => void
}

/** Parsed meaning of one WeChat reply for one question. */
export type QuestionReply =
  | { kind: 'answer'; selected: string[]; custom?: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'none' }

/**
 * Parse one WeChat reply against the displayed question.
 *
 * Numbered options are selected by number; anything else is the free-text
 * "Other" answer DSH models already understand (`selected: []` + `custom`).
 * A leading `/` is deliberately NOT an answer: commands outrank a pending
 * question, which is what keeps `/stop` usable mid-question.
 */
export function parseQuestionReply(raw: string, question: AskUserQuestionItem): QuestionReply {
  const text = raw.trim()
  if (text.length === 0) return { kind: 'none' }
  if (text.startsWith('/')) return { kind: 'none' }

  const options = question.options ?? []
  if (options.length === 0) return { kind: 'answer', selected: [], custom: text }

  const tokens = text.split(/[\s,，、]+/).filter((token) => token.length > 0)
  if (!tokens.every((token) => /^\d+$/.test(token))) {
    // Not a selection at all → treat the whole message as the custom answer.
    return { kind: 'answer', selected: [], custom: text }
  }
  const numbers = tokens.map((token) => Number(token))
  const outOfRange = numbers.find((value) => value < 1 || value > options.length)
  if (outOfRange !== undefined) {
    return { kind: 'invalid', reason: `编号 ${outOfRange} 超出范围，本题可选 1-${options.length}` }
  }
  const unique = [...new Set(numbers)]
  if (unique.length > 1 && question.multiSelect !== true) {
    return { kind: 'invalid', reason: '本题为单选，请只回复一个编号' }
  }
  return { kind: 'answer', selected: unique.map((value) => options[value - 1]!.label) }
}

/** Build the WeChat prompt for the question currently displayed. */
export function buildQuestionPrompt(pending: PendingQuestion, timeoutSec: number): string {
  const { request, index, number } = pending
  const total = request.questions.length
  const question = request.questions[index]!
  const lines: string[] = []
  lines.push(`❓ #${number} 需要你的回答${total > 1 ? `（第 ${index + 1}/${total} 问）` : ''}`)
  if (question.header) lines.push(`【${question.header}】`)
  lines.push(question.question)
  if (question.detail) {
    const detail = question.detail.trim()
    lines.push(
      detail.length > DETAIL_MAX_CHARS
        ? `${detail.slice(0, DETAIL_MAX_CHARS)}…（内容过长已截断）`
        : detail,
    )
  }
  const options = question.options ?? []
  if (options.length > 0) {
    for (const [position, option] of options.entries()) {
      lines.push(`${position + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)
    }
    lines.push(
      question.multiSelect === true
        ? '回复编号作答，可多选（如 1,3）；也可直接回复文字作为自定义答案。'
        : '回复编号作答（如 1）；也可直接回复文字作为自定义答案。',
    )
  } else {
    lines.push('直接回复你的答案。')
  }
  lines.push(`回复 /stop 可中断任务；${Math.max(1, Math.round(timeoutSec / 60))} 分钟内未回复将按未回答处理。`)
  return lines.join('\n')
}

/**
 * Attach the `user-questions/request` answerer. Returns a disposer.
 *
 * Registered with `prepend` so the WeChat bridge wins the waterfall over the
 * remote/browser forwarder for WeChat-owned sessions (see the module doc).
 */
export function attachUserQuestionBridge(node: WechatBridgeNode): () => void {
  const listener = async (
    request: AskUserQuestionRequest,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> => {
    const agent = request.agent
    // No agent ⇒ the request cannot be attributed to a peer; no WeChat owner ⇒
    // the browser UI owns it (same delegation rule as approvals.ts).
    const owner = agent === undefined ? null : node.peerOf(agent.session.id)
    if (owner === null) return next()
    // Bind after the null check: the helpers below are hoisted function
    // declarations, so a narrowing on `owner` would not survive inside them.
    const peer: string = owner
    if (request.questions.length === 0) return next()

    const number = node.nextQuestionNumber()
    const timeoutSec = node.resolved.questionTimeoutSec
    const timeoutLabel = `${Math.max(1, Math.round(timeoutSec / 60))} 分钟`

    return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const answers: AskUserQuestionAnswerItem[] = []
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      function cleanup(): void {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        request.signal?.removeEventListener('abort', onAbort)
        // Every settlement path (answered / timed out / aborted / discarded)
        // deregisters, so the node never keeps a request that can no longer be
        // answered and a later inbound is never swallowed by a stale entry.
        node.clearQuestion(number)
      }

      /** Settle exactly once, releasing the timer and the abort listener. */
      function settle(action: () => void): void {
        if (settled) return
        settled = true
        cleanup()
        action()
      }

      /**
       * Arm the deadline for the question now on screen. Re-armed per question
       * so the clock always measures what the user is actually looking at.
       */
      function armTimeout(): void {
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
          // Tell the user why the turn moved on — silence would look like a
          // dropped question.
          node.enqueueText(peer, `⌛ #${number} 超时未回答（${timeoutLabel}），已按未回答继续。`, {
            kind: 'system',
          })
          settle(() => reject(new Error(`用户未在 ${timeoutLabel}内回答提问 #${number}，按未回答继续`)))
        }, timeoutSec * 1000)
        timer.unref?.()
      }

      // The caller's signal aborts with the turn (/stop, cancel): drop the
      // pending state so a later inbound is not swallowed as a stale answer.
      function onAbort(): void {
        settle(() => reject(new Error('ask_user_question was aborted before the user answered')))
      }

      const pending: PendingQuestion = {
        number,
        peerId: peer,
        request,
        index: 0,
        submit(text) {
          const question = request.questions[pending.index]
          if (question === undefined) return 'ignored'
          const reply = parseQuestionReply(text, question)
          if (reply.kind === 'none') return 'ignored'
          if (reply.kind === 'invalid') {
            node.enqueueText(peer, `⚠️ ${reply.reason}`, { kind: 'system' })
            return 'accepted'
          }
          const item: AskUserQuestionAnswerItem = { id: question.id, selected: reply.selected }
          if (reply.custom !== undefined) item.custom = reply.custom
          answers.push(item)
          pending.index += 1
          if (pending.index < request.questions.length) {
            node.enqueueQuestionPrompt(peer, buildQuestionPrompt(pending, timeoutSec), number)
            armTimeout()
            return 'accepted'
          }
          settle(() => resolve({ answers }))
          return 'accepted'
        },
        discard() {
          settle(() => reject(new Error(`提问 #${number} 已作废`)))
        },
      }

      if (request.signal?.aborted === true) {
        onAbort()
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      node.registerQuestion(number, pending)
      // Show the question FIRST — the user cannot answer what they cannot see.
      // MUST-DELIVER tier, and re-pushed on the peer's next inbound if the
      // channel dropped it (see retryQuestionPrompt).
      node.enqueueQuestionPrompt(peer, buildQuestionPrompt(pending, timeoutSec), number)
      armTimeout()
    })
  }

  // prepend: claim before dsh-api-remotes forwards to a browser the WeChat user
  // is not watching (2026-09-20 incident).
  const disposer = node.ctx.on('user-questions/request', listener, { prepend: true })
  return () => {
    disposer()
  }
}
