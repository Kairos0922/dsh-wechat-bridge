/**
 * BridgeState unit tests — fixture files, injectable debounce, no live DSH.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { BridgeState, sanitizeState } from '../src/node/state.ts'

function fixtureFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-state-'))
  return path.join(dir, 'state.json')
}

test('sanitizeState accepts a well-formed record', () => {
  const data = sanitizeState({
    peerPrefs: { 'a@im.wechat': { provider: 'deepseek', model: 'deepseek-chat' } },
    peerSessions: { 'a@im.wechat': 'wechat-1' },
    sessionOwners: { 'wechat-1': 'a@im.wechat' },
  })
  assert.equal(data.peerPrefs['a@im.wechat'].provider, 'deepseek')
  assert.equal(data.peerPrefs['a@im.wechat'].model, 'deepseek-chat')
  assert.equal(data.peerSessions['a@im.wechat'], 'wechat-1')
  assert.equal(data.sessionOwners['wechat-1'], 'a@im.wechat')
})

test('sanitizeState drops malformed fields and never throws', () => {
  const data = sanitizeState({ peerPrefs: { a: { provider: 42 } }, peerSessions: { a: 1 }, sessionOwners: 'junk' })
  assert.deepEqual(data.peerPrefs, {})
  assert.deepEqual(data.peerSessions, {})
  assert.deepEqual(data.sessionOwners, {})
  assert.deepEqual(sanitizeState(null), {
    version: 1,
    peerPrefs: {},
    pairedUserIds: [],
    peerSessions: {},
    sessionOwners: {},
    sessionCreators: {},
    releasedSessions: [],
    contextTokens: {},
  })
})

test('peer bindings and prefs persist across instances', async () => {
  const file = fixtureFile()
  const first = new BridgeState({ file, debounceMs: 1 })
  first.setPeerSession('a@im.wechat', 'wechat-1')
  first.setSessionOwner('wechat-1', 'a@im.wechat')
  first.setPrefs('a@im.wechat', { provider: 'deepseek', model: 'deepseek-chat' })
  first.dispose() // flush

  const second = new BridgeState({ file, debounceMs: 1 })
  assert.equal(second.getPeerSession('a@im.wechat'), 'wechat-1')
  assert.equal(second.getSessionOwner('wechat-1'), 'a@im.wechat')
  assert.equal(second.getPrefs('a@im.wechat').provider, 'deepseek')
  assert.equal(second.getPrefs('a@im.wechat').model, 'deepseek-chat')
  second.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('setPrefs only persists real changes', () => {
  const file = fixtureFile()
  const state = new BridgeState({ file, debounceMs: 1_000_000 })
  state.setPrefs('a@im.wechat', { cwd: '/workspace' })
  state.setPrefs('a@im.wechat', { cwd: '/workspace' }) // no-op
  state.dispose()
  const loaded = sanitizeState(JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown)
  assert.equal(loaded.peerPrefs['a@im.wechat'].cwd, '/workspace')
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('setPrefs treats empty strings as deletion (no shadowing of config fallbacks)', () => {
  const file = fixtureFile()
  const state = new BridgeState({ file, debounceMs: 1_000_000 })
  state.setPrefs('a@im.wechat', { provider: 'deepseek', model: 'deepseek-chat', cwd: '/workspace' })
  state.setPrefs('a@im.wechat', { provider: '', model: '', cwd: '' })
  assert.deepEqual(state.getPrefs('a@im.wechat'), {})
  state.dispose()
  const loaded = sanitizeState(JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown)
  assert.equal(loaded.peerPrefs['a@im.wechat'], undefined) // empty bucket is dropped
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('sanitizeState drops empty-string prefs on load (legacy prefs → default bucket)', () => {
  const data = sanitizeState({ prefs: { provider: '', model: 'x', cwd: '' } })
  assert.deepEqual(data.peerPrefs.default, { model: 'x' })
})

test('missing file starts fresh without error', () => {
  const state = new BridgeState({ file: fixtureFile(), debounceMs: 1 })
  assert.equal(state.getPeerSession('nobody'), null)
  assert.deepEqual(state.getPrefs('nobody'), {})
  state.dispose()
})

test('context tokens persist and restore across instances', () => {
  const file = `/tmp/dwb-state-tokens-${Date.now()}.json`
  const a = new BridgeState({ file, debounceMs: 5 })
  a.setContextToken('peer-1', 'token-A')
  a.dispose()
  const b = new BridgeState({ file, debounceMs: 5 })
  assert.equal(b.getContextToken('peer-1'), 'token-A')
  b.setContextToken('peer-1', null)
  b.dispose()
  const c = new BridgeState({ file, debounceMs: 5 })
  assert.equal(c.getContextToken('peer-1'), null)
  c.dispose()
})

test('per-peer prefs stay isolated (multi-user 1:1)', () => {
  const file = fixtureFile()
  const state = new BridgeState({ file, debounceMs: 1_000_000 })
  state.setPrefs('a@im.wechat', { provider: 'deepseek', model: 'deepseek-chat' })
  state.setPrefs('b@im.wechat', { provider: 'openai', model: 'gpt-4o' })
  assert.equal(state.getPrefs('a@im.wechat').model, 'deepseek-chat')
  assert.equal(state.getPrefs('b@im.wechat').model, 'gpt-4o')
  // A clearing its prefs must not affect B
  state.setPrefs('a@im.wechat', { provider: '', model: '' })
  assert.deepEqual(state.getPrefs('a@im.wechat'), {})
  assert.equal(state.getPrefs('b@im.wechat').model, 'gpt-4o')
  // unknown peer falls back to migrated default bucket
  assert.deepEqual(state.getPrefs('c@im.wechat'), {})
  state.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('legacy single-user prefs migrate into the default bucket', () => {
  const file = fixtureFile()
  fs.writeFileSync(file, JSON.stringify({ version: 1, prefs: { provider: 'deepseek', model: 'deepseek-chat' } }))
  const state = new BridgeState({ file, debounceMs: 1_000_000 })
  // The legacy owner (no own bucket yet) keeps their settings via `default`.
  assert.equal(state.getPrefs('a@im.wechat').provider, 'deepseek')
  // A new user setting their own prefs writes their own bucket, not default.
  state.setPrefs('b@im.wechat', { model: 'gpt-4o' })
  assert.equal(state.getPrefs('b@im.wechat').model, 'gpt-4o')
  assert.equal(state.getPrefs('a@im.wechat').model, 'deepseek-chat')
  state.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

// ── sessionCreators / releasedSessions (new fields, M10) ─────────────────────

test('sessionCreators and releasedSessions round-trip through sanitizeState', () => {
  const data = sanitizeState({
    sessionCreators: { 'wechat-1': 'a@im.wechat', 'wechat-2': 'b@im.wechat' },
    releasedSessions: ['wechat-2', 'wechat-2', 'wechat-3'],
  })
  assert.deepEqual(data.sessionCreators, { 'wechat-1': 'a@im.wechat', 'wechat-2': 'b@im.wechat' })
  assert.deepEqual(data.releasedSessions, ['wechat-2', 'wechat-3']) // deduped
})

test('sessionCreators and releasedSessions persist across instances', () => {
  const file = fixtureFile()
  const a = new BridgeState({ file, debounceMs: 1_000_000 })
  a.setSessionCreator('wechat-1', 'a@im.wechat')
  a.setSessionCreator('wechat-1', 'a@im.wechat') // no-op: no extra schedule
  a.markSessionReleased('wechat-2')
  assert.equal(a.getSessionCreator('wechat-1'), 'a@im.wechat')
  assert.equal(a.getSessionCreator('wechat-9'), undefined)
  assert.equal(a.isSessionReleased('wechat-2'), true)
  assert.equal(a.isSessionReleased('wechat-9'), false)
  a.dispose()

  const b = new BridgeState({ file, debounceMs: 1_000_000 })
  assert.equal(b.getSessionCreator('wechat-1'), 'a@im.wechat')
  assert.equal(b.isSessionReleased('wechat-2'), true)
  assert.deepEqual(b.toJSON().releasedSessions, ['wechat-2'])
  b.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('a legacy state file without the new fields loads with empty maps (no crash)', () => {
  const file = fixtureFile()
  fs.writeFileSync(file, JSON.stringify({ version: 1, peerSessions: { 'a@im.wechat': 'wechat-1' } }))
  const state = new BridgeState({ file, debounceMs: 1_000_000 })
  assert.equal(state.getPeerSession('a@im.wechat'), 'wechat-1')
  assert.equal(state.getSessionCreator('wechat-1'), undefined)
  assert.equal(state.isSessionReleased('wechat-1'), false)
  state.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

// ── removePairedUserId / clearPeerArtifacts semantics ────────────────────────

test('removePairedUserId and clearPeerArtifacts remove artifacts (cascade owner deletion)', () => {
  const file = fixtureFile()
  const state = new BridgeState({ file, debounceMs: 1_000_000 })
  state.addPairedUserId('a@im.wechat')
  state.addPairedUserId('b@im.wechat')
  state.setPeerSession('a@im.wechat', 'wechat-1')
  state.setPeerSession('b@im.wechat', 'wechat-2')
  state.setSessionOwner('wechat-1', 'a@im.wechat')
  state.setSessionOwner('wechat-2', 'b@im.wechat')
  state.setContextToken('a@im.wechat', 'token-A')
  state.setContextToken('b@im.wechat', 'token-B')

  state.removePairedUserId('a@im.wechat')
  assert.deepEqual(state.listPairedUserIds(), ['b@im.wechat'])
  // Pairing removal alone leaves session artifacts untouched.
  assert.equal(state.getPeerSession('a@im.wechat'), 'wechat-1')

  state.clearPeerArtifacts('a@im.wechat')
  assert.equal(state.getPeerSession('a@im.wechat'), null)
  assert.equal(state.getContextToken('a@im.wechat'), null)
  assert.equal(state.getSessionOwner('wechat-1'), null) // cascade owner deletion
  // b is completely untouched.
  assert.equal(state.getPeerSession('b@im.wechat'), 'wechat-2')
  assert.equal(state.getContextToken('b@im.wechat'), 'token-B')
  assert.equal(state.getSessionOwner('wechat-2'), 'b@im.wechat')

  state.dispose()
  const reloaded = new BridgeState({ file, debounceMs: 1_000_000 })
  assert.equal(reloaded.getPeerSession('a@im.wechat'), null)
  assert.equal(reloaded.getSessionOwner('wechat-1'), null)
  assert.deepEqual(reloaded.listPairedUserIds(), ['b@im.wechat'])
  reloaded.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

// ── M8 flush reliability ─────────────────────────────────────────────────────

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('failed flush keeps dirty true and retries until success', async () => {
  const file = fixtureFile()
  const state = new BridgeState({ file, debounceMs: 1, retryMs: 25, logger: () => {} })
  const originalWrite = fs.writeFileSync
  let writes = 0
  fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
    writes += 1
    if (writes === 1) throw new Error('simulated disk failure')
    return originalWrite(...args)
  }) as unknown as typeof fs.writeFileSync
  try {
    state.setPeerSession('a@im.wechat', 'wechat-1')
    await delay(10) // debounced flush attempt failed; retry not yet due
    assert.equal(writes, 1)
    assert.equal((state as unknown as { dirty: boolean }).dirty, true) // never cleared on failure
    await delay(60) // backoff retry fires and succeeds
    assert.equal(writes, 2)
    assert.equal((state as unknown as { dirty: boolean }).dirty, false)
    const loaded = JSON.parse(fs.readFileSync(file, 'utf-8')) as { peerSessions: Record<string, string> }
    assert.equal(loaded.peerSessions['a@im.wechat'], 'wechat-1')
  } finally {
    fs.writeFileSync = originalWrite
  }
  state.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('flush retries at most 3 times then stops, keeping dirty', async () => {
  const file = fixtureFile()
  const state = new BridgeState({ file, debounceMs: 1, retryMs: 5, logger: () => {} })
  const originalWrite = fs.writeFileSync
  let writes = 0
  fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
    writes += 1
    throw new Error('simulated persistent disk failure')
  }) as unknown as typeof fs.writeFileSync
  try {
    state.setPeerSession('a@im.wechat', 'wechat-1')
    await delay(120) // initial flush + up to 3 retries (1+5+5+5ms)
    assert.equal(writes, 4)
    assert.equal((state as unknown as { dirty: boolean }).dirty, true)
    const before = writes
    await delay(60) // no 5th attempt may fire
    assert.equal(writes, before)
  } finally {
    fs.writeFileSync = originalWrite
  }
  state.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

// ── M7 file permissions ──────────────────────────────────────────────────────

test('state file and its parent directory are written 0600 / 0700', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-mode-'))
  const file = path.join(dir, 'nested', 'state.json') // parent dir created by flush
  const state = new BridgeState({ file, debounceMs: 1_000_000 })
  state.setPeerSession('a@im.wechat', 'wechat-1')
  state.dispose() // flush
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(dir, 'nested')).mode & 0o777, 0o700)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('load heals an existing world-readable state file to 0600', () => {
  const file = fixtureFile()
  fs.writeFileSync(file, JSON.stringify({ version: 1 }))
  fs.chmodSync(file, 0o644)
  const state = new BridgeState({ file, debounceMs: 1_000_000, logger: () => {} })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  state.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('chmod failure on load warns but does not break startup', () => {
  const file = fixtureFile()
  fs.writeFileSync(file, JSON.stringify({ version: 1 }))
  const messages: string[] = []
  const originalChmod = fs.chmodSync
  fs.chmodSync = (() => {
    throw new Error('permission denied')
  }) as unknown as typeof fs.chmodSync
  try {
    const state = new BridgeState({ file, debounceMs: 1_000_000, logger: (m) => messages.push(m) })
    assert.equal(state.getPeerSession('nobody'), null) // still fully usable
    assert.ok(messages.some((m) => m.includes('permissions')))
    state.dispose()
  } finally {
    fs.chmodSync = originalChmod
  }
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

// ── M10 sanitize depth ───────────────────────────────────────────────────────

test('sanitizeState drops illegal session ids and peer ids', () => {
  const data = sanitizeState({
    peerSessions: {
      'a@im.wechat': 'wechat-ok-1',
      'ok-peer@im.wechat': 'wechat-BAD', // uppercase violates session id rules
      'ok-peer2@im.wechat': 'evil/../wechat-1', // slash smuggled into a session id
      '': 'wechat-x', // empty peer
      'x@im.wechat': '', // empty session
      [`p${'x'.repeat(129)}`]: 'wechat-y', // peer id over 128 chars
      'bad\npeer': 'wechat-z', // newline in peer id
      'nul\0peer': 'wechat-w', // NUL in peer id
    },
    sessionOwners: {
      'wechat-1': 'a@im.wechat',
      'wechat-BAD_UPPER': 'b@im.wechat', // session id with illegal chars
      'not-wechat': 'c@im.wechat', // wrong prefix
      'wechat-2': 'b@im.wechat', // valid
      'wechat-3': '', // empty owner peer
    },
    pairedUserIds: ['a@im.wechat', '', 'b@im.wechat', `p${'x'.repeat(129)}`, 'bad\rpeer', 'b@im.wechat'],
    sessionCreators: {
      'wechat-3': 'c@im.wechat',
      'wechat-BAD': 'd@im.wechat', // illegal session key
      'wechat-4': '', // empty creator
    },
    releasedSessions: ['wechat-5', 'wechat-BAD', '', 'wechat-6', 'wechat-6'],
  })
  assert.deepEqual(data.peerSessions, { 'a@im.wechat': 'wechat-ok-1' })
  assert.deepEqual(data.sessionOwners, { 'wechat-1': 'a@im.wechat', 'wechat-2': 'b@im.wechat' })
  assert.deepEqual(data.pairedUserIds, ['a@im.wechat', 'b@im.wechat']) // deduped
  assert.deepEqual(data.sessionCreators, { 'wechat-3': 'c@im.wechat' })
  assert.deepEqual(data.releasedSessions, ['wechat-5', 'wechat-6'])
})

// ── LOW version tolerance ────────────────────────────────────────────────────

test('missing version loads as v1 without warning', () => {
  const file = fixtureFile()
  fs.writeFileSync(file, JSON.stringify({ peerSessions: { 'a@im.wechat': 'wechat-1' } }))
  const messages: string[] = []
  const state = new BridgeState({ file, debounceMs: 1_000_000, logger: (m) => messages.push(m) })
  assert.equal(state.getPeerSession('a@im.wechat'), 'wechat-1')
  assert.deepEqual(messages, [])
  state.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('unsupported version warns and still loads known fields', () => {
  const file = fixtureFile()
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 2, peerSessions: { 'a@im.wechat': 'wechat-1' }, futureField: 42 }),
  )
  const messages: string[] = []
  const state = new BridgeState({ file, debounceMs: 1_000_000, logger: (m) => messages.push(m) })
  assert.equal(state.getPeerSession('a@im.wechat'), 'wechat-1') // not rejected
  assert.ok(messages.some((m) => m.includes('unsupported version 2')))
  state.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})
