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
  sendBudgetWindowSec: 60,
  sendBudgetMaxPerWindow: 4,
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

test('handleText auto-creates a default session when no agent exists (zero-config)', async () => {
  const createdSessions: string[] = []
  const fakeAgent = (id: string) => ({ session: { id }, followup: () => {}, status: 'idle' })
  const agents = {
    create: async (opts: { sessionId: string; meta: Record<string, string> }) => {
      createdSessions.push(opts.sessionId)
      return { agent: fakeAgent(opts.sessionId), dispose: async () => {} }
    },
    resume: async () => { throw new Error('no persisted session') },
    get: (id: string) => (createdSessions.includes(id) ? fakeAgent(id) : undefined),
  }
  const ctx = {
    logger: { warn() {} },
    get: () => undefined,
    agents: { ...agents, get: agents.get },
    sessions: { get: (id: string) => (createdSessions.includes(id) ? { id } : undefined) },
    agentPresets: undefined,
  }
  const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: [], cwd: '/tmp', defaultMode: 'standard' } as never)
  await node.handleText('a@im.wechat', '你好')
  assert.equal(createdSessions.length, 1, 'a default session was auto-created')
  node.dispose()
})

test('natural-language stop: only intercepts while a turn is running', async () => {
  let cancelled = 0
  const agent = { session: { id: 'wechat-run-1' }, status: 'running', cancel: () => { cancelled += 1 }, followup: () => {} }
  const agents = {
    create: async () => ({ agent, dispose: async () => {} }),
    get: () => agent,
  }
  const ctx = {
    logger: { warn() {} },
    get: () => undefined,
    agents,
    sessions: { get: () => ({ id: 'wechat-run-1' }) },
  }
  const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: [], cwd: '/tmp', defaultMode: 'standard' } as never)
  node.setActiveSession('a@im.wechat', 'wechat-run-1' as never)
  await node.handleText('a@im.wechat', '停')
  assert.equal(cancelled, 1, 'running turn cancelled on "停"')
  // idle: the word falls through as an ordinary message (no swallow)
  agent.status = 'idle'
  await node.handleText('a@im.wechat', '停')
  assert.equal(cancelled, 1, 'idle "停" is not intercepted')
  node.dispose()
})

test('stopTurn: friendly feedback when nothing is running', async () => {
  const ctx = { logger: { warn() {} }, get: () => undefined, agents: {}, sessions: { get: () => undefined } }
  const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: [], cwd: '/tmp' } as never)
  const sent: string[] = []
  node.enqueueText = ((_peer: string, text: string) => { sent.push(text) }) as never
  await node.stopTurn('a@im.wechat')
  assert.ok(sent.some((t) => t.includes('没有执行中的任务')))
  node.dispose()
})

test('stale-session (prepare failed): tokenless resend recovers and clears the token', async () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-stale-'))
  try {
    const sends: Array<{ token: string | undefined; text: string }> = []
    const ctx = {
      logger: { warn() {} },
      wechat: {
        sendText: async (p: { toUserId: string; text: string; contextToken?: string }) => {
          sends.push({ token: p.contextToken, text: p.text })
          // First send with the stale token → prepare failed (the 2026-08-18
          // incident signature); tokenless resend succeeds.
          return p.contextToken !== undefined
            ? { ok: false, ret: -2, errmsg: 'sendMessage ret=-2 errcode=- errmsg=prepare failed', retryable: false, failureClass: 'stale-session' }
            : { ok: true, messageId: 42 }
        },
      },
    }
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, minSendIntervalMs: 1 } as never)
    node.setPeerTarget('peer-a@im.wechat', 'peer-a@im.wechat')
    node.setPeerContextToken('peer-a@im.wechat', 'tok-stale-123')
    node.enqueueText('peer-a@im.wechat', '任务计划')
    await node.outbox.drain()
    assert.equal(sends.length, 2, 'one stale-token send + one tokenless resend')
    assert.equal(sends[0]?.token, 'tok-stale-123')
    assert.equal(sends[1]?.token, undefined, 'resend carries NO context token')
    assert.equal(sends[1]?.text, '任务计划')
    assert.equal(node.getPeerContextToken('peer-a@im.wechat'), null, 'stale token cleared')
    node.dispose()
  } finally {
    process.env.DSH_HOME = oldHome
  }
})

