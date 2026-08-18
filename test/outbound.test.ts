/**
 * Outbound chunking unit tests — pure functions, no live DSH needed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildContextUsageLine,
  isProgressTool,
  normalizeMarkdownBlocks,
  splitForWechat,
  textOfAssistantMessage,
} from '../src/node/outbound.ts'

test('splitForWechat keeps short text in one unit', () => {
  assert.deepEqual(splitForWechat('你好，世界', 2000), ['你好，世界'])
})

test('splitForWechat packs long text into ≤max units', () => {
  const long = '段落A。'.repeat(600) // 2400 chars
  const units = splitForWechat(long, 1000)
  assert.ok(units.length >= 3)
  for (const unit of units) assert.ok(unit.length <= 1000)
  assert.equal(units.join(''), long.replace(/\n\n/g, ''))
})

test('splitForWechat keeps fenced code blocks intact when short', () => {
  const md = '说明\n\n```js\nconst a = 1\n```'
  const units = splitForWechat(md, 2000)
  assert.equal(units.length, 1)
  assert.ok(units[0]!.includes('```js'))
})

test('normalizeMarkdownBlocks collapses blank-line runs', () => {
  const out = normalizeMarkdownBlocks('a\n\n\n\nb')
  assert.equal(out, 'a\n\nb')
})

test('textOfAssistantMessage joins text blocks only', () => {
  const text = textOfAssistantMessage({
    content: [
      { type: 'text', text: '第一段' },
      { type: 'tool', name: 'x' },
      { type: 'text', text: '第二段' },
    ],
  } as never)
  assert.equal(text, '第一段\n第二段')
})

test('isProgressTool: empty prefix list disables cards entirely', () => {
  const node = { resolved: { progressToolPrefixes: [] } } as never
  assert.equal(isProgressTool(node, 'bash'), false)
  assert.equal(isProgressTool(node, 'fs'), false)
})

test('isProgressTool: non-empty list cards only matching prefixes', () => {
  const node = { resolved: { progressToolPrefixes: ['bash', 'fs'] } } as never
  assert.equal(isProgressTool(node, 'bash'), true)
  assert.equal(isProgressTool(node, 'fs-search'), true)
  assert.equal(isProgressTool(node, 'web'), false)
})

test('buildContextUsageLine: reports tokens vs window and escalates near the limit', async () => {
  const usageEvent = (input: number) => ({ type: 'assistant/message', data: { message: {}, usage: { inputTokens: input, outputTokens: 10 } } })
  const session = { id: 'wechat-x', events: [usageEvent(12000)] }
  const ctx = {
    get: () => ({
      listModels: async () => [{ id: 'deepseek-chat', contextWindow: 32000 }],
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
  }
  const node = {
    ctx,
    peerOf: () => 'a@im.wechat',
    state: { getPrefs: () => ({}) },
    resolved: { agentProvider: 'deepseek', agentModel: 'deepseek-chat' },
  }
  const line = await buildContextUsageLine(session as never, node as never)
  assert.match(line ?? '', /12.0k \/ 32.0k（38%）/)
  const hot = await buildContextUsageLine({ id: 'wechat-y', events: [usageEvent(26000)] } as never, node as never)
  assert.match(hot ?? '', /81%/)
  assert.match(hot ?? '', /建议 \/new/)
  const none = await buildContextUsageLine({ id: 'wechat-z', events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] } as never, node as never)
  assert.equal(none, null)
})

// ---------------------------------------------------------------------------
// Session-event digest pipeline: intermediate texts are silent; the final
// answer is flushed at turn/end (product decision 2026-08-18).
// ---------------------------------------------------------------------------

import { WechatBridgeNode } from '../src/node/core.ts'
import { attachSessionOutbound } from '../src/node/outbound.ts'

const DIGEST_CONFIG = {
  allowFrom: ['peer-a@im.wechat'],
  approvalTimeoutSec: 600,
  maxMessageChars: 2000,
  minSendIntervalMs: 5000,
  rateLimitBackoffSecs: [10, 30, 60],
  sendBudgetWindowSec: 60,
  sendBudgetMaxPerWindow: 4,
  sessionExpiredPauseMin: 60,
  thinkingDigestSec: 10,
  typingHeartbeatSec: 0,
  menuTimeoutSec: 60,
  markdownMode: 'passthrough',
  progressToolPrefixes: [],
} as never

function digestHarness() {
  const handler: { current?: (session: unknown, event: unknown) => void } = {}
  const ctx = {
    logger: { warn() {}, info() {} },
    get: () => undefined,
    on: (_name: string, fn: (session: unknown, event: unknown) => void) => {
      handler.current = fn
      return () => {}
    },
    wechat: {
      sendTypingIndicator: async () => {},
    },
  }
  const node = new WechatBridgeNode(ctx as never, DIGEST_CONFIG)
  const sent: Array<{ text: string; kind: string }> = []
  node.enqueueText = ((_peer: string, text: string, opts: { kind?: string } = {}) => {
    sent.push({ text, kind: opts.kind ?? 'text' })
  }) as never
  const disposer = attachSessionOutbound(node)
  const session = { id: 'wechat-msx-test-1', events: [] }
  return { node, sent, fire: (e: unknown) => handler.current?.(session as never, e), dispose: () => { disposer(); node.dispose() } }
}

test('intermediate assistant texts are NOT pushed; the final one is flushed at turn/end', async () => {
  const h = digestHarness()
  h.node.setActiveSession('peer-a@im.wechat', 'wechat-msx-test-1' as never)
  const am = (text: string) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  h.fire({ type: 'turn/start', data: { turn: 1 } })
  h.fire(am('工具中间叙述：数据到手'))
  h.fire({ type: 'tool/call', data: { name: 'bash', callId: 'c1' } })
  h.fire(am('又一条中间叙述'))
  h.fire(am('最终答案：持仓诊断完成'))
  h.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const texts = h.sent.filter((s) => s.kind === 'text').map((s) => s.text)
  assert.equal(texts.includes('工具中间叙述：数据到手'), false, 'intermediate narration is silent')
  assert.equal(texts.includes('又一条中间叙述'), false)
  assert.ok(texts.some((t) => t.includes('最终答案：持仓诊断完成')), 'final answer flushed at turn/end')
  h.dispose()
})

test('aborted turns do not flush the cached text (stop affordance only)', async () => {
  const h = digestHarness()
  h.node.setActiveSession('peer-a@im.wechat', 'wechat-msx-test-1' as never)
  const am = (text: string) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  h.fire({ type: 'turn/start', data: { turn: 1 } })
  h.fire(am('部分输出'))
  h.fire({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  const texts = h.sent.map((s) => s.text)
  assert.equal(texts.includes('部分输出'), false, 'aborted partial output is not pushed')
  assert.ok(texts.some((t) => t.includes('已停止')), 'stop notice still sent')
  h.dispose()
})
