/**
 * Bridge debug log — a tiny append-only JSONL sink under the DSH storages
 * dir. ctx.logger output does not reach the web profile's log file, so the
 * bridge keeps its own operational trace for field diagnosis.
 *
 * Path: $DSH_HOME/storages/dsh-wechat-bridge/debug.log (capped, tail-kept).
 * Never throws: diagnostics must not break the bridge.
 *
 * @module dsh-wechat-bridge/debug-log
 */
/**
 * P2-4: generic deep redaction for debug sinks — previously each call site
 * redacted by hand (context tokens, aes keys) and a new log point could
 * silently leak a credential. Walks plain objects/arrays only, masks values
 * under credential keys, and is a no-op on everything else.
 */
export declare function redactDeep<T>(value: T, depth?: number): T;
export declare function debugLog(event: Record<string, unknown>): void;
/**
 * Append to the key-event sink (events.jsonl). Use for facts that must
 * survive chunk-heavy sessions: inbound, send outcomes, poll health, notify,
 * approval lifecycle. Same capped-tail semantics as debug.log. Values under
 * credential keys are masked generically (P2-4) — call sites no longer have
 * to remember.
 */
export declare function debugLogEvent(event: Record<string, unknown>): void;
/**
 * Capture a FULL inbound media item verbatim (no truncation). The debug log
 * only keeps a 1200-char digest; this sink preserves the complete official
 * client outbound shape — including thumb_media and any field the digest
 * would hide — for byte-level comparison against our own sends
 * (docs/porting-notes.md §6). AES keys are redacted upstream
 * (gateway redactItemForCapture); encrypt_query_param values are replaced
 * with a shape-preserving mask here. Append-only JSONL, capped tail.
 * ⚠ The sink is under $DSH_HOME (0700 storages) — treat as sensitive, do not
 * paste into issues.
 */
export declare function debugLogMediaCapture(event: {
    msgId?: number | string | null;
    item: unknown;
}): void;
//# sourceMappingURL=debug-log.d.ts.map