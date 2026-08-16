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
export declare function debugLog(event: Record<string, unknown>): void;
/**
 * Capture a FULL inbound media item verbatim (no truncation). The debug log
 * only keeps a 1200-char digest; this sink preserves the complete official
 * client outbound shape — including the full encrypt_query_param, thumb_media
 * and any field the digest would hide — for byte-level comparison against our
 * own sends (docs/porting-notes.md §6). Append-only JSONL, capped tail.
 */
export declare function debugLogMediaCapture(event: {
    msgId?: number | string | null;
    item: unknown;
}): void;
//# sourceMappingURL=debug-log.d.ts.map