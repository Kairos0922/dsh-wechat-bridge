/**
 * Inbound extraction + command parsing unit tests — pure functions.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { extractText } from '../src/node/inbound.ts'
import { parseNewArgs } from '../src/node/commands.ts'

test('extractText returns text items', () => {
  const text = extractText({
    item_list: [{ type: 1, text_item: { text: '你好' } }],
  } as never)
  assert.equal(text, '你好')
})

test('extractText falls back to voice transcription', () => {
  const text = extractText({
    item_list: [{ type: 3, voice_item: { text: '帮我看下持仓' } }],
  } as never)
  assert.equal(text, '[语音转写]\n帮我看下持仓')
})

test('extractText returns empty for media-only messages', () => {
  const text = extractText({
    item_list: [{ type: 2, image_item: { url: 'https://cdn/x' } }],
  } as never)
  assert.equal(text, '')
})

test('parseNewArgs treats a known mode as the mode', () => {
  const node = { presets: { has: (id: string) => id === 'life-finance' } } as never
  assert.deepEqual(parseNewArgs(node, ['life-finance', '今天', '怎么样']), {
    mode: 'life-finance',
    prompt: '今天 怎么样',
  })
})

test('parseNewArgs treats an unknown first token as prompt text', () => {
  const node = { presets: { has: () => false } } as never
  assert.deepEqual(parseNewArgs(node, ['帮我', '查一下']), {
    prompt: '帮我 查一下',
  })
})
