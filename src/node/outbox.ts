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

export type OutboxEntryKind = 'system' | 'text' | 'tool-start' | 'tool-result' | 'progress' | 'file' | 'image' | 'video'

export interface OutboxEntry {
  kind: OutboxEntryKind
  /** Lower sends first. */
  priority: number
  /** Destination peer (the WeChat sender id or group:<roomId>). */
  to?: string
  text?: string
  item?: MessageItem
  /** For kind 'file'/'image'/'video': the local artifact to upload and send. */
  media?: { filePath: string; fileName: string }
  /** Progress coalescing: a newer entry replaces a queued older one. */
  coalesceKey?: string
  createdAt: number
  /** Transport-level failures re-enqueue up to this many times. */
  retryCount?: number
  /**
   * Set once the file→text fallback fired during dispatch (core). Guard
   * against duplicate degradation: retried file sends must not enqueue the
   * fallback text a second time, and after the fallback the file entry
   * itself settles (the text IS the delivery).
   */
  fallbackFired?: boolean
  /**
   * MUST-DELIVER marker: if this entry is dropped (retries exhausted while
   * the channel is down), its text is recorded for re-push on the peer's
   * next inbound message (approval prompts, final answers, error/stop
   * notices — see core.retryCriticalMessages). The channel is demonstrably
   * alive exactly when the user speaks, so the resend lands.
   */
  resendOnRecovery?: boolean
}

export const OUTBOX_PRIORITY = { system: 10, text: 20, tool: 25, progress: 30 } as const

/** Max attempts (1 send + this many retries) for transport-level failures. */
export const OUTBOX_MAX_ATTEMPTS = 3

/**
 * Max attempts for the ret=-2 rate-limit/session-class error (protocol.md §5).
 * Larger than the transport budget because the channel needs a real cooldown
 * window (10s→30s→60s→60s) before a retry can succeed — 3 attempts would give
 * up after only 40s and silently lose a message the server never rejected.
 */
export const OUTBOX_RATE_LIMIT_MAX_ATTEMPTS = 5

export interface OutboxOptions {
  minIntervalMs: number
  backoffSecs: number[]
  sessionExpiredPauseMs: number
  send: (entry: OutboxEntry) => Promise<SendResult>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onPause?: (until: number, reason: 'rate-limit' | 'session-expired') => void
  onDrop?: (outboxEntry: OutboxEntry, reason: 'coalesced' | 'disposed' | 'failed', result?: SendResult) => void
  /**
   * Sliding-window send budget: at most `maxPerWindow` sends in any
   * `windowMs` span. Extra entries wait in the queue (never dropped) until
   * the window rolls. The channel's server-side quota is NOT public — the
   * 2026-08-18 incident showed ~5-10 sends per session window followed by
   * `prepare failed` for minutes, so the client must throttle itself below
   * whatever the server allows. Default: none (unlimited).
   */
  budget?: { windowMs: number; maxPerWindow: number }
}

export class Outbox {
  private readonly opts: Required<Pick<OutboxOptions, 'minIntervalMs' | 'backoffSecs' | 'sessionExpiredPauseMs' | 'send' | 'now' | 'sleep'>>
  private readonly onPause?: OutboxOptions['onPause']
  private readonly onDrop?: OutboxOptions['onDrop']
  private readonly budget?: { windowMs: number; maxPerWindow: number }
  private queue: OutboxEntry[] = []
  private coalesced = new Map<string, OutboxEntry>()
  /** -Infinity: the first send needs no inter-message spacing. */
  private lastSendAt = Number.NEGATIVE_INFINITY
  private backoffIdx = 0
  private pausedUntil: number | null = null
  private pumping = false
  private disposed = false
  /** Timestamps of sends inside the current budget window (sliding). */
  private budgetSends: number[] = []

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
    this.budget = opts.budget
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

        // Sliding-window budget: hold the head entry (never drop) until a
        // budget slot frees up — the server's per-window quota is not public,
        // so the client throttles itself conservatively (see protocol.md §8).
        if (this.budget) {
          const now = this.opts.now()
          const windowStart = now - this.budget.windowMs
          this.budgetSends = this.budgetSends.filter((ts) => ts >= windowStart)
          if (this.budgetSends.length >= this.budget.maxPerWindow) {
            const wait = this.budgetSends[0]! + this.budget.windowMs - now
            if (wait > 0) {
              await this.opts.sleep(wait)
              continue
            }
          }
        }

