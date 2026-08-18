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

import { classifySendFailure } from '../src/gateway/types.ts'

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
