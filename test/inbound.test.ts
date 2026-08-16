/**
 * Inbound extraction + command parsing unit tests — pure functions.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { extractText } from '../src/node/inbound.ts'
import { helpText, parseNewArgs, renderModesList, routeCommand } from '../src/node/commands.ts'

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

const modes = [
  { id: 'life-finance', name: '财务助理', description: '投资台账' },
  { id: 'life-career', name: '事业军师', description: '自媒体' },
]

function fakeNode() {
  return {
    ctx: {
      agentPresets: { list: async () => modes },
    },
    resolved: { menuTimeoutSec: 60, defaultMode: 'life-butler', maxMessageChars: 2000 },
    enqueueText: () => {},
  } as never
}

test('parseNewArgs treats a known mode as the mode', async () => {
  const result = await parseNewArgs(fakeNode(), ['life-finance', '今天', '怎么样'])
  assert.deepEqual(result, { mode: 'life-finance', prompt: '今天 怎么样' })
})

test('parseNewArgs treats an unknown first token as prompt text', async () => {
  const result = await parseNewArgs(fakeNode(), ['帮我看', '持仓'])
  assert.deepEqual(result, { prompt: '帮我看 持仓' })
})

test('parseNewArgs with no arguments yields an empty prompt', async () => {
  const result = await parseNewArgs(fakeNode(), [])
  assert.deepEqual(result, { prompt: '' })
})

test('helpText lists every registered command', () => {
  const text = helpText()
  for (const id of ['modes', 'new', 'sessions', 'use', 'stop', 'status', 'model', 'workspace', 'retry', 'close', 'help']) {
    assert.ok(text.includes(`/${id}`), `help should mention /${id}`)
  }
})

test('renderModesList is one compact line per mode', () => {
  const modes = [
    { id: 'standard', name: '标准模式', description: '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。' },
    { id: 'life-finance', name: '财务助理', description: '投资台账与复盘（当前实盘职责），未来承接记账与财务规划。' },
    { id: 'life-butler', name: '生活管家', description: '投资与副业之外的整个生活——周复盘闭环、装修项目、系统先知扫描。' },
  ]
  const text = renderModesList(modes, 'life-butler', 60)
  const lines = text.split('\n')
  assert.equal(lines.length, 3 + 2) // 3 modes + header + footer
  for (const line of lines.slice(1, -1)) {
    assert.ok(line.length <= 60, `mode line too long: ${line}`)
    assert.ok(line.includes('（'), 'mode line should carry the id')
  }
  assert.ok(lines[3]!.includes('· 默认'), 'default mode carries the marker')
  assert.ok(!text.includes('/new standard'), 'no per-mode /new lines (copy-noise)')
  assert.ok(text.length <= 400, `whole list should be compact, got ${text.length}`)
})

test('helpText for a single command shows usage', () => {
  assert.ok(helpText('model').includes('/model'))
  assert.ok(helpText('nope').includes('没有命令'))
})

test('routeCommand forwards //-prefixed text for the agent', async () => {
  const sent: string[] = []
  const node = {
    ...fakeNode(),
    enqueueText: (_peer: string, text: string) => {
      sent.push(text)
    },
  } as never
  const result = await routeCommand(node, 'peer-a', '//帮我看 /30 收益')
  assert.equal(result, 'forward')
  assert.equal(sent.length, 0)
})

test('routeCommand treats plain text as not-command', async () => {
  const result = await routeCommand(fakeNode(), 'peer-a', '帮我看持仓')
  assert.equal(result, 'not-command')
})

test('routeCommand answers unknown commands with help', async () => {
  const sent: string[] = []
  const node = {
    ...fakeNode(),
    enqueueText: (_peer: string, text: string) => {
      sent.push(text)
    },
  } as never
  const result = await routeCommand(node, 'peer-a', '/frobnicate')
  assert.equal(result, 'handled')
  assert.equal(sent.length, 1)
  assert.ok(sent[0]!.includes('未知命令'))
})