        this.queue.shift()
        if (entry.coalesceKey !== undefined) this.coalesced.delete(entry.coalesceKey)
        this.lastSendAt = this.opts.now()
        this.budgetSends.push(this.opts.now())
        let result: SendResult
        try {
          result = await this.opts.send(entry)
        } catch (err) {
          // A thrown send is transport-level by definition: retryable.
          result = { ok: false, errmsg: String(err).slice(0, 200), retryable: true }
        }
        const retried = this.handleResult(entry, result)
        // Transport-level failures re-enqueue (up to OUTBOX_MAX_ATTEMPTS).
        // Re-enqueue goes to the BACK of its priority class (fresh createdAt)
        // and the min-interval spacing paces the retry — a natural backoff.
        if (retried) {
          const attempts = (entry.retryCount ?? 0) + 1
          this.enqueue({ ...entry, retryCount: attempts, createdAt: this.opts.now() })
          if (this.pumping) continue
        }
      }
    } finally {
      this.pumping = false
    }
  }

  /**
   * Classify a send result. Returns true when the entry was re-enqueued for
   * retry; false when the entry is settled (delivered, paused, or dropped).
   */
  private handleResult(entry: OutboxEntry, result: SendResult): boolean {
    if (result.ok) {
      this.backoffIdx = 0
      return false
    }
    if (result.errcode === SESSION_EXPIRED_ERRCODE) {
      this.pausedUntil = this.opts.now() + this.opts.sessionExpiredPauseMs
      this.backoffIdx = 0
      this.onPause?.(this.pausedUntil, 'session-expired')
      // The entry settles here — dropped for now, but never silently:
      // MUST-DELIVER entries join the recovery resend list via onDrop.
      this.onDrop?.(entry, 'failed', result)
      return false
    }
    if (result.errcode === RATE_LIMIT_ERRCODE) {
      this.pausedUntil = this.opts.now() + this.nextBackoffSecs() * 1000
      this.onPause?.(this.pausedUntil, 'rate-limit')
      this.onDrop?.(entry, 'failed', result)
      return false
    }
    // ret=-2 (errcode absent): the rate-limit/session-class business error —
    // see docs/protocol.md §5 ("曾被误读为媒体形状被服务器拒绝——实际是限流/
    // 会话类业务错误"). NOT a permanent rejection: the channel needs a
    // cooldown, not a silent drop. Pause with escalating backoff and re-queue
    // the entry, so a transient limit degrades to delayed delivery instead of
    // the observed "卡住" (every subsequent message dropped, channel dead).
    // File entries are excluded: their text fallback already fired during
    // dispatch, so retrying would duplicate the delivery.
    if (result.ret === -2 && entry.kind !== 'file') {
      const attempts = (entry.retryCount ?? 0) + 1
      if (attempts < OUTBOX_RATE_LIMIT_MAX_ATTEMPTS) {
        this.pausedUntil = this.opts.now() + this.nextBackoffSecs() * 1000
        this.onPause?.(this.pausedUntil, 'rate-limit')
        return true
      }
      this.backoffIdx = 0
      this.onDrop?.(entry, 'failed', result)
      return false
    }
    // Generic failure. A file whose fallback already fired settles now —
    // the degraded text is the delivery; retrying the file would duplicate.
    if (entry.kind === 'file' && entry.fallbackFired) {
      this.backoffIdx = 0
      this.onDrop?.(entry, 'failed', result)
      return false
    }
    // Transport-level (retryable) failures re-enqueue within the attempt
    // budget; explicit server rejections (retryable === false) and exhausted
    // budgets drop the entry.
    const attempts = (entry.retryCount ?? 0) + 1
    if (result.retryable !== false && attempts < OUTBOX_MAX_ATTEMPTS) {
      this.backoffIdx = 0
      return true
    }
    this.backoffIdx = 0
    this.onDrop?.(entry, 'failed', result)
    return false
  }

  /** Escalating backoff seconds for rate-limit-class errors, shared with -12. */
  private nextBackoffSecs(): number {
    const steps = this.opts.backoffSecs
    const secs = steps[Math.min(this.backoffIdx, steps.length - 1)] ?? steps[steps.length - 1] ?? 10
    this.backoffIdx += 1
    return secs
  }
}
