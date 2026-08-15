/**
 * Outbound bridge: session events → WeChat messages.
 *
 * Emits a small digest vocabulary from the append-only session log:
 * task started, heartbeat, assistant text (chunked), finished/error.
 * The markdown-aware chunker follows the hermes-agent splitting approach
 * (also used by dsh-chatnode-wechat, MIT) — reimplemented here.
 *
 * @module dsh-wechat-bridge/node/outbound
 */

import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MAX_MESSAGE_CHARS } from '../gateway/types.ts'
import type { WechatBridgeNode } from './core.ts'

// ---------------------------------------------------------------------------
// Chunking

const FENCE_RE = /^```([^\n`]*)\s*$/

/** Collapse runs of blank lines to one; strips surrounding whitespace. */
export function normalizeMarkdownBlocks(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let blankRun = 0
  let inCode = false
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (FENCE_RE.test(line.trim())) {
      inCode = !inCode
      out.push(line)
      blankRun = 0
      continue
    }
    if (inCode) {
      out.push(line)
      continue
    }
    if (!line.trim()) {
      blankRun += 1
      if (blankRun <= 1) out.push('')
      continue
    }
    blankRun = 0
    out.push(line)
  }
  return out.join('\n').trim()
}

/** Split content into markdown blocks, keeping fenced code blocks intact. */
export function splitMarkdownBlocks(content: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let inCode = false

  const flush = () => {
    const block = current.join('\n').trim()
    if (block) blocks.push(block)
    current = []
  }

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (FENCE_RE.test(line.trim())) {
      if (!inCode && current.length) flush()
      current.push(line)
      inCode = !inCode
      if (!inCode) flush()
      continue
    }
    if (inCode) {
      current.push(line)
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  return blocks
}

/** Split one oversized block into ≤max chunks (hard-truncating the tail). */
function hardSplit(text: string, max: number): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    chunks.push(rest.slice(0, max))
    rest = rest.slice(max)
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** Greedy-pack markdown blocks into ≤max units. */
function packBlocks(blocks: string[], max: number): string[] {
  const units: string[] = []
  let current = ''
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block
    if (candidate.length <= max) {
      current = candidate
      continue
    }
    if (current) units.push(current)
    if (block.length <= max) {
      current = block
    } else {
      units.push(...hardSplit(block, max))
      current = ''
    }
  }
  if (current) units.push(current)
  return units
}

/** Split assistant text into WeChat delivery units (≤max each). */
export function splitForWechat(content: string, max: number = MAX_MESSAGE_CHARS): string[] {
  const normalized = normalizeMarkdownBlocks(content)
  if (!normalized) return []
  if (normalized.length <= max) return [normalized]
  return packBlocks(splitMarkdownBlocks(normalized), max)
}

/** Extract the visible text of an assistant message. */
export function textOfAssistantMessage(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Digest summary

/** One-line progress summary derived from the session log (cheap, replayable). */
export function digestLine(session: Session): string {
  let turn = 0
  let tools = 0
  let lastTool: string | undefined
  let inTurn = false
  for (const event of session.events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      inTurn = true
      tools = 0
      lastTool = undefined
    } else if (event.type === 'turn/end') {
      inTurn = false
    } else if (event.type === 'tool/call' && inTurn) {
      tools += 1
      lastTool = event.data.name
    }
  }
  const steps = tools > 0 ? `${tools} 个工具调用` : '思考中'
  const last = lastTool ? ` · 最近: ${lastTool}` : ''
  return `🔄 仍在处理中…（第 ${turn} 轮 · ${steps}${last}）`
}

// ---------------------------------------------------------------------------
// Delivery

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Send text to the current peer, chunked and throttled. */
export async function sendTextToPeer(node: WechatBridgeNode, text: string): Promise<void> {
  const peer = node.peerId
  if (!peer) return
  const chunks = splitForWechat(text, node.resolved.maxMessageChars)
  if (chunks.length === 0) return
  await node.ctx.wechat.sendTypingIndicator({ toUserId: peer, status: 1 }).catch(() => {})
  try {
    for (let i = 0; i < chunks.length; i++) {
      const ok = await node.ctx.wechat.sendText({
        toUserId: peer,
        text: chunks[i]!,
        contextToken: node.peerContextToken ?? undefined,
      })
      if (!ok) {
        node.ctx.logger.warn('[dsh-wechat-bridge] outbound chunk %d/%d failed', i + 1, chunks.length)
        break
      }
      if (i < chunks.length - 1 && node.resolved.sendChunkDelayMs > 0) {
        await sleep(node.resolved.sendChunkDelayMs)
      }
    }
  } finally {
    await node.ctx.wechat.sendTypingIndicator({ toUserId: peer, status: 2 }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Session-event wiring

interface DigestState {
  startedTurns: Set<number>
  heartbeat?: ReturnType<typeof setInterval>
}

/**
 * Attach the outbound digest pipeline. Listens on `session/event` once and
 * filters to the node's active session; per-session digest state keyed by id.
 */
export function attachSessionOutbound(node: WechatBridgeNode): () => void {
  const digestState = new Map<string, DigestState>()

  const stopHeartbeat = (state: DigestState) => {
    if (state.heartbeat) {
      clearInterval(state.heartbeat)
      state.heartbeat = undefined
    }
  }

  const startHeartbeat = (session: Session, state: DigestState) => {
    stopHeartbeat(state)
    if (node.resolved.digestIntervalSec <= 0) return
    state.heartbeat = setInterval(() => {
      void sendTextToPeer(node, digestLine(session))
    }, node.resolved.digestIntervalSec * 1000)
    state.heartbeat.unref?.()
  }

  const onEvent = (session: Session, event: SessionEvent): void => {
    if (session.id !== node.activeSessionId) return
    const state = digestState.get(session.id) ?? { startedTurns: new Set<number>() }
    digestState.set(session.id, state)

    if (event.type === 'turn/start') {
      const turn = event.data.turn
      if (!state.startedTurns.has(turn)) {
        state.startedTurns.add(turn)
        void sendTextToPeer(node, '⏳ 收到，开始处理…')
      }
      startHeartbeat(session, state)
      return
    }
    if (event.type === 'assistant/message') {
      const text = textOfAssistantMessage(event.data.message)
      if (text.trim()) void sendTextToPeer(node, text)
      return
    }
    if (event.type === 'turn/end') {
      stopHeartbeat(state)
      const reason = event.data.reason
      if (reason.kind === 'error') {
        void sendTextToPeer(node, `❌ 处理出错: ${summarizeError(reason.error)}`)
      } else if (reason.kind === 'aborted') {
        void sendTextToPeer(node, '⏹ 已停止')
      } else if (reason.kind === 'max-tokens') {
        void sendTextToPeer(node, '⚠️ 达到输出上限，本轮已截断')
      }
      return
    }
  }

  const disposer = node.ctx.on('session/event', onEvent)
  return () => {
    for (const state of digestState.values()) stopHeartbeat(state)
    disposer()
  }
}

function summarizeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message).slice(0, 200)
  }
  return String(error).slice(0, 200)
}
