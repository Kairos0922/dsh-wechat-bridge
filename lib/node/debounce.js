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
import { ITEM_TEXT } from "../gateway/types.js";
/** Conversation key: per sender 1:1, per (room, sender) in groups. */
export function debounceKey(payload) {
    const room = String(payload.message.group_id ?? payload.message.room_id ?? payload.message.chat_room_id ?? '').trim();
    return room ? `group:${room}:${payload.senderId}` : payload.senderId;
}
/** Whether every item in the message is plain text (no media to flush). */
export function isTextOnly(message) {
    const items = message.item_list ?? [];
    return items.length > 0 && items.every((item) => item?.type === ITEM_TEXT);
}
export class InboundDebouncer {
    buffers = new Map();
    opts;
    constructor(opts) {
        this.opts = {
            windowMs: opts.windowMs,
            onFlush: opts.onFlush,
            setTimer: opts.setTimer ??
                ((fn, ms) => {
                    const t = setTimeout(fn, ms);
                    t.unref?.();
                    return t;
                }),
            clearTimer: opts.clearTimer ?? ((t) => clearTimeout(t)),
        };
    }
    /**
     * Admit one inbound payload. Returns the payloads that must be dispatched
     * NOW in order (0, 1, or 2 entries):
     * - debouncing disabled → [payload];
     * - text-only payload → [] (buffered; combined payload emitted via onFlush);
     * - media payload → [flushedBuffer?, payload] (buffer flushed first).
     */
    admit(payload) {
        if (this.opts.windowMs <= 0)
            return [payload];
        const key = debounceKey(payload);
        if (!isTextOnly(payload.message)) {
            const flushed = this.take(key);
            return flushed ? [flushed, payload] : [payload];
        }
        const buffer = this.buffers.get(key);
        if (!buffer) {
            const timer = this.opts.setTimer(() => {
                const combined = this.take(key);
                if (combined)
                    this.opts.onFlush(combined);
            }, this.opts.windowMs);
            this.buffers.set(key, { texts: [extractText(payload.message)], last: payload, timer });
            return [];
        }
        // Window still open: append the text and keep the latest payload as the
        // metadata carrier (ids/tokens/runId — upstream uses the most recent
        // message for reply threading). The timer is NOT reset: a bounded window
        // guarantees the combined turn dispatches at most one window after the
        // FIRST message, so a chatty sender cannot push the reply indefinitely.
        buffer.texts.push(extractText(payload.message));
        buffer.last = payload;
        return [];
    }
    /** Take (and clear) the combined payload for a key, if one is buffered. */
    take(key) {
        const buffer = this.buffers.get(key);
        if (!buffer)
            return null;
        this.buffers.delete(key);
        this.opts.clearTimer(buffer.timer);
        const joined = buffer.texts.map((t) => t.trim()).filter(Boolean).join('\n');
        const message = {
            ...buffer.last.message,
            item_list: [{ type: ITEM_TEXT, text_item: { text: joined } }],
        };
        return { ...buffer.last, message };
    }
    /**
     * Drop all pending buffers (plugin teardown). Returns the raw texts that
     * were lost so the caller can log them — they are already seen-marked, so
     * dropping here means they never reach the agent.
     */
    /** Flush all pending buffers synchronously during teardown. */
    flushAll() {
        const ready = [];
        for (const key of this.buffers.keys()) {
            const payload = this.take(key);
            if (payload)
                ready.push(payload);
        }
        return ready;
    }
    dispose() {
        const dropped = [];
        for (const [key, buffer] of this.buffers) {
            this.opts.clearTimer(buffer.timer);
            dropped.push({ key, texts: buffer.texts });
        }
        this.buffers.clear();
        return dropped;
    }
}
/** Pull the concatenated plain text out of a message (pre-quote-strip). */
function extractText(message) {
    return (message.item_list ?? [])
        .filter((item) => item?.type === ITEM_TEXT)
        .map((item) => item.text_item?.text ?? '')
        .join('');
}
//# sourceMappingURL=debounce.js.map