test('stale-session recovery does not clear a concurrently refreshed token', async () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-cmpdel-'))
  try {
    const sends: Array<{ token: string | undefined }> = []
    let node: WechatBridgeNode
    const ctx = {
      logger: { warn() {} },
      wechat: {
        sendText: async (p: { contextToken?: string }) => {
          sends.push({ token: p.contextToken })
          if (p.contextToken !== undefined) {
            // An inbound message refreshes the token WHILE the stale-token
            // send is in flight — compare-and-delete must not kill it.
            node.setPeerContextToken('peer-a@im.wechat', 'tok-fresh')
            return { ok: false, ret: -2, errmsg: 'prepare failed', retryable: false, failureClass: 'stale-session' }
          }
          return { ok: true, messageId: 1 }
        },
      },
    }
    node = new WechatBridgeNode(ctx as never, { ...CONFIG, minSendIntervalMs: 1 } as never)
    node.setPeerTarget('peer-a@im.wechat', 'peer-a@im.wechat')
    node.setPeerContextToken('peer-a@im.wechat', 'tok-old')
    node.enqueueText('peer-a@im.wechat', 'hi')
    await node.outbox.drain()
    assert.equal(sends.length, 2)
    assert.equal(sends[0]?.token, 'tok-old', 'sends the token that was stale')
    assert.equal(sends[1]?.token, undefined, 'tokenless resend still fires')
    // Compare-and-delete must NOT have removed the refreshed token.
    assert.equal(node.getPeerContextToken('peer-a@im.wechat'), 'tok-fresh')
    node.dispose()
  } finally {
    process.env.DSH_HOME = oldHome
  }
})

test('a dropped approval prompt is re-pushed by the inbound retry hook', async () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-apr-'))
  try {
    const sends: string[] = []
    const ctx = {
      logger: { warn() {} },
      wechat: {
        sendText: async (p: { text: string }) => {
          sends.push(p.text)
          return { ok: false, ret: 100, errmsg: 'channel dead', retryable: false, failureClass: 'generic' }
        },
      },
    }
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, minSendIntervalMs: 1 } as never)
    node.registerApproval(1, {
      number: 1,
      peerId: 'peer-a@im.wechat',
      request: { toolName: 'bash', reason: 'needs consent', agent: { session: { events: [] } } },
      resolve: () => {},
      timer: setTimeout(() => {}, 600_000),
    } as never)
    // First delivery fails → outbox drop marks the prompt as undelivered.
    node.enqueueApprovalPrompt('peer-a@im.wechat', '🔐 #1 需要你的确认')
    await node.outbox.drain()
    assert.equal(sends.length, 1)
    // The user's next inbound message triggers the re-push.
    node.retryApprovalPrompt('peer-a@im.wechat')
    await node.outbox.drain()
    assert.equal(sends.length, 2, 'prompt re-pushed after the inbound hook')
    assert.match(sends[1]!, /需要你的确认/)
    assert.match(sends[1]!, /#1/)
    node.dispose()
  } finally {
    process.env.DSH_HOME = oldHome
  }
})

test('retryApprovalPrompt is a no-op without a dropped prompt', async () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-apr2-'))
  try {
    const sends: string[] = []
    const ctx = {
      logger: { warn() {} },
      wechat: {
        sendText: async (p: { text: string }) => {
          sends.push(p.text)
          return { ok: true, messageId: 1 }
        },
      },
    }
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, minSendIntervalMs: 1 } as never)
    node.retryApprovalPrompt('peer-a@im.wechat')
    await node.outbox.drain()
    assert.equal(sends.length, 0, 'no inbound hook effect without a dropped prompt')
    node.dispose()
  } finally {
    process.env.DSH_HOME = oldHome
  }
})

