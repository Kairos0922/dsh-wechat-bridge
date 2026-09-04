/**
 * Host-API unit tests: the browser-trust fence (isTrustedRequest) as a table
 * of browser scenarios, plus route-level behavior for the pairing-management
 * endpoints (revoke body validation, confirm routing, POST-only, 403 fence).
 * No network — fake req/res objects against a captured route table.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { isTrustedRequest, registerHostApi } from '../src/host-api.ts'

function fakeReq(headers: Record<string, string>, method = 'POST', body?: string): never {
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>
    method: string
    destroy(): void
  }
  req.headers = headers
  req.method = method
  req.destroy = () => {}
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  } else {
    queueMicrotask(() => req.emit('end'))
  }
  return req as never
}

function fakeRes(): { res: never; result: () => { code: number; body: unknown } } {
  const out: { code: number; body: unknown } = { code: 0, body: null }
  const res = {
    writeHead(code: number) {
      out.code = code
      return this
    },
    end(text: string) {
      out.body = JSON.parse(text)
    },
  }
  return { res: res as never, result: () => out }
}

// ------------------------------------------------------------- fence (table)

const TRUSTED = ['harness.internal', 'nas.home.lan:3080']

const fenceCases: Array<[string, Record<string, string>, boolean]> = [
  ['loopback http fetch', { host: '127.0.0.1:3080' }, true],
  ['localhost', { host: 'localhost:3080' }, true],
  ['ipv6 loopback', { host: '[::1]:3080' }, true],
  ['127/8 edge', { host: '127.100.200.3:3080' }, true],
  ['trusted host name', { host: 'harness.internal' }, true],
  ['trusted host with any port', { host: 'harness.internal:9999' }, true],
  ['trusted host:port exact', { host: 'nas.home.lan:3080' }, true],
  ['trusted host:port wrong port', { host: 'nas.home.lan:9999' }, false],
  ['attacker domain (DNS rebinding)', { host: 'evil.example.com' }, false],
  ['missing Host header', {}, false],
  ['cross-site marker refused', { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, false],
  ['same-site marker fine', { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, true],
  ['same-origin Origin fine', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, true],
  ['mismatched Origin refused', { host: '127.0.0.1:3080', origin: 'http://evil.example.com' }, false],
  ['garbage Origin refused', { host: '127.0.0.1:3080', origin: 'not a url' }, false],
  ['Origin port mismatch refused', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' }, false],
]

for (const [name, headers, expected] of fenceCases) {
  test(`isTrustedRequest: ${name}`, () => {
    assert.equal(isTrustedRequest(fakeReq(headers, 'GET'), TRUSTED), expected)
  })
}

// ------------------------------------------------------------ route helpers

interface FakeNode {
  resolved: { allowFrom: string[]; defaultMode?: string; markdownMode: string }
  state: { getPrefs(): Record<string, never> }
  outbox: { pendingCount(): number }
  outboxPausedUntil(): number | null
  getPairedUserId(): Promise<string | null>
  listPairedUserIds(): string[]
  pendingTrustUserId: string | null
  confirmPendingTrust(): Promise<boolean>
  rejectPendingTrust(): boolean
  revokePairedUser(userId: string): Promise<boolean>
  isPaused(): boolean
  setPaused(paused: boolean): void
  isSessionWechatEnabled(sessionId: string): boolean
  ctx: { sessions: { list(): Array<{ id: string; header: { createdAt: number }; events: Array<{ time?: number }>; seq?: number }> }; agents: { get(): { status?: string } | undefined } }
}

function mount(opts: {
  gateway?: Partial<{ pendingPair: { userId: string; accountId: string } | null; confirmPairing(): Promise<boolean>; rejectPairing(): boolean; status: string; pairingMessage: string; resolveCredentials(): Promise<null>; startPairing(): Promise<{ svg: string; scanData: string }> }>
  node?: Partial<FakeNode>
} = {}) {
  const routes = new Map<string, (req: never, res: never) => void | Promise<void>>()
  const ctx = {
    webServer: {
      register: ({ path, handler }: { path: string; handler: never }) => routes.set(path, handler),
    },
    logger: { warn() {}, info() {} },
  }
  const gateway = {
    status: 'authenticated',
    pairingMessage: '',
    pendingPair: null,
    needVerifyCode: false,
    resolveCredentials: async () => null,
    startPairing: async () => ({ svg: '<svg/>', scanData: 'x' }),
    confirmPairing: async () => false,
    rejectPairing: () => false,
    submitVerifyCode: () => false,
    healthSnapshot: () => ({ status: 'polling', reason: 'healthy', issues: [], pollFailures: 0, lastInboundAt: null, lastOutboundAt: null, uptimeMs: 0 }),
    ...opts.gateway,
  }
  const node: FakeNode = {
    resolved: { allowFrom: [], markdownMode: 'passthrough' },
    state: { getPrefs: () => ({}) },
    outbox: { pendingCount: () => 0 },
    outboxPausedUntil: () => null,
    getPairedUserId: async () => null,
    listPairedUserIds: () => [],
    pendingTrustUserId: null,
    confirmPendingTrust: async () => false,
    rejectPendingTrust: () => false,
    revokePairedUser: async () => false,
    isPaused: () => false,
    setPaused: () => {},
    isSessionWechatEnabled: () => false,
    ctx: {
      sessions: {
        list: () => [{ id: 'wechat-1', header: { createdAt: 100 }, events: [{ time: 500 }], seq: 0 }],
      },
      agents: { get: () => ({ status: 'running' }) },
    },
    ...opts.node,
  }
  registerHostApi(ctx as never, gateway as never, node as never, { trustedHosts: TRUSTED })
  return routes
}

test('every endpoint 403s an untrusted Host before doing any work', async () => {
  let confirmCalled = false
  const routes = mount({ gateway: { confirmPairing: async () => ((confirmCalled = true), true) } })
  for (const path of ['/api/dsh-wechat-bridge/status', '/api/dsh-wechat-bridge/pair', '/api/dsh-wechat-bridge/pair/confirm', '/api/dsh-wechat-bridge/pair/reject', '/api/dsh-wechat-bridge/pair/revoke']) {
    const { res, result } = fakeRes()
    await routes.get(path)!(fakeReq({ host: 'evil.example.com' }, 'POST'), res)
    assert.equal(result().code, 403, path)
    assert.deepEqual(result().body, { ok: false, error: 'forbidden' })
  }
  assert.equal(confirmCalled, false, 'no side effect behind the fence')
})

test('pair/confirm prefers a held gateway pair over a held trust admission', async () => {
  let gatewayConfirmed = false
  let trustConfirmed = false
  const routes = mount({
    gateway: { pendingPair: { userId: 'u', accountId: 'bot2' }, confirmPairing: async () => ((gatewayConfirmed = true), true) },
    node: { pendingTrustUserId: 'u2', confirmPendingTrust: async () => ((trustConfirmed = true), true) },
  })
  const { res, result } = fakeRes()
  await routes.get('/api/dsh-wechat-bridge/pair/confirm')!(fakeReq({ host: '127.0.0.1:3080' }), res)
  assert.deepEqual(result().body, { ok: true, confirmed: true })
  assert.equal(gatewayConfirmed, true)
  assert.equal(trustConfirmed, false, 'gateway pendingPair outranks')
})

test('pair/confirm falls through to trust admission', async () => {
  const routes = mount({ node: { pendingTrustUserId: 'newbie@im.wechat', confirmPendingTrust: async () => true } })
  const { res, result } = fakeRes()
  await routes.get('/api/dsh-wechat-bridge/pair/confirm')!(fakeReq({ host: '127.0.0.1:3080' }), res)
  assert.deepEqual(result().body, { ok: true, confirmed: true })
})

test('pair/confirm with nothing pending answers confirmed:false', async () => {
  const routes = mount()
  const { res, result } = fakeRes()
  await routes.get('/api/dsh-wechat-bridge/pair/confirm')!(fakeReq({ host: '127.0.0.1:3080' }), res)
  assert.deepEqual(result().body, { ok: true, confirmed: false })
})

test('pair/revoke requires a userId and forwards it', async () => {
  const revoked: string[] = []
  const routes = mount({ node: { revokePairedUser: async (id: string) => (revoked.push(id), true) } })
  const bad = fakeRes()
  await routes.get('/api/dsh-wechat-bridge/pair/revoke')!(fakeReq({ host: '127.0.0.1:3080' }, 'POST', '{}'), bad.res)
  assert.equal(bad.result().code, 400)
  const good = fakeRes()
  await routes.get('/api/dsh-wechat-bridge/pair/revoke')!(fakeReq({ host: '127.0.0.1:3080' }, 'POST', '{"userId":"user-b@im.wechat"}'), good.res)
  assert.deepEqual(good.result().body, { ok: true, revoked: true })
  assert.deepEqual(revoked, ['user-b@im.wechat'])
})

test('management endpoints are POST-only', async () => {
  const routes = mount()
  const { res, result } = fakeRes()
  await routes.get('/api/dsh-wechat-bridge/pair/revoke')!(fakeReq({ host: '127.0.0.1:3080' }, 'GET'), res)
  assert.equal(result().code, 405)
})

test('status answers 200 with the new pending fields', async () => {
  const routes = mount({
    gateway: { pendingPair: { userId: 'u1', accountId: 'bot-2' } },
    node: { pendingTrustUserId: 'u2', listPairedUserIds: () => ['a@im.wechat'] },
  })
  const { res, result } = fakeRes()
  await routes.get('/api/dsh-wechat-bridge/status')!(fakeReq({ host: '127.0.0.1:3080' }, 'GET'), res)
  const body = result().body as { ok: boolean; pendingPair: unknown; pendingTrustUserId: string | null; pairedUserIds: string[] }
  assert.equal(body.ok, true)
  assert.deepEqual(body.pendingPair, { userId: 'u1', accountId: 'bot-2' })
  assert.equal(body.pendingTrustUserId, 'u2')
  assert.deepEqual(body.pairedUserIds, ['a@im.wechat'])
})

// Session contract (H2): /status and /sessions must emit the SAME shape the
// client's `Status.sessions` models ({id,label,status,lastActivityAt,enabled}).
// A drift renders an empty/broken session list. Here we pin the contract.
test('status carries the sessions contract (label/status/lastActivityAt/enabled)', async () => {
  const routes = mount({
    node: {
      isSessionWechatEnabled: (id: string) => id === 'wechat-1',
      ctx: {
        sessions: { list: () => [{ id: 'wechat-1', header: { createdAt: 100 }, events: [{ time: 500 }], seq: 0 }] },
        agents: { get: () => ({ status: 'running' }) },
      },
    },
  })
  const { res, result } = fakeRes()
  await routes.get('/api/dsh-wechat-bridge/status')!(fakeReq({ host: '127.0.0.1:3080' }, 'GET'), res)
  const body = result().body as { ok: boolean; sessions: Array<{ id: string; label: string; status: string; lastActivityAt: number; enabled: boolean }> }
  assert.equal(body.ok, true)
  assert.equal(body.sessions.length, 1)
  assert.deepEqual(body.sessions[0], { id: 'wechat-1', label: '(空会话)', status: '运行中', lastActivityAt: 500, enabled: true })
})

test('sessions endpoint emits the same contract shape', async () => {
  const routes = mount()
  const { res, result } = fakeRes()
  await routes.get('/api/dsh-wechat-bridge/sessions')!(fakeReq({ host: '127.0.0.1:3080' }, 'GET'), res)
  const body = result().body as { ok: boolean; sessions: Array<{ id: string; label: string; status: string; lastActivityAt: number; enabled: boolean }> }
  assert.equal(body.ok, true)
  assert.equal(body.sessions[0].id, 'wechat-1')
  for (const key of ['id', 'label', 'status', 'lastActivityAt', 'enabled'] as const) {
    assert.ok(key in body.sessions[0]!, `session contract field missing: ${key}`)
  }
})
