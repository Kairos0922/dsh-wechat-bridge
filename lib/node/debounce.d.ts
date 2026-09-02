/**
 * Inbound text debouncer (OpenClaw 2.0 "messages.inbound.debounceMs"
 * alignment). WeChat users habitually send several short texts in a row;
 * without coalescing each one becomes its own serialized agent turn — slow,
 * and it burns tokens on fragmented context. Rapid TEXT-ONLY messages from
 * the same conversation are joined into one turn within a short window;
 * media/voice/file payloads flush any pending buffer immediately (ordering
 * preserved) and dispatch themselves at once — upstream's "media flushes
 * immediately" rule.
 *
 * Pure unit: injectable timer/now seams mirror SeenSet's clock injection so
 * the window logic is testable without real timers.
 *
 * @module dsh-wechat-bridge/node/debounce
 */
import { type InboundMessage } from '../gateway/types.ts';
import type { InboundEvent } from '../gateway/types.ts';
export interface DebounceOptions {
    /** Coalescing window in ms. <= 0 disables debouncing entirely. */
    windowMs: number;
    /** Called with the combined payload when a buffer's window expires. */
    onFlush: (payload: InboundEvent) => void;
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
/** Conversation key: per sender 1:1, per (room, sender) in groups. */
export declare function debounceKey(payload: InboundEvent): string;
/** Whether every item in the message is plain text (no media to flush). */
export declare function isTextOnly(message: InboundMessage): boolean;
export declare class InboundDebouncer {
    private readonly buffers;
    private readonly opts;
    constructor(opts: DebounceOptions);
    /**
     * Admit one inbound payload. Returns the payloads that must be dispatched
     * NOW in order (0, 1, or 2 entries):
     * - debouncing disabled → [payload];
     * - text-only payload → [] (buffered; combined payload emitted via onFlush);
     * - media payload → [flushedBuffer?, payload] (buffer flushed first).
     */
    admit(payload: InboundEvent): InboundEvent[];
    /** Take (and clear) the combined payload for a key, if one is buffered. */
    take(key: string): InboundEvent | null;
    /**
     * Drop all pending buffers (plugin teardown). Returns the raw texts that
     * were lost so the caller can log them — they are already seen-marked, so
     * dropping here means they never reach the agent.
     */
    /** Flush all pending buffers synchronously during teardown. */
    flushAll(): InboundEvent[];
    dispose(): Array<{
        key: string;
        texts: string[];
    }>;
}
//# sourceMappingURL=debounce.d.ts.map