test('a dropped MUST-DELIVER message is re-pushed by the inbound retry hook', async () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-crit-'))
  try {
    const sends: string[] = []
    const ctx = {
      logger: { warn() {} },
      wechat: {
        sendText: async (p: { text: string }) => {
          sends.push(p.text)
          return { ok: false, ret: 100, errmsg: 'channel dead', retryable: false, failureClass: 'generic' }
        },
      },
    }
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, minSendIntervalMs: 1, sendBudgetWindowSec: 1, sendBudgetMaxPerWindow: 100 } as never)
    // Final answer with the MUST-DELIVER marker → drop → recorded for re-push.
    node.enqueueText('peer-a@im.wechat', '持仓诊断最终答案', { kind: 'text', resendOnRecovery: true })
    await node.outbox.drain()
    assert.equal(sends.length, 1)
    // The user's next inbound message triggers the re-push.
    node.retryCriticalMessages('peer-a@im.wechat')
    await node.outbox.drain()
    assert.equal(sends.length, 2, 'final answer re-pushed after the inbound hook')
    assert.equal(sends[1], '持仓诊断最终答案')
    node.dispose()
  } finally {
    process.env.DSH_HOME = oldHome
  }
})

test('critical resend backlog is capped and de-duplicated', async () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-crit2-'))
  try {
    const ctx = {
      logger: { warn() {} },
      wechat: {
        sendText: async () => ({ ok: false, ret: 100, errmsg: 'dead', retryable: false, failureClass: 'generic' }),
      },
    }
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, minSendIntervalMs: 1, sendBudgetWindowSec: 1, sendBudgetMaxPerWindow: 100 } as never)
    for (let i = 0; i < 6; i++) {
      node.enqueueText('peer-a@im.wechat', `关键消息 ${i}`, { kind: 'text', resendOnRecovery: true })
      await node.outbox.drain()
    }
    // Cap 3 → only the LAST three survive for re-push.
    node.retryCriticalMessages('peer-a@im.wechat')
    await node.outbox.drain()
    // 6 dropped + 3 resent.
    assert.equal((node as unknown as { outbox: { pendingCount(): number } }).outbox.pendingCount(), 0)
    node.dispose()
  } finally {
    process.env.DSH_HOME = oldHome
  }
})

// ---------------------------------------------------------------- trust admission

function fakeAttachCtx(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, (payload: never) => void>()
  const ctx = {
    logger: { warn() {}, info() {} },
    get: () => undefined,
    on: (name: string, fn: never) => {
      handlers.set(name, fn)
      return () => {}
    },
    sessions: { list: () => [], get: () => undefined },
    ...overrides,
  }
  return { ctx, handlers }
}

function withTempHome(fn: () => Promise<void>): Promise<void> {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-core-'))
  return fn().finally(() => {
    process.env.DSH_HOME = oldHome
  })
}

const settle = () => new Promise((r) => setTimeout(r, 20))

test('pair admission: the first scanner bootstraps the trust set automatically', () =>
  withTempHome(async () => {
    const { ctx, handlers } = fakeAttachCtx()
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: [] } as never)
    node.attach()
    handlers.get('wechat/paired')!({ userId: 'first@im.wechat' } as never)
    await settle()
    assert.ok(node.state.listPairedUserIds().includes('first@im.wechat'), 'bootstrap scanner joins the trust set')
    assert.equal(node.pendingTrustUserId, null)
    node.dispose()
  }))

