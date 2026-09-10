/**
 * The session log accessor pins the SUPPORTED host API (dsh 0.1.5:
 * `Session.snapshotEvents()`), the never-throw guarantee that keeps a host API
 * drift from killing the process (2026-09-10 outage), and the one-time drift
 * diagnostic — a silent `undefined` is what made that outage invisible.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The drift diagnostic writes into the bridge's debug sinks (resolved lazily at
// call time), so point DSH_HOME at a throwaway dir before any test runs.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wechat-bridge-test-'))

import { lastSessionEvent, reversedSessionEvents, sessionEvents } from '../src/session-events.ts'

const event = (seq: number): { seq: number } => ({ seq })

function driftLines(): string[] {
  const sink = path.join(process.env.DSH_HOME!, 'storages', 'dsh-wechat-bridge', 'events.jsonl')
  if (!fs.existsSync(sink)) return []
  return fs
    .readFileSync(sink, 'utf-8')
    .split('\n')
    .filter((line) => line.includes('session-events-api-drift'))
}

test('an absent host API is reported once, not silently ignored', () => {
  assert.deepEqual(sessionEvents({ id: 'wechat-missing' } as never), [])
  const lines = driftLines()
  assert.equal(lines.length, 1, 'the drift is logged exactly once')
  assert.match(lines[0]!, /snapshotEvents is not a function/)
})

test('sessionEvents reads the supported host API (snapshotEvents)', () => {
  const snapshot = [event(1), event(2)]
  assert.deepEqual(sessionEvents({ id: 'wechat-x', snapshotEvents: () => snapshot } as never), snapshot)
})

test('sessionEvents ignores the removed legacy property', () => {
  // 0.1.5 removed `Session.events`; this plugin supports the current host only,
  // so a legacy-looking double must NOT be read.
  assert.deepEqual(sessionEvents({ id: 'wechat-x', events: [event(9)] } as never), [])
})

test('sessionEvents swallows a throwing accessor instead of taking the host down', () => {
  const session = {
    id: 'wechat-x',
    snapshotEvents: () => {
      throw new TypeError('session.events is not iterable')
    },
  } as never
  assert.deepEqual(sessionEvents(session), [])
})

test('sessionEvents tolerates a non-array accessor result', () => {
  assert.deepEqual(sessionEvents({ id: 'wechat-x', snapshotEvents: () => undefined } as never), [])
})

test('lastSessionEvent / reversedSessionEvents follow the resolved log', () => {
  const session = { id: 'wechat-x', snapshotEvents: () => [event(1), event(2)] } as never
  assert.equal((lastSessionEvent(session) as unknown as { seq: number }).seq, 2)
  assert.deepEqual(
    reversedSessionEvents(session).map((item) => (item as unknown as { seq: number }).seq),
    [2, 1],
  )
})
