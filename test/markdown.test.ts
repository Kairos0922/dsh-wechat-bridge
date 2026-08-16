/**
 * Markdown policy unit tests.
 *
 * The `filter` vectors below mirror the official test suite of
 * Tencent/openclaw-weixin `src/messaging/markdown-filter.test.ts` (MIT) for
 * the ported state machine — port parity is proven by sharing expectations.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderForWechat, StreamingMarkdownFilter } from '../src/node/markdown.ts'

function filter(input: string): string {
  const f = new StreamingMarkdownFilter()
  return f.feed(input) + f.flush()
}

// ---- vectors migrated from the official markdownToPlainText suite ---------

test('filter preserves code blocks with markers', () => {
  const input = 'before\n```js\nconst x = 1;\n```\nafter'
  assert.equal(filter(input), input)
})

test('filter removes image markdown', () => {
  assert.equal(filter('![alt](url)'), '')
})

test('filter preserves bold and non-CJK italic markers', () => {
  assert.equal(filter('**bold** and *italic*'), '**bold** and *italic*')
})

test('filter preserves table with surrounding text', () => {
  const input = '结果如下：\n| A | B |\n|---|---|\n| 1 | 2 |\n完毕。'
  assert.equal(filter(input), input)
})

// ---- vectors from the official StreamingMarkdownFilter suite ---------------

test('filter passes plain text unchanged', () => {
  assert.equal(filter('hello world'), 'hello world')
  assert.equal(filter('你好，世界'), '你好，世界')
})

test('filter strips CJK italic markers but keeps content', () => {
  assert.equal(filter('*中文斜体*'), '中文斜体')
})

test('filter keeps non-CJK italic', () => {
  assert.equal(filter('*italic*'), '*italic*')
})

test('filter strips h5/h6 markers but keeps h1–h4', () => {
  assert.equal(filter('##### 五级'), '五级')
  assert.equal(filter('###### 六级'), '六级')
  assert.equal(filter('## 二级'), '## 二级')
})

test('filter passes blockquotes through verbatim', () => {
  assert.equal(filter('> quoted'), '> quoted')
})

test('filter preserves horizontal rules', () => {
  assert.equal(filter('---'), '---')
})

test('filter strips CJK bold-italic markers but keeps content', () => {
  assert.equal(filter('***中文***'), '中文')
  assert.equal(filter('***bold***'), '***bold***')
})

test('filter is stream-chunk invariant', () => {
  const input = '开头\n## 标题\n**加粗**\n```js\nconst a = 1\n```\n结尾'
  const oneShot = filter(input)
  const f = new StreamingMarkdownFilter()
  let streamed = ''
  for (const ch of input) streamed += f.feed(ch)
  streamed += f.flush()
  assert.equal(streamed, oneShot)
})

// ---- renderForWechat policies ----------------------------------------------

test('passthrough keeps markdown but turns images into bare URLs', () => {
  const input = '看 **这里** ![图](https://example.com/a.png) 完毕'
  assert.equal(renderForWechat(input, 'passthrough'), '看 **这里** https://example.com/a.png 完毕')
})

test('plain strips every marker', () => {
  const input = '## 标题\n**加粗** 和 `代码`\n- 列表一\n1. 列表二\n> 引用'
  const out = renderForWechat(input, 'plain')
  assert.ok(!out.includes('##'))
  assert.ok(!out.includes('**'))
  assert.ok(!out.includes('`'))
  assert.ok(!out.includes('> '))
  assert.ok(out.includes('标题'))
  assert.ok(out.includes('加粗'))
})

test('filter strips CJK italic while passthrough keeps it', () => {
  const input = '*中文斜体*'
  assert.equal(renderForWechat(input, 'filter'), '中文斜体')
  assert.equal(renderForWechat(input, 'passthrough'), input)
})
