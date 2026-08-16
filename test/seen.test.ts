/**
 * Durable seen-set unit tests — injectable clock and fixture files.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SeenSet, SeenStore } from '../src/seen.ts'

test('SeenSet dedups within TTL and expires after', () => {
  let now = 0
  const set = new SeenSet({ ttlMs: 1000, now: () => now })
  set.mark(42)
  assert.ok(set.has(42))
  assert.ok(!set.has(43))
  now += 999
  assert.ok(set.has(42))
  now += 2
  assert.ok(!set.has(42))
})

test('SeenSet prunes beyond cap', () => {
  let now = 0
  const set = new SeenSet({ ttlMs: 10_000, cap: 3, now: () => now })
  set.mark(1)
  now += 1
  set.mark(2)
  now += 1
  set.mark(3)
  now += 1
  set.mark(4)
  assert.equal(set.size, 3)
  assert.ok(!set.has(1))
})

test('SeenStore persists and restores across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-seen-'))
  const file = path.join(dir, 'seen.json')
  const first = new SeenStore({ file, debounceMs: 1 })
  first.mark(7)
  first.dispose() // flush

  const second = new SeenStore({ file, debounceMs: 1 })
  assert.ok(second.has(7))
  assert.ok(!second.has(8))
  second.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('SeenStore survives a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-seen-'))
  const file = path.join(dir, 'seen.json')
  fs.writeFileSync(file, 'not json at all')
  const store = new SeenStore({ file })
  assert.ok(!store.has(1))
  store.mark(1)
  store.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('SeenStore ignores non-array entries on restore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-seen-'))
  const file = path.join(dir, 'seen.json')
  const now = Date.now()
  fs.writeFileSync(file, JSON.stringify([[1, now], 'junk', [3, now]]))
  const store = new SeenStore({ file })
  assert.ok(store.has(1))
  assert.ok(store.has(3))
  store.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})
