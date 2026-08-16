/**
 * Media retention: deletes media/export files older than N days.
 * Cache-like files the bridge produced itself (inbound images, exports,
 * card artifacts) — never user data. Runs once shortly after mount and then
 * daily; the returned disposer cancels the chain.
 *
 * @module dsh-wechat-bridge/node/retention
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultMediaDir } from "./inbound.js";
/** Pure selection rule for tests: which files are older than the TTL. */
export function selectExpiredFiles(files, nowMs, ttlMs) {
    return files.filter((file) => nowMs - file.mtimeMs > ttlMs).map((file) => file.path);
}
/** Recursively collect regular files under dir with their mtime. */
export function collectFiles(dir) {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectFiles(full));
        }
        else if (entry.isFile()) {
            try {
                out.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
            }
            catch {
                // raced deletion — skip
            }
        }
    }
    return out;
}
export const RETENTION_TICK_MS = 24 * 60 * 60 * 1000;
/**
 * Attach the daily cleanup sweep. Deletes expired files (empty directories
 * left behind are harmless — the media dir is append-only). Never touches
 * anything outside the media dir.
 */
export function attachMediaRetention(node) {
    const mediaDir = node.resolved.mediaDir ?? defaultMediaDir();
    if (node.resolved.mediaRetentionDays <= 0)
        return () => { };
    let disposed = false;
    let timer = null;
    const sweep = () => {
        try {
            const ttlMs = node.resolved.mediaRetentionDays * 24 * 60 * 60 * 1000;
            const expired = selectExpiredFiles(collectFiles(mediaDir), Date.now(), ttlMs);
            for (const file of expired) {
                try {
                    fs.unlinkSync(file);
                }
                catch {
                    // best-effort
                }
            }
            if (expired.length > 0) {
                node.ctx.logger.info('[dsh-wechat-bridge] media retention removed %d file(s)', expired.length);
            }
        }
        catch (err) {
            node.ctx.logger.warn('[dsh-wechat-bridge] media retention sweep failed: %s', String(err));
        }
        if (!disposed) {
            timer = setTimeout(sweep, RETENTION_TICK_MS);
            timer.unref?.();
        }
    };
    timer = setTimeout(sweep, 60_000); // first sweep one minute after mount
    timer.unref?.();
    return () => {
        disposed = true;
        if (timer !== null)
            clearTimeout(timer);
    };
}
//# sourceMappingURL=retention.js.map