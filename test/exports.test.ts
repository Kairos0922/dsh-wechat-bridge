/**
 * Export + card unit tests — pure parts, no Chrome, no network.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildTranscript, writeExportFile } from '../src/node/exports.ts'
import { buildCardHtml, estimateHeight } from '../src/node/card.ts'

test('buildTranscript renders user/assistant/tool entries', () => {
  const transcript = buildTranscript({
    id: 'wechat-1',
    events: [
      { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } },
      { type: 'tool/call', data: { name: 'bash' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**回复**' }] } } },
    ],
  } as never)
  assert.ok(transcript.includes('👤 用户'))
  assert.ok(transcript.includes('你好'))
  assert.ok(transcript.includes('🛠 bash'))
  assert.ok(transcript.includes('**回复**'))
})

test('writeExportFile writes a .md file under the exports dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-export-'))
  const node = { resolved: { mediaDir: dir } } as never
  const { filePath, fileName } = writeExportFile(node, 'wechat-123', '# 内容', 'answer')
  assert.ok(fileName.endsWith('.md'))
  assert.ok(fileName.startsWith('ds-answer-'))
  assert.equal(fs.readFileSync(filePath, 'utf-8'), '# 内容')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('buildCardHtml escapes markup and carries the measure script', () => {
  const html = buildCardHtml('<script>alert(1)</script> & **粗体**')
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(!html.includes('<script>alert'))
  assert.ok(html.includes('document.title'))
})

test('estimateHeight stays within bounds', () => {
  assert.ok(estimateHeight(100) >= 600)
  assert.ok(estimateHeight(100) <= 8000)
  assert.equal(estimateHeight(1_000_000), 8000)
})
