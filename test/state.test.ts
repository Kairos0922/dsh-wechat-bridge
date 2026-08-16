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
    prefs: { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp/x' },
    peerSessions: { 'a@im.wechat': 'wechat-1' },
    sessionOwners: { 'wechat-1': 'a@im.wechat' },
  })
  assert.equal(data.prefs.provider, 'deepseek')
  assert.equal(data.prefs.model, 'deepseek-chat')
  assert.equal(data.peerSessions['a@im.wechat'], 'wechat-1')
  assert.equal(data.sessionOwners['wechat-1'], 'a@im.wechat')
})

test('sanitizeState drops malformed fields and never throws', () => {
  const data = sanitizeState({ prefs: { provider: 42 }, peerSessions: { a: 1 }, sessionOwners: 'junk' })
  assert.deepEqual(data.prefs, {})
  assert.deepEqual(data.peerSessions, {})
  assert.deepEqual(data.sessionOwners, {})
  assert.deepEqual(sanitizeState(null), { version: 1, prefs: {}, peerSessions: {}, sessionOwners: {}, contextTokens: {} })
})

test('peer bindings and prefs persist across instances', async () => {
  const file = fixtureFile()
  const first = new BridgeState({ file, debounceMs: 1 })
  first.setPeerSession('a@im.wechat', 'wechat-1')
  first.setSessionOwner('wechat-1', 'a@im.wechat')
  first.setPrefs({ provider: 'deepseek', model: 'deepseek-chat' })
  first.dispose() // flush

  const second = new BridgeState({ file, debounceMs: 1 })
  assert.equal(second.getPeerSession('a@im.wechat'), 'wechat-1')
  assert.equal(second.getSessionOwner('wechat-1'), 'a@im.wechat')
  assert.equal(second.prefs.provider, 'deepseek')
  assert.equal(second.prefs.model, 'deepseek-chat')
  second.dispose()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('setPrefs only persists real changes', () => {
  const file = fixtureFile()
  const state = new BridgeState({ file, debounceMs: 1_000_000 })
  state.setPrefs({ cwd: '/workspace' })
  state.setPrefs({ cwd: '/workspace' }) // no-op
  state.dispose()
  const loaded = sanitizeState(JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown)
  assert.equal(loaded.prefs.cwd, '/workspace')
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('setPrefs treats empty strings as deletion (no shadowing of config fallbacks)', () => {
  const file = fixtureFile()
  const state = new BridgeState({ file, debounceMs: 1_000_000 })
  state.setPrefs({ provider: 'deepseek', model: 'deepseek-chat', cwd: '/workspace' })
  state.setPrefs({ provider: '', model: '', cwd: '' })
  assert.deepEqual(state.prefs, {})
  state.dispose()
  const loaded = sanitizeState(JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown)
  assert.deepEqual(loaded.prefs, {})
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('sanitizeState drops empty-string prefs on load', () => {
  const data = sanitizeState({ prefs: { provider: '', model: 'x', cwd: '' } })
  assert.deepEqual(data.prefs, { model: 'x' })
})

test('missing file starts fresh without error', () => {
  const state = new BridgeState({ file: fixtureFile(), debounceMs: 1 })
  assert.equal(state.getPeerSession('nobody'), null)
  assert.deepEqual(state.prefs, {})
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
