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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const MAX_BYTES = 512 * 1024;
/** Full-fidelity media capture cap — items can be a few KB each (2MB tail). */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
/**
 * Key operational events (inbound/send/poll/notify/approval) live in their
 * own capped sink: debug.log is also capped but assistant/chunk session
 * events fill it within minutes, rolling the facts needed for field
 * diagnosis out of the window (2026-08-18 incident).
 */
const MAX_EVENT_BYTES = 512 * 1024;
function debugFilePath() {
    const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
    return path.join(home, 'storages', 'dsh-wechat-bridge', 'debug.log');
}
/** Dedicated sink for FULL inbound media items (outbound-shape ground truth). */
function mediaCaptureFilePath() {
    const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
    return path.join(home, 'storages', 'dsh-wechat-bridge', 'media-captures.jsonl');
}
/** Dedicated sink for KEY operational events (inbound/send/poll/notify/approval). */
function eventsFilePath() {
    const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
    return path.join(home, 'storages', 'dsh-wechat-bridge', 'events.jsonl');
}
export function debugLog(event) {
    try {
        const file = debugFilePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
        fs.appendFileSync(file, line);
        if (fs.statSync(file).size > MAX_BYTES) {
            // Keep the tail: the most recent records matter most for diagnosis.
            fs.writeFileSync(file, fs.readFileSync(file).subarray(-Math.floor(MAX_BYTES / 2)));
        }
    }
    catch {
        // diagnostics are best-effort only
    }
}
/**
 * Append to the key-event sink (events.jsonl). Use for facts that must
 * survive chunk-heavy sessions: inbound, send outcomes, poll health, notify,
 * approval lifecycle. Same capped-tail semantics as debug.log.
 */
export function debugLogEvent(event) {
    try {
        const file = eventsFilePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
        fs.appendFileSync(file, line);
        if (fs.statSync(file).size > MAX_EVENT_BYTES) {
            fs.writeFileSync(file, fs.readFileSync(file).subarray(-Math.floor(MAX_EVENT_BYTES / 2)));
        }
    }
    catch {
        // diagnostics are best-effort only
    }
}
/**
 * Capture a FULL inbound media item verbatim (no truncation). The debug log
 * only keeps a 1200-char digest; this sink preserves the complete official
 * client outbound shape — including the full encrypt_query_param, thumb_media
 * and any field the digest would hide — for byte-level comparison against our
 * own sends (docs/porting-notes.md §6). Append-only JSONL, capped tail.
 */
export function debugLogMediaCapture(event) {
    try {
        const file = mediaCaptureFilePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const line = JSON.stringify({ ts: new Date().toISOString(), msgId: event.msgId ?? null, item: event.item }) + '\n';
        fs.appendFileSync(file, line);
        if (fs.statSync(file).size > MAX_CAPTURE_BYTES) {
            fs.writeFileSync(file, fs.readFileSync(file).subarray(-Math.floor(MAX_CAPTURE_BYTES / 2)));
        }
    }
    catch {
        // diagnostics are best-effort only
    }
}
//# sourceMappingURL=debug-log.js.map