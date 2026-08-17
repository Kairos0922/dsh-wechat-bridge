/**
 * Node-level unit tests for the pure helpers and menu-retention behavior.
 * A real WechatBridgeNode is constructed with a fake ctx — no DSH services,
 * no network; state writes never happen on the paths exercised here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildWelcomeMessage, WechatBridgeNode } from '../src/node/core.ts'

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

test('isAllowed: configured allowFrom wins even without a paired id', async () => {
  const node = new WechatBridgeNode({} as never, CONFIG)
  assert.equal(await node.isAllowed('peer-a@im.wechat'), true)
  assert.equal(await node.isAllowed('stranger@im.wechat'), false)
  node.dispose()
})

test('isAllowed: the paired (QR-scanning) WeChat id is auto-allowlisted', async () => {
  const credentials = {
    resolve: async () => ({ value: 'owner-123@im.wechat' }),
  }
  const ctx = { logger: { warn() {} }, get: () => credentials }
  const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: [] } as never)
  assert.equal(await node.isAllowed('owner-123@im.wechat'), true)
  assert.equal(await node.isAllowed('stranger@im.wechat'), false)
  node.dispose()
})

test('isAllowed: every pairing-confirmed scanner is trusted (multi-user)', async () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-core-'))
  try {
    const ctx = { logger: { warn() {} }, get: () => undefined }
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: [] } as never)
    node.state.addPairedUserId('scanner-a@im.wechat')
    node.state.addPairedUserId('scanner-b@im.wechat')
    assert.equal(await node.isAllowed('scanner-a@im.wechat'), true)
    assert.equal(await node.isAllowed('scanner-b@im.wechat'), true)
    assert.equal(await node.isAllowed('stranger@im.wechat'), false)
    node.dispose()
  } finally {
    process.env.DSH_HOME = oldHome
  }
})

test('isAllowed: empty allowFrom and no pairing → nobody is allowed (safe default)', async () => {
  const ctx = { logger: { warn() {} }, get: () => undefined }
  const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: [] } as never)
  assert.equal(await node.isAllowed('anyone@im.wechat'), false)
  node.dispose()
})

test('buildWelcomeMessage: auto-allowlist mode states the trust source', () => {
  const msg = buildWelcomeMessage({ allowFromEmpty: true })
  assert.match(msg, /配对成功/)
  assert.match(msg, /扫码自动获得白名单/)
  assert.match(msg, /\/modes/)
})

test('buildWelcomeMessage: configured allowFrom mode', () => {
  const msg = buildWelcomeMessage({ allowFromEmpty: false })
  assert.match(msg, /白名单已按配置生效/)
})

test('createSession originBadge: host rejection degrades to plain session (never blocks)', async () => {
  const created: Array<Record<string, string | undefined>> = []
  const agents = {
    create: async (opts: { meta: Record<string, string> }) => {
      created.push({ ...opts.meta })
      if (opts.meta.origin === 'wechat') throw new Error('session header origin must be "subagent"')
      return { agent: { session: { id: `wechat-test-${created.length}` }, followup: () => {} }, dispose: async () => {} }
    },
  }
  const ctx = { logger: { warn() {} }, get: () => undefined, agents }
  const node = new WechatBridgeNode(ctx as never, { ...CONFIG, originBadge: true, allowFrom: [] } as never)
  await node.createSession('a@im.wechat', 'hello')
  assert.equal(created.length, 2, 'origin attempt + plain retry')
  assert.equal(created[0]?.origin, 'wechat')
  assert.equal(created[1]?.origin, undefined, 'retry without origin')
  // Once degraded, subsequent sessions skip origin entirely (no repeated failures)
  created.length = 0
  await node.createSession('a@im.wechat', 'again')
  assert.equal(created.length, 1)
  assert.equal(created[0]?.origin, undefined)
  node.dispose()
})

test('createSession originBadge off: never sends origin (zero host dependency)', async () => {
  const created: Array<Record<string, string | undefined>> = []
  const agents = {
    create: async (opts: { meta: Record<string, string> }) => {
      created.push({ ...opts.meta })
      return { agent: { session: { id: 'wechat-plain-1' }, followup: () => {} }, dispose: async () => {} }
    },
  }
  const ctx = { logger: { warn() {} }, get: () => undefined, agents }
  const node = new WechatBridgeNode(ctx as never, { ...CONFIG, originBadge: false, allowFrom: [] } as never)
  await node.createSession('a@im.wechat', 'hello')
  assert.equal(created.length, 1)
  assert.equal(created[0]?.origin, undefined)
  node.dispose()
})
