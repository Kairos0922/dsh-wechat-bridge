/**
 * Send-failure classification tests (protocol.md §5).
 *
 * ret=-2 carries two meanings distinguished by errmsg: "prepare failed" /
 * "unknown error" = stale context_token (recover by resending WITHOUT the
 * token); "rate limited" / "freq limit" (and any other -2 text) = frequency
 * limit (recover by backing off). -12 = rate limit, -14 = session expired.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertCdnUrl,
  classifyPollBatch,
  classifySendFailure,
  MEDIA_DOWNLOAD_MAX_BYTES,
  sanitizeBaseUrl,
} from '../src/gateway/types.ts'

test('classify: -14 is session-expired (either ret or errcode slot)', () => {
  assert.equal(classifySendFailure(-14, 0, 'whatever'), 'session-expired')
  assert.equal(classifySendFailure(0, -14, 'whatever'), 'session-expired')
})

test('classify: -12 is rate-limit (either slot)', () => {
  assert.equal(classifySendFailure(-12, 0, 'whatever'), 'rate-limit')
  assert.equal(classifySendFailure(0, -12, 'whatever'), 'rate-limit')
})

test('classify: -2 + "prepare failed" is stale-session (the 2026-08-18 incident)', () => {
  assert.equal(classifySendFailure(-2, undefined, 'prepare failed'), 'stale-session')
  // The errmsg may carry surrounding text from the server.
  assert.equal(classifySendFailure(-2, 0, 'sendmessage prepare failed ret=3'), 'stale-session')
})

test('classify: -2 + "unknown error" is stale-session (hermes classifier)', () => {
  assert.equal(classifySendFailure(-2, 0, 'unknown error'), 'stale-session')
  assert.equal(classifySendFailure(0, -2, 'unknown error'), 'stale-session')
})

test('classify: -2 + rate-limit texts is rate-limit', () => {
  assert.equal(classifySendFailure(-2, 0, 'rate limited'), 'rate-limit')
  assert.equal(classifySendFailure(-2, 0, 'freq limit'), 'rate-limit')
})

test('classify: -2 with any other errmsg is rate-limit (hermes default)', () => {
  assert.equal(classifySendFailure(-2, 0, 'some other text'), 'rate-limit')
  assert.equal(classifySendFailure(-2, undefined, undefined), 'rate-limit')
})

test('classify: errcode=-2 without ret uses the same semantics', () => {
  assert.equal(classifySendFailure(undefined, -2, 'prepare failed'), 'stale-session')
  assert.equal(classifySendFailure(undefined, -2, 'rate limited'), 'rate-limit')
})

test('classify: unknown/business codes are generic', () => {
  assert.equal(classifySendFailure(100, 0, 'upload slot rejected'), 'generic')
  assert.equal(classifySendFailure(undefined, undefined, undefined), 'generic')
  assert.equal(classifySendFailure(0, 0, ''), 'generic')
})

// ------------------------------------------------------------------ H1

test('sanitizeBaseUrl: valid redirect URL passes through (normalized)', () => {
  assert.equal(sanitizeBaseUrl('https://ilinkai.weixin.qq.com', 'fallback'), 'https://ilinkai.weixin.qq.com/')
  assert.equal(sanitizeBaseUrl('https://sub.weixin.qq.com', 'fallback'), 'https://sub.weixin.qq.com/')
})

test('sanitizeBaseUrl: bare hostname gets https:// prepended', () => {
  assert.equal(sanitizeBaseUrl('ilinkai.weixin.qq.com', 'fallback'), 'https://ilinkai.weixin.qq.com/')
  assert.equal(sanitizeBaseUrl('sub.weixin.qq.com', 'fallback'), 'https://sub.weixin.qq.com/')
})

test('sanitizeBaseUrl: malicious/foreign hosts fall back', () => {
  assert.equal(sanitizeBaseUrl('https://evil.com', 'fallback'), 'fallback')
  assert.equal(sanitizeBaseUrl('https://ilinkai.weixin.qq.com.evil.com', 'fallback'), 'fallback')
  assert.equal(sanitizeBaseUrl('https://evil-weixin.qq.com', 'fallback'), 'fallback')
  // exact host only — a subdomain of the trusted apex still passes
  assert.equal(sanitizeBaseUrl('https://deep.weixin.qq.com', 'fallback'), 'https://deep.weixin.qq.com/')
})

test('sanitizeBaseUrl: non-https protocols are rejected', () => {
  assert.equal(sanitizeBaseUrl('http://ilinkai.weixin.qq.com', 'fallback'), 'fallback')
  assert.equal(sanitizeBaseUrl('ftp://ilinkai.weixin.qq.com', 'fallback'), 'fallback')
})

test('sanitizeBaseUrl: hostname comparison is case-insensitive', () => {
  assert.equal(sanitizeBaseUrl('HTTPS://ILINKAI.WEIXIN.QQ.COM', 'fallback'), 'https://ilinkai.weixin.qq.com/')
  assert.equal(sanitizeBaseUrl('https://Deep.WeiXin.qq.com', 'fallback'), 'https://deep.weixin.qq.com/')
})

test('sanitizeBaseUrl: extraTrustedHosts exact hostname match wins', () => {
  const extra = ['ilinkai.example.com', 'proxy.internal']
  assert.equal(sanitizeBaseUrl('https://ilinkai.example.com', 'fallback', extra), 'https://ilinkai.example.com/')
  assert.equal(sanitizeBaseUrl('proxy.internal', 'fallback', extra), 'https://proxy.internal/')
  // suffix look-alikes of extra hosts are NOT trusted
  assert.equal(sanitizeBaseUrl('https://evil.example.com', 'fallback', extra), 'fallback')
})

test('sanitizeBaseUrl: undefined/null/empty/parse-garbage fall back', () => {
  assert.equal(sanitizeBaseUrl(undefined, 'fallback'), 'fallback')
  assert.equal(sanitizeBaseUrl(null, 'fallback'), 'fallback')
  assert.equal(sanitizeBaseUrl('', 'fallback'), 'fallback')
  assert.equal(sanitizeBaseUrl('   ', 'fallback'), 'fallback')
  assert.equal(sanitizeBaseUrl('not a url with spaces', 'fallback'), 'fallback')
  assert.equal(sanitizeBaseUrl('https://', 'fallback'), 'fallback')
})

// ------------------------------------------------------------------ M1

test('classifyPollBatch: bare { ret: -12 } (no errcode) is rate-limit, never ok', () => {
  assert.equal(classifyPollBatch({ ret: -12 }), 'rate-limit')
  assert.equal(classifyPollBatch({ ret: -12, errcode: 0 }), 'rate-limit')
  assert.equal(classifyPollBatch({ ret: 0, errcode: -12 }), 'rate-limit')
})

test('classifyPollBatch: -2 + "prepare failed" routes to the session-expired branch', () => {
  assert.equal(classifyPollBatch({ ret: -2, errmsg: 'prepare failed' }), 'session-expired')
  assert.equal(classifyPollBatch({ ret: -2, errcode: 0, errmsg: 'sendmessage prepare failed ret=3' }), 'session-expired')
})

test('classifyPollBatch: -14 and -2+"unknown error" are session-expired', () => {
  assert.equal(classifyPollBatch({ ret: -14 }), 'session-expired')
  assert.equal(classifyPollBatch({ ret: -2, errmsg: 'unknown error' }), 'session-expired')
  assert.equal(classifyPollBatch({ ret: -2, errcode: undefined, errmsg: 'UNKNOWN ERROR' }), 'session-expired')
})

test('classifyPollBatch: other negatives are generic-negative (5s retry)', () => {
  assert.equal(classifyPollBatch({ ret: -5 }), 'generic-negative')
  assert.equal(classifyPollBatch({ ret: -2, errmsg: 'rate limited' }), 'rate-limit')
  assert.equal(classifyPollBatch({ ret: -2, errcode: undefined, errmsg: undefined }), 'rate-limit')
})

test('classifyPollBatch: zero/undefined/positive is ok (success path)', () => {
  assert.equal(classifyPollBatch({ ret: 0 }), 'ok')
  assert.equal(classifyPollBatch({ ret: 0, errcode: 0, errmsg: '' }), 'ok')
  assert.equal(classifyPollBatch({ ret: 200, get_updates_buf: 'x' }), 'ok')
  assert.equal(classifyPollBatch({}), 'ok')
})

// ------------------------------------------------------------------ F4

test('assertCdnUrl: trusted CDN hosts pass', () => {
  assert.equal(
    assertCdnUrl('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc').hostname,
    'novac2c.cdn.weixin.qq.com',
  )
  assert.equal(assertCdnUrl('https://deep.cdn.weixin.qq.com/x').hostname, 'deep.cdn.weixin.qq.com')
})

test('assertCdnUrl: hostname check is case-insensitive', () => {
  assert.equal(assertCdnUrl('HTTPS://NOVAC2C.CDN.WEIXIN.QQ.COM/x').hostname, 'novac2c.cdn.weixin.qq.com')
})

test('assertCdnUrl: http and foreign hosts throw', () => {
  assert.throws(() => assertCdnUrl('http://novac2c.cdn.weixin.qq.com/x'))
  assert.throws(() => assertCdnUrl('https://evil.com/x'))
  // bare apex 'cdn.weixin.qq.com' does NOT match '*.cdn.weixin.qq.com'
  assert.throws(() => assertCdnUrl('https://cdn.weixin.qq.com/x'))
  assert.throws(() => assertCdnUrl('https://novac2c.cdn.weixin.qq.com.evil.com/x'))
  assert.throws(() => assertCdnUrl('not a url'))
})

test('assertCdnUrl: extraTrustedHosts exact match wins', () => {
  assert.equal(assertCdnUrl('https://mycdn.example.com/x', ['mycdn.example.com']).hostname, 'mycdn.example.com')
  assert.throws(() => assertCdnUrl('https://mycdn.example.com/x', ['other.example.com']))
})

test('MEDIA_DOWNLOAD_MAX_BYTES is 20 MiB', () => {
  assert.equal(MEDIA_DOWNLOAD_MAX_BYTES, 20 * 1024 * 1024)
})
