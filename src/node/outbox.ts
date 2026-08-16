/**
 * Rate-limit-aware outbound queue.
 *
 * Every WeChat-bound delivery goes through ONE serial per-process queue
 * (all peers share the channel's rate budget). Properties:
 * - priority ordering: approvals/errors (system) → answers (text) →
 *   tool cards → aggregated progress; FIFO within a priority;
 * - progress entries coalesce by `coalesceKey` (a newer digest replaces a
 *   still-queued older one — thinking/todo updates never pile up);
 * - a minimum inter-message interval spaces sends out;
 * - errcode -12 (rate limit) triggers escalating backoff;
 * - errcode -14 (session expired) pauses the queue entirely for a cooldown,
 *   mirroring the official session-guard behavior;
 * - everything is disposable: dispose drops queued entries and stops timers.
 *
 * The injectable send/now/sleep seams keep the pacing logic unit-testable.
 *
 * @module dsh-wechat-bridge/node/outbox
 */

import {
  RATE_LIMIT_ERRCODE,
  SESSION_EXPIRED_ERRCODE,
  type MessageItem,
  type SendResult,
} from '../gateway/types.ts'

export type OutboxEntryKind = 'system' | 'text' | 'tool-start' | 'tool-result' | 'progress' | 'file' | 'image'

export interface OutboxEntry {
  kind: OutboxEntryKind
  /** Lower sends first. */
  priority: number
  /** Destination peer (the WeChat sender id or group:<roomId>). */
  to?: string
  text?: string
  item?: MessageItem
  /** For kind 'file'/'image': the local artifact to upload and send. */
  media?: { filePath: string; fileName: string }
  /** Progress coalescing: a newer entry replaces a queued older one. */
  coalesceKey?: string
  createdAt: number
}

export const OUTBOX_PRIORITY = { system: 10, text: 20, tool: 25, progress: 30 } as const

export interface OutboxOptions {
  minIntervalMs: number
  backoffSecs: number[]
  sessionExpiredPauseMs: number
  send: (entry: OutboxEntry) => Promise<SendResult>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onPause?: (until: number, reason: 'rate-limit' | 'session-expired') => void
  onDrop?: (entry: OutboxEntry, reason: 'coalesced' | 'disposed') => void
}

export class Outbox {
  private readonly opts: Required<Pick<OutboxOptions, 'minIntervalMs' | 'backoffSecs' | 'sessionExpiredPauseMs' | 'send' | 'now' | 'sleep'>>
  private readonly onPause?: OutboxOptions['onPause']
  private readonly onDrop?: OutboxOptions['onDrop']
  private queue: OutboxEntry[] = []
  private coalesced = new Map<string, OutboxEntry>()
  /** -Infinity: the first send needs no inter-message spacing. */
  private lastSendAt = Number.NEGATIVE_INFINITY
  private backoffIdx = 0
  private pausedUntil: number | null = null
  private pumping = false
  private disposed = false

  constructor(opts: OutboxOptions) {
    this.opts = {
      minIntervalMs: opts.minIntervalMs,
      backoffSecs: opts.backoffSecs,
      sessionExpiredPauseMs: opts.sessionExpiredPauseMs,
      send: opts.send,
      now: opts.now ?? Date.now,
      sleep:
        opts.sleep ??
        ((ms: number) =>
          new Promise<void>((resolve) => {
            // Unref'd: a paused queue must never keep the process alive.
            const timer = setTimeout(resolve, ms)
            timer.unref?.()
          })),
    }
    this.onPause = opts.onPause
    this.onDrop = opts.onDrop
  }

  enqueue(entry: OutboxEntry): void {
    if (this.disposed) {
      this.onDrop?.(entry, 'disposed')
      return
    }
    if (entry.coalesceKey !== undefined) {
      const existing = this.coalesced.get(entry.coalesceKey)
      if (existing !== undefined) {
        const index = this.queue.indexOf(existing)
        if (index >= 0) {
          const replacement: OutboxEntry = { ...entry, createdAt: existing.createdAt }
          this.queue[index] = replacement
          this.coalesced.set(entry.coalesceKey, replacement)
          this.onDrop?.(existing, 'coalesced')
          return
        }
      }
    }
    this.queue.push(entry)
    if (entry.coalesceKey !== undefined) this.coalesced.set(entry.coalesceKey, entry)
    this.sortQueue()
    // Start the pump on a microtask so synchronous enqueue bursts (chunk loops)
    // are sorted/coalesced together before the first dispatch.
    queueMicrotask(() => {
      void this.pump()
    })
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
  }

  pendingCount(): number {
    return this.queue.length
  }

  getPausedUntil(): number | null {
    return this.pausedUntil
  }

  /** Wait until the queue is empty and no pause remains (tests/dispose). */
  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.pumping || (this.pausedUntil !== null && this.pausedUntil > this.opts.now())) {
      await this.opts.sleep(5)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.queue.splice(0)) {
      this.onDrop?.(entry, 'disposed')
    }
    this.coalesced.clear()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.disposed) {
        const entry = this.queue[0]
        if (entry === undefined) break

        const pause = this.pausedUntil
        if (pause !== null) {
          const wait = pause - this.opts.now()
          if (wait > 0) {
            await this.opts.sleep(wait)
            continue
          }
          this.pausedUntil = null
        }

        const since = this.opts.now() - this.lastSendAt
        if (since < this.opts.minIntervalMs) {
          await this.opts.sleep(this.opts.minIntervalMs - since)
          continue
        }

        this.queue.shift()
        if (entry.coalesceKey !== undefined) this.coalesced.delete(entry.coalesceKey)
        this.lastSendAt = this.opts.now()
        let result: SendResult
        try {
          result = await this.opts.send(entry)
        } catch (err) {
          result = { ok: false, errmsg: String(err).slice(0, 200) }
        }
        this.handleResult(result)
      }
    } finally {
      this.pumping = false
    }
  }

  private handleResult(result: SendResult): void {
    if (result.ok) {
      this.backoffIdx = 0
      return
    }
    if (result.errcode === SESSION_EXPIRED_ERRCODE) {
      this.pausedUntil = this.opts.now() + this.opts.sessionExpiredPauseMs
      this.backoffIdx = 0
      this.onPause?.(this.pausedUntil, 'session-expired')
      return
    }
    if (result.errcode === RATE_LIMIT_ERRCODE) {
      const steps = this.opts.backoffSecs
      const secs = steps[Math.min(this.backoffIdx, steps.length - 1)] ?? steps[steps.length - 1] ?? 10
      this.backoffIdx += 1
      this.pausedUntil = this.opts.now() + secs * 1000
      this.onPause?.(this.pausedUntil, 'rate-limit')
      return
    }
    // Generic failure: no pause; the next pump iteration's min-interval spacing
    // already prevents a hot retry loop. Backoff index resets so a single
    // transient network blip does not escalate.
    this.backoffIdx = 0
  }
}
