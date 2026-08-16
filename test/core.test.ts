/**
 * Node-level unit tests for the pure helpers and menu-retention behavior.
 * A real WechatBridgeNode is constructed with a fake ctx — no DSH services,
 * no network; state writes never happen on the paths exercised here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { WechatBridgeNode } from '../src/node/core.ts'

const CONFIG = {
  allowFrom: ['peer-a@im.wechat'],
  approvalTimeoutSec: 600,
  maxMessageChars: 2000,
  minSendIntervalMs: 5000,
  rateLimitBackoffSecs: [10, 30, 60],
  sessionExpiredPauseMin: 60,
  thinkingDigestSec: 10,
  menuTimeoutSec: 60,
  markdownMode: 'passthrough',
  progressToolPrefixes: ['bash', 'fs'],
} as never

function fakeNode() {
  const node = new WechatBridgeNode({} as never, CONFIG)
  return node
}

test('an out-of-range menu number keeps the menu open', () => {
  const node = fakeNode()
  node.registerMenu('peer-a', 'mode', [{ label: '财务助理', value: 'life-finance' }])
  assert.ok(node.hasMenu('peer-a'))
  assert.equal(node.tryResolveMenu('peer-a', '99'), true) // consumed, but menu retained
  assert.ok(node.hasMenu('peer-a'), 'menu must survive an invalid choice')
  node.dispose()
})

test('a valid menu number consumes the menu', () => {
  const node = fakeNode()
  // 'mode' is the safe choice kind for tests: createSession fails against the
  // fake ctx inside its own try/catch and never touches persistent state.
  node.registerMenu('peer-a', 'mode', [{ label: '财务助理', value: 'life-finance' }])
  assert.equal(node.tryResolveMenu('peer-a', '1'), true)
  assert.ok(!node.hasMenu('peer-a'))
  node.dispose()
})

test('zero cancels the menu', () => {
  const node = fakeNode()
  node.registerMenu('peer-a', 'provider', [{ label: 'deepseek', value: 'deepseek' }])
  assert.equal(node.tryResolveMenu('peer-a', '0'), true)
  assert.ok(!node.hasMenu('peer-a'))
  node.dispose()
})

test('dispose clears menus and pending outbox entries without throwing', () => {
  const node = fakeNode()
  node.registerMenu('peer-a', 'mode', [{ label: 'x', value: 'x' }])
  node.enqueueText('peer-a', 'hello')
  node.dispose()
  assert.equal(node.outbox.pendingCount(), 0)
})
