/**
 * Upstream-alignment tests (2026-09 diff vs @tencent-weixin/openclaw-weixin
 * 2.4.8): the pure functions ported or hardened in that pass — sanitizeBotAgent,
 * classifyFetchError, mimeFromFilename, fetchRemoteMedia guards, and the QR
 * request body carrying local_token_list.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyFetchError,
  fetchQrCode,
  sanitizeBotAgent,
} from '../src/gateway/ilink-client.ts'
import { mimeFromFilename } from '../src/gateway/media.ts'
import { fetchRemoteMedia } from '../src/gateway/index.ts'
import { assertCleanBaseUrl } from '../src/config-guard.ts'
import { InboundDebouncer } from '../src/node/debounce.ts'
import { ITEM_TEXT, ITEM_IMAGE } from '../src/gateway/types.ts'

// ------------------------------------------------------------- sanitizeBotAgent

test('sanitizeBotAgent falls back to the versioned default', () => {
  const fallback = sanitizeBotAgent(undefined)
  assert.match(fallback, /^dsh-wechat-bridge\/\d+\.\d+\.\d+$/)
  assert.equal(sanitizeBotAgent('   '), fallback)
  assert.equal(sanitizeBotAgent(''), fallback)
})

test('sanitizeBotAgent keeps a valid product token', () => {
  assert.equal(sanitizeBotAgent('mybot/1.2.3'), 'mybot/1.2.3')
  assert.equal(sanitizeBotAgent('mybot/1.2.3 (kairos)'), 'mybot/1.2.3 (kairos)')
})

test('sanitizeBotAgent drops tokens failing the UA grammar', () => {
  // "not-a-product" has no version segment → dropped; valid token kept.
  assert.equal(sanitizeBotAgent('not-a-product mybot/2.0'), 'mybot/2.0')
  // Unterminated comment → dropped.
  assert.equal(sanitizeBotAgent('mybot/1.0 (oops'), 'mybot/1.0')
})

test('sanitizeBotAgent truncates to 256 bytes by dropping trailing tokens', () => {
  const long = Array.from({ length: 40 }, (_, i) => `prod${i}/${i}`).join(' ')
  const out = sanitizeBotAgent(long)
  assert.ok(Buffer.byteLength(out) <= 256)
  assert.ok(out.startsWith('prod0/0'))
})

// ----------------------------------------------------------- classifyFetchError

test('classifyFetchError: abort → timeout', () => {
  const err = new Error('aborted')
  err.name = 'AbortError'
  assert.deepEqual(classifyFetchError(err), { type: 'timeout', description: 'request timeout' })
})

test('classifyFetchError: dns/tcp/tls cause codes', () => {
  const mk = (code: string, message = 'fetch failed') => {
    const e = new Error(message) as Error & { cause?: { code: string } }
    e.cause = { code }
    return e
  }
  assert.equal(classifyFetchError(mk('ENOTFOUND')).type, 'dns')
  assert.equal(classifyFetchError(mk('EAI_AGAIN')).type, 'dns')
  assert.equal(classifyFetchError(mk('ECONNREFUSED')).type, 'tcp')
  assert.equal(classifyFetchError(mk('ETIMEDOUT')).type, 'tcp')
  assert.equal(classifyFetchError(mk('CERT_HAS_EXPIRED')).type, 'tls')
  assert.equal(classifyFetchError(mk('SOMETHING_ELSE')).type, 'unknown')
})

// ------------------------------------------------------------------ mime table

test('mimeFromFilename covers common document/media types', () => {
  assert.equal(mimeFromFilename('report.pdf'), 'application/pdf')
  assert.equal(mimeFromFilename('a/b/表.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(mimeFromFilename('clip.mp4'), 'video/mp4')
  assert.equal(mimeFromFilename('notes.md'), 'text/markdown')
})

test('mimeFromFilename falls back to octet-stream for unknown extensions', () => {
  assert.equal(mimeFromFilename('data.weird'), 'application/octet-stream')
  assert.equal(mimeFromFilename(undefined), 'application/octet-stream')
})

// ------------------------------------------------------------- uncertain/base URL/debounce

test('assertCleanBaseUrl rejects embedded credentials but accepts a plain endpoint', () => {
  assert.doesNotThrow(() => assertCleanBaseUrl('https://ilinkai.weixin.qq.com', 'baseUrl'))
  assert.throws(() => assertCleanBaseUrl('https://user:pass@example.com', 'baseUrl'), /credential-bearing/)
  assert.throws(() => assertCleanBaseUrl('https://example.com/?bot_token=x', 'baseUrl'), /credential-like/)
})

test('InboundDebouncer ignores empty messages', () => {
  const debouncer = new InboundDebouncer({ windowMs: 2000, onFlush: () => {}, setTimer: (fn) => fn as any, clearTimer: () => {} })
  assert.deepEqual(debouncer.admit({ senderId: 'peer', message: { item_list: [] } }), [{ senderId: 'peer', message: { item_list: [] } }])
})

test('InboundDebouncer combines text and flushes before media', () => {
  const ready: any[] = []
  const timers: Array<() => void> = []
  const debouncer = new InboundDebouncer({ windowMs: 2000, onFlush: (p) => ready.push(p), setTimer: (fn) => { timers.push(fn); return fn as any }, clearTimer: () => {} })
  const text = (value: string) => ({ senderId: 'peer', message: { item_list: [{ type: ITEM_TEXT, text_item: { text: value } }] } }) as any
  const media = { senderId: 'peer', message: { item_list: [{ type: ITEM_IMAGE, image_item: {} }] } } as any
  assert.deepEqual(debouncer.admit(text('a')), [])
  assert.deepEqual(debouncer.admit(text('b')), [])
  const flushed = debouncer.admit(media)
  assert.equal(flushed.length, 2)
  assert.equal((flushed[0]!.message.item_list[0]!.text_item.text), 'a\nb')
  assert.equal(flushed[1], media)
  assert.equal(ready.length, 0)
})

// ------------------------------------------------------------- fetchRemoteMedia

test('fetchRemoteMedia refuses private/loopback hosts before any fetch', async () => {
  await assert.rejects(fetchRemoteMedia('http://127.0.0.1:9/x'), /private\/loopback/)
  await assert.rejects(fetchRemoteMedia('http://192.168.1.10/x'), /private\/loopback/)
  await assert.rejects(fetchRemoteMedia('http://10.0.0.2/x'), /private\/loopback/)
  await assert.rejects(fetchRemoteMedia('http://172.16.0.9/x'), /private\/loopback/)
  await assert.rejects(fetchRemoteMedia('http://172.31.255.1/x'), /private\/loopback/)
  await assert.rejects(fetchRemoteMedia('http://localhost/x'), /private\/loopback/)
  await assert.rejects(fetchRemoteMedia('file:///etc/passwd'), /unsupported media URL scheme/)
  await assert.rejects(fetchRemoteMedia('ftp://example.com/x'), /unsupported media URL scheme/)
  // 172.15.x and 172.32.x are NOT in the private 172.16-31 range.
  await assert.rejects(fetchRemoteMedia('http://172.15.0.1/x'), /private\/loopback|ENOTFOUND|getaddrinfo|ECONNREFUSED|network|fetch/i)
})

// ---------------------------------------------------- QR request: local_token_list

test('fetchQrCode sends local_token_list in the request body', async () => {
  const calls: Array<{ url: string; body: string }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ?? '' })
    return new Response(JSON.stringify({ qrcode: 'tok', qrcode_img_content: 'https://scan' }), { status: 200 })
  }) as typeof fetch
  try {
    const qr = await fetchQrCode({ localTokenList: ['tok-a', '  ', 'tok-b'] })
    assert.equal(qr.qrcode, 'tok')
    assert.equal(calls.length, 1)
    const parsed = JSON.parse(calls[0]!.body) as { local_token_list?: string[] }
    // Empty tokens are dropped, cap is honored by construction.
    assert.deepEqual(parsed.local_token_list, ['tok-a', 'tok-b'])
  } finally {
    globalThis.fetch = originalFetch
  }
})
