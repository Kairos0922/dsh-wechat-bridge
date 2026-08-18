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
import { RATE_LIMIT_ERRCODE, SESSION_EXPIRED_ERRCODE, } from "../gateway/types.js";
export const OUTBOX_PRIORITY = { system: 10, text: 20, tool: 25, progress: 30 };
/** Max attempts (1 send + this many retries) for transport-level failures. */
export const OUTBOX_MAX_ATTEMPTS = 3;
/**
 * Max attempts for the ret=-2 rate-limit/session-class error (protocol.md §5).
 * Larger than the transport budget because the channel needs a real cooldown
 * window (10s→30s→60s→60s) before a retry can succeed — 3 attempts would give
 * up after only 40s and silently lose a message the server never rejected.
 */
export const OUTBOX_RATE_LIMIT_MAX_ATTEMPTS = 5;
export class Outbox {
    opts;
    onPause;
    onDrop;
    queue = [];
    coalesced = new Map();
    /** -Infinity: the first send needs no inter-message spacing. */
    lastSendAt = Number.NEGATIVE_INFINITY;
    backoffIdx = 0;
    pausedUntil = null;
    pumping = false;
    disposed = false;
    constructor(opts) {
        this.opts = {
            minIntervalMs: opts.minIntervalMs,
            backoffSecs: opts.backoffSecs,
            sessionExpiredPauseMs: opts.sessionExpiredPauseMs,
            send: opts.send,
            now: opts.now ?? Date.now,
            sleep: opts.sleep ??
                ((ms) => new Promise((resolve) => {
                    // Unref'd: a paused queue must never keep the process alive.
                    const timer = setTimeout(resolve, ms);
                    timer.unref?.();
                })),
        };
        this.onPause = opts.onPause;
        this.onDrop = opts.onDrop;
    }
    enqueue(entry) {
        if (this.disposed) {
            this.onDrop?.(entry, 'disposed');
            return;
        }
        if (entry.coalesceKey !== undefined) {
            const existing = this.coalesced.get(entry.coalesceKey);
            if (existing !== undefined) {
                const index = this.queue.indexOf(existing);
                if (index >= 0) {
                    const replacement = { ...entry, createdAt: existing.createdAt };
                    this.queue[index] = replacement;
                    this.coalesced.set(entry.coalesceKey, replacement);
                    this.onDrop?.(existing, 'coalesced');
                    return;
                }
            }
        }
        this.queue.push(entry);
        if (entry.coalesceKey !== undefined)
            this.coalesced.set(entry.coalesceKey, entry);
        this.sortQueue();
        // Start the pump on a microtask so synchronous enqueue bursts (chunk loops)
        // are sorted/coalesced together before the first dispatch.
        queueMicrotask(() => {
            void this.pump();
        });
    }
    sortQueue() {
        this.queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    }
    pendingCount() {
        return this.queue.length;
    }
    getPausedUntil() {
        return this.pausedUntil;
    }
    /** Wait until the queue is empty and no pause remains (tests/dispose). */
    async drain() {
        while (this.queue.length > 0 || this.pumping || (this.pausedUntil !== null && this.pausedUntil > this.opts.now())) {
            await this.opts.sleep(5);
        }
    }
    dispose() {
        this.disposed = true;
        for (const entry of this.queue.splice(0)) {
            this.onDrop?.(entry, 'disposed');
        }
        this.coalesced.clear();
    }
    async pump() {
        if (this.pumping)
            return;
        this.pumping = true;
        try {
            while (!this.disposed) {
                const entry = this.queue[0];
                if (entry === undefined)
                    break;
                const pause = this.pausedUntil;
                if (pause !== null) {
                    const wait = pause - this.opts.now();
                    if (wait > 0) {
                        await this.opts.sleep(wait);
                        continue;
                    }
                    this.pausedUntil = null;
                }
                const since = this.opts.now() - this.lastSendAt;
                if (since < this.opts.minIntervalMs) {
                    await this.opts.sleep(this.opts.minIntervalMs - since);
                    continue;
                }
                this.queue.shift();
                if (entry.coalesceKey !== undefined)
                    this.coalesced.delete(entry.coalesceKey);
                this.lastSendAt = this.opts.now();
                let result;
                try {
                    result = await this.opts.send(entry);
                }
                catch (err) {
                    // A thrown send is transport-level by definition: retryable.
                    result = { ok: false, errmsg: String(err).slice(0, 200), retryable: true };
                }
                const retried = this.handleResult(entry, result);
                // Transport-level failures re-enqueue (up to OUTBOX_MAX_ATTEMPTS).
                // Re-enqueue goes to the BACK of its priority class (fresh createdAt)
                // and the min-interval spacing paces the retry — a natural backoff.
                if (retried) {
                    const attempts = (entry.retryCount ?? 0) + 1;
                    this.enqueue({ ...entry, retryCount: attempts, createdAt: this.opts.now() });
                    if (this.pumping)
                        continue;
                }
            }
        }
        finally {
            this.pumping = false;
        }
    }
    /**
     * Classify a send result. Returns true when the entry was re-enqueued for
     * retry; false when the entry is settled (delivered, paused, or dropped).
     */
    handleResult(entry, result) {
        if (result.ok) {
            this.backoffIdx = 0;
            return false;
        }
        if (result.errcode === SESSION_EXPIRED_ERRCODE) {
            this.pausedUntil = this.opts.now() + this.opts.sessionExpiredPauseMs;
            this.backoffIdx = 0;
            this.onPause?.(this.pausedUntil, 'session-expired');
            return false;
        }
        if (result.errcode === RATE_LIMIT_ERRCODE) {
            this.pausedUntil = this.opts.now() + this.nextBackoffSecs() * 1000;
            this.onPause?.(this.pausedUntil, 'rate-limit');
            return false;
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
            const attempts = (entry.retryCount ?? 0) + 1;
            if (attempts < OUTBOX_RATE_LIMIT_MAX_ATTEMPTS) {
                this.pausedUntil = this.opts.now() + this.nextBackoffSecs() * 1000;
                this.onPause?.(this.pausedUntil, 'rate-limit');
                return true;
            }
            this.backoffIdx = 0;
            this.onDrop?.(entry, 'failed', result);
            return false;
        }
        // Generic failure. Transport-level (retryable) failures re-enqueue within
        // the attempt budget; explicit server rejections (retryable === false)
        // and exhausted budgets drop the entry.
        const attempts = (entry.retryCount ?? 0) + 1;
        if (result.retryable !== false && attempts < OUTBOX_MAX_ATTEMPTS) {
            this.backoffIdx = 0;
            return true;
        }
        this.backoffIdx = 0;
        this.onDrop?.(entry, 'failed', result);
        return false;
    }
    /** Escalating backoff seconds for rate-limit-class errors, shared with -12. */
    nextBackoffSecs() {
        const steps = this.opts.backoffSecs;
        const secs = steps[Math.min(this.backoffIdx, steps.length - 1)] ?? steps[steps.length - 1] ?? 10;
        this.backoffIdx += 1;
        return secs;
    }
}
//# sourceMappingURL=outbox.js.map