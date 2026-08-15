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
function debugFilePath() {
    const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
    return path.join(home, 'storages', 'dsh-wechat-bridge', 'debug.log');
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
//# sourceMappingURL=debug-log.js.map