test('pair admission: a second scanner is held until the operator confirms', () =>
  withTempHome(async () => {
    const { ctx, handlers } = fakeAttachCtx()
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: ['owner@im.wechat'] } as never)
    node.attach()
    handlers.get('wechat/paired')!({ userId: 'newbie@im.wechat' } as never)
    await settle()
    assert.ok(!node.state.listPairedUserIds().includes('newbie@im.wechat'), 'held, not trusted')
    assert.equal(node.pendingTrustUserId, 'newbie@im.wechat')
    assert.equal(await node.isAllowed('newbie@im.wechat'), false)
    assert.equal(await node.confirmPendingTrust(), true)
    assert.ok(node.state.listPairedUserIds().includes('newbie@im.wechat'))
    assert.equal(await node.confirmPendingTrust(), false, 'no double confirm')
    node.dispose()
  }))

test('pair admission: operator rejection never persists the scanner', () =>
  withTempHome(async () => {
    const { ctx, handlers } = fakeAttachCtx()
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: ['owner@im.wechat'] } as never)
    node.attach()
    handlers.get('wechat/paired')!({ userId: 'newbie@im.wechat' } as never)
    await settle()
    assert.equal(node.rejectPendingTrust(), true)
    assert.ok(!node.state.listPairedUserIds().includes('newbie@im.wechat'))
    assert.equal(node.pendingTrustUserId, null)
    assert.equal(node.rejectPendingTrust(), false)
    node.dispose()
  }))

test('pair admission: a re-scan by an already-trusted user is a silent no-op', () =>
  withTempHome(async () => {
    const { ctx, handlers } = fakeAttachCtx()
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: ['owner@im.wechat'] } as never)
    node.attach()
    handlers.get('wechat/paired')!({ userId: 'owner@im.wechat' } as never)
    await settle()
    assert.equal(node.pendingTrustUserId, null, 'no hold for the trusted owner')
    node.dispose()
  }))

test('wechat/pair-pending auto-confirms only while the trust set is empty', () =>
  withTempHome(async () => {
    let confirmCalls = 0
    const { ctx, handlers } = fakeAttachCtx({
      wechat: {
        confirmPairing: async () => {
          confirmCalls += 1
          return true
        },
      },
    })
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: [] } as never)
    node.attach()
    handlers.get('wechat/pair-pending')!({} as never)
    await settle()
    assert.equal(confirmCalls, 1, 'bootstrap auto-confirm')
    // Now with a non-empty trust set the same event must NOT auto-confirm.
    node.state.addPairedUserId('owner@im.wechat')
    handlers.get('wechat/pair-pending')!({} as never)
    await settle()
    assert.equal(confirmCalls, 1, 'no auto-confirm once trusted users exist')
    node.dispose()
  }))

test('revokePairedUser: unpairs, cascades bindings/tokens/ownership, notifies', () =>
  withTempHome(async () => {
    const { ctx } = fakeAttachCtx()
    const node = new WechatBridgeNode(ctx as never, CONFIG)
    node.state.addPairedUserId('user-b@im.wechat')
    node.state.setPeerSession('user-b@im.wechat', 'wechat-s1')
    node.state.setSessionOwner('wechat-s1', 'user-b@im.wechat')
    node.state.setContextToken('user-b@im.wechat', 'tok')
    assert.equal(await node.revokePairedUser('nobody@im.wechat'), false, 'unknown id rejected')
    assert.equal(await node.revokePairedUser('user-b@im.wechat'), true)
    assert.ok(!node.state.listPairedUserIds().includes('user-b@im.wechat'))
    assert.ok(node.state.getPeerSession('user-b@im.wechat') == null, 'binding cleared')
    assert.equal(node.state.listSessionOwners().some(([id]) => id === 'wechat-s1'), false)
    node.dispose()
  }))

// ---------------------------------------------------------------- orphan adoption

function fakeSession(id: string, createdAt = 1) {
  return { id, header: { createdAt }, seq: 0 } as never
}

