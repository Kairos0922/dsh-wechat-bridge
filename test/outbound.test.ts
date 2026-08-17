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
