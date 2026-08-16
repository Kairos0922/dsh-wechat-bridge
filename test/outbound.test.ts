/**
 * Outbound chunking unit tests — pure functions, no live DSH needed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
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