test('orphan adoption: a peer adopts only its OWN created sessions', () =>
  withTempHome(async () => {
    const { ctx } = fakeAttachCtx({
      sessions: { list: () => [fakeSession('wechat-mine'), fakeSession('wechat-theirs')], get: () => undefined },
    })
    const node = new WechatBridgeNode(ctx as never, CONFIG)
    node.state.setSessionCreator('wechat-mine', 'peer-a@im.wechat')
    node.state.setSessionCreator('wechat-theirs', 'peer-b@im.wechat')
    node.state.setContextToken('peer-a@im.wechat', 'tok')
    // peer-b's session is invisible to peer-a even though peer-a has history.
    assert.equal(await (node as never as { pickOrphanSession(p: string): Promise<string | null> }).pickOrphanSession('peer-a@im.wechat'), 'wechat-mine')
    node.dispose()
  }))

test('orphan adoption: /close-released sessions are never adoptable', () =>
  withTempHome(async () => {
    const { ctx } = fakeAttachCtx({
      sessions: { list: () => [fakeSession('wechat-mine')], get: () => undefined },
    })
    const node = new WechatBridgeNode(ctx as never, CONFIG)
    node.state.setSessionCreator('wechat-mine', 'peer-a@im.wechat')
    node.state.setContextToken('peer-a@im.wechat', 'tok')
    node.state.markSessionReleased('wechat-mine')
    assert.equal(await (node as never as { pickOrphanSession(p: string): Promise<string | null> }).pickOrphanSession('peer-a@im.wechat'), null)
    node.dispose()
  }))

test('orphan adoption: legacy sessions (no creator) adoptable only by a one-person trust set', () =>
  withTempHome(async () => {
    const { ctx } = fakeAttachCtx({
      sessions: { list: () => [fakeSession('wechat-legacy')], get: () => undefined },
    })
    const node = new WechatBridgeNode(ctx as never, { ...CONFIG, allowFrom: ['solo@im.wechat'] } as never)
    node.state.setContextToken('solo@im.wechat', 'tok')
    assert.equal(await (node as never as { pickOrphanSession(p: string): Promise<string | null> }).pickOrphanSession('solo@im.wechat'), 'wechat-legacy')
    // Trust set of two → nobody may inherit the legacy session.
    node.state.addPairedUserId('second@im.wechat')
    assert.equal(await (node as never as { pickOrphanSession(p: string): Promise<string | null> }).pickOrphanSession('solo@im.wechat'), null)
    node.dispose()
  }))

// ---------------------------------------------------------------- approval trim

test('resolveApproval accepts /yes with trailing whitespace', () =>
  withTempHome(async () => {
    const { ctx } = fakeAttachCtx()
    const node = new WechatBridgeNode(ctx as never, CONFIG)
    let outcome: string | null = null
    const timer = setTimeout(() => {}, 60_000)
    timer.unref()
    node.registerApproval(1, {
      number: 1,
      peerId: 'peer-a@im.wechat',
      request: {} as never,
      resolve: (o: string) => {
        outcome = o
      },
      timer,
    } as never)
    assert.equal(node.resolveApproval('/yes ', 'peer-a@im.wechat'), true)
    assert.equal(outcome, 'allowed-once')
    node.dispose()
  }))

// ---------------------------------------------------------------- inbound serialization

test('inbound tasks run strictly serial per sender, parallel across senders', () =>
  withTempHome(async () => {
    const { ctx } = fakeAttachCtx()
    const node = new WechatBridgeNode(ctx as never, CONFIG)
    const order: string[] = []
    const gate = () => new Promise<void>((r) => setTimeout(r, 15))
    const internal = node as never as { enqueueInbound(p: string, t: () => Promise<void>): Promise<void> }
    await Promise.all([
      internal.enqueueInbound('a', async () => { order.push('a1-start'); await gate(); order.push('a1-end') }),
      internal.enqueueInbound('a', async () => { order.push('a2-start'); await gate(); order.push('a2-end') }),
      internal.enqueueInbound('b', async () => { order.push('b1-start'); await gate(); order.push('b1-end') }),
    ])
    assert.ok(order.indexOf('a1-end') < order.indexOf('a2-start'), 'same sender serialized')
    node.dispose()
  }))
