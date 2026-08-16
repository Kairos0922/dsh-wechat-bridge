/**
 * Media retention: deletes media/export files older than N days.
 * Cache-like files the bridge produced itself (inbound images, exports,
 * card artifacts) — never user data. Runs once shortly after mount and then
 * daily; the returned disposer cancels the chain.
 *
 * @module dsh-wechat-bridge/node/retention
 */
import type { WechatBridgeNode } from './core.ts';
/** Pure selection rule for tests: which files are older than the TTL. */
export declare function selectExpiredFiles(files: Array<{
    path: string;
    mtimeMs: number;
}>, nowMs: number, ttlMs: number): string[];
/** Recursively collect regular files under dir with their mtime. */
export declare function collectFiles(dir: string): Array<{
    path: string;
    mtimeMs: number;
}>;
export declare const RETENTION_TICK_MS: number;
/**
 * Attach the daily cleanup sweep. Deletes expired files (empty directories
 * left behind are harmless — the media dir is append-only). Never touches
 * anything outside the media dir.
 */
export declare function attachMediaRetention(node: WechatBridgeNode): () => void;
//# sourceMappingURL=retention.d.ts.map