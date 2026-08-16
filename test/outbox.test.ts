/**
 * Outbox unit tests — injectable clock/send seams, no network, no DSH.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Outbox, OUTBOX_PRIORITY, type OutboxEntry } from '../src/node/outbox.ts'
import type { SendResult } from '../src/gateway/types.ts'

function makeOutbox(overrides: {
  results?: SendResult[]
  minIntervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
} = {}) {
  const sent: OutboxEntry[] = []
  const results = overrides.results ?? []
  const outbox = new Outbox({
    minIntervalMs: overrides.minIntervalMs ?? 10,
    backoffSecs: [10, 30, 60],
    sessionExpiredPauseMs: 60 * 60_000,
    now: overrides.now,
    sleep: overrides.sleep,
    send: async (entry) => {
      sent.push(entry)
      return results.shift() ?? { ok: true }
    },
  })
  return { outbox, sent }
}

function entry(partial: Partial<OutboxEntry> & { createdAt?: number } = {}): OutboxEntry {
  return { kind: 'text', priority: OUTBOX_PRIORITY.text, createdAt: 0, ...partial }
}

test('sends in priority order, FIFO within a priority', async () => {
  const { outbox, sent } = makeOutbox()
  outbox.enqueue(entry({ kind: 'progress', priority: 30, text: 'p1', createdAt: 1 }))
  outbox.enqueue(entry({ kind: 'text', priority: 20, text: 't1', createdAt: 2 }))
  outbox.enqueue(entry({ kind: 'system', priority: 10, text: 's1', createdAt: 3 }))
  outbox.enqueue(entry({ kind: 'text', priority: 20, text: 't2', createdAt: 4 }))
  await outbox.drain()
  assert.deepEqual(
    sent.map((e) => e.text),
    ['s1', 't1', 't2', 'p1'],
  )
})

test('coalesces queued progress entries by key, keeping the newer text', async () => {
  const { outbox, sent } = makeOutbox()
  outbox.enqueue(entry({ kind: 'progress', priority: 30, text: '旧进度', coalesceKey: 'think', createdAt: 1 }))
  outbox.enqueue(entry({ kind: 'progress', priority: 30, text: '新进度', coalesceKey: 'think', createdAt: 2 }))
  await outbox.drain()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.text, '新进度')
})

test('coalescing does not merge a started entry', async () => {
  const slowSleep = async (ms: number) => {
    await new Promise((r) => setTimeout(r, Math.min(ms, 30)))
  }
  const { outbox, sent } = makeOutbox({ sleep: slowSleep, minIntervalMs: 5 })
  outbox.enqueue(entry({ kind: 'progress', priority: 30, text: '第一批', coalesceKey: 'think', createdAt: 1 }))
  await slowSleep(20)
  outbox.enqueue(entry({ kind: 'progress', priority: 30, text: '第二批', coalesceKey: 'think', createdAt: 2 }))
  await outbox.drain()
  assert.equal(sent.length, 2)
})

test('rate-limit (-12) escalates backoff via the injected clock', async () => {
  let now = 0
  const sleeps: number[] = []
  const { outbox, sent } = makeOutbox({
    results: [{ ok: false, ret: -1, errcode: -12 }, { ok: false, ret: -1, errcode: -12 }, { ok: true }],
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
  })
  outbox.enqueue(entry({ text: 'a' }))
  outbox.enqueue(entry({ text: 'b' }))
  outbox.enqueue(entry({ text: 'c' }))
  await outbox.drain()
  assert.equal(sent.length, 3)
  // 5ms sleeps are drain()'s polling pokes; the real waits are the backoffs.
  assert.deepEqual(sleeps.filter((ms) => ms !== 5), [10_000, 30_000])
})

test('session-expiry (-14) pauses the queue for the cooldown', async () => {
  let now = 0
  const sleeps: number[] = []
  const { outbox, sent } = makeOutbox({
    results: [{ ok: false, ret: -1, errcode: -14 }, { ok: true }],
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
  })
  outbox.enqueue(entry({ text: 'a' }))
  outbox.enqueue(entry({ text: 'b' }))
  await outbox.drain()
  assert.equal(sent.length, 2)
  assert.ok(
    sleeps.some((ms) => ms >= 60 * 60_000),
    'one wait should be the session-expired cooldown',
  )
})

test('generic failures do not pause the queue', async () => {
  let now = 0
  const sleeps: number[] = []
  const { outbox, sent } = makeOutbox({
    results: [{ ok: false, errmsg: 'network down' }, { ok: true }],
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
  })
  outbox.enqueue(entry({ text: 'a' }))
  outbox.enqueue(entry({ text: 'b' }))
  await outbox.drain()
  assert.equal(sent.length, 2)
  assert.ok(sleeps.every((ms) => ms < 60 * 60_000), 'no long pause expected')
  assert.equal(outbox.getPausedUntil(), null)
})

test('dispose drops remaining entries', async () => {
  const { outbox, sent } = makeOutbox({ sleep: () => new Promise((r) => setTimeout(r, 50)) })
  outbox.enqueue(entry({ text: 'a' }))
  outbox.enqueue(entry({ text: 'b' }))
  outbox.dispose()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(sent.length, 0)
})
