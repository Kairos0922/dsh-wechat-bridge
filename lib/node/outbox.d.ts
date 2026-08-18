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
import { type MessageItem, type SendResult } from '../gateway/types.ts';
export type OutboxEntryKind = 'system' | 'text' | 'tool-start' | 'tool-result' | 'progress' | 'file' | 'image' | 'video';
export interface OutboxEntry {
    kind: OutboxEntryKind;
    /** Lower sends first. */
    priority: number;
    /** Destination peer (the WeChat sender id or group:<roomId>). */
    to?: string;
    text?: string;
    item?: MessageItem;
    /** For kind 'file'/'image'/'video': the local artifact to upload and send. */
    media?: {
        filePath: string;
        fileName: string;
    };
    /** Progress coalescing: a newer entry replaces a queued older one. */
    coalesceKey?: string;
    createdAt: number;
    /** Transport-level failures re-enqueue up to this many times. */
    retryCount?: number;
    /**
     * MUST-DELIVER marker: if this entry is dropped (retries exhausted while
     * the channel is down), its text is recorded for re-push on the peer's
     * next inbound message (approval prompts, final answers, error/stop
     * notices — see core.retryCriticalMessages). The channel is demonstrably
     * alive exactly when the user speaks, so the resend lands.
     */
    resendOnRecovery?: boolean;
}
export declare const OUTBOX_PRIORITY: {
    readonly system: 10;
    readonly text: 20;
    readonly tool: 25;
    readonly progress: 30;
};
/** Max attempts (1 send + this many retries) for transport-level failures. */
export declare const OUTBOX_MAX_ATTEMPTS = 3;
/**
 * Max attempts for the ret=-2 rate-limit/session-class error (protocol.md §5).
 * Larger than the transport budget because the channel needs a real cooldown
 * window (10s→30s→60s→60s) before a retry can succeed — 3 attempts would give
 * up after only 40s and silently lose a message the server never rejected.
 */
export declare const OUTBOX_RATE_LIMIT_MAX_ATTEMPTS = 5;
export interface OutboxOptions {
    minIntervalMs: number;
    backoffSecs: number[];
    sessionExpiredPauseMs: number;
    send: (entry: OutboxEntry) => Promise<SendResult>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onPause?: (until: number, reason: 'rate-limit' | 'session-expired') => void;
    onDrop?: (outboxEntry: OutboxEntry, reason: 'coalesced' | 'disposed' | 'failed', result?: SendResult) => void;
    /**
     * Sliding-window send budget: at most `maxPerWindow` sends in any
     * `windowMs` span. Extra entries wait in the queue (never dropped) until
     * the window rolls. The channel's server-side quota is NOT public — the
     * 2026-08-18 incident showed ~5-10 sends per session window followed by
     * `prepare failed` for minutes, so the client must throttle itself below
     * whatever the server allows. Default: none (unlimited).
     */
    budget?: {
        windowMs: number;
        maxPerWindow: number;
    };
}
export declare class Outbox {
    private readonly opts;
    private readonly onPause?;
    private readonly onDrop?;
    private readonly budget?;
    private queue;
    private coalesced;
    /** -Infinity: the first send needs no inter-message spacing. */
    private lastSendAt;
    private backoffIdx;
    private pausedUntil;
    private pumping;
    private disposed;
    /** Timestamps of sends inside the current budget window (sliding). */
    private budgetSends;
    constructor(opts: OutboxOptions);
    enqueue(entry: OutboxEntry): void;
    private sortQueue;
    pendingCount(): number;
    getPausedUntil(): number | null;
    /** Wait until the queue is empty and no pause remains (tests/dispose). */
    drain(): Promise<void>;
    dispose(): void;
    private pump;
    /**
     * Classify a send result. Returns true when the entry was re-enqueued for
     * retry; false when the entry is settled (delivered, paused, or dropped).
     */
    private handleResult;
    /** Escalating backoff seconds for rate-limit-class errors, shared with -12. */
    private nextBackoffSecs;
}
//# sourceMappingURL=outbox.d.ts.map