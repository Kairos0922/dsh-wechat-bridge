/**
 * Durable inbound message dedup.
 *
 * The poll cursor (get_updates_buf) lives only in memory, so a restart can
 * make the server re-deliver recent messages. Feeding them to agents twice is
 * a correctness bug (double tool execution), so seen message ids are
 * persisted here with a TTL — the write-through survival of the gateway's
 * in-memory dedup.
 *
 * @module dsh-wechat-bridge/seen
 */
export declare const DEFAULT_SEEN_TTL_MS: number;
export declare const DEFAULT_SEEN_CAP = 2000;
/** Pure in-memory TTL set — clock-injectable for tests. */
export declare class SeenSet {
    private readonly ttlMs;
    private readonly cap;
    private readonly nowFn;
    private entries;
    constructor(opts?: {
        ttlMs?: number;
        cap?: number;
        now?: () => number;
    });
    /** Whether the id was seen within the TTL. Expired entries are pruned. */
    has(id: number): boolean;
    mark(id: number): void;
    prune(): void;
    get size(): number;
    snapshot(): Array<[number, number]>;
    restore(snapshot: Array<[number, number]>): void;
}
/** Default seen-file location under the bridge's storage dir. */
export declare function defaultSeenFile(): string;
/**
 * Persisted {@link SeenSet}: loads the file at open, writes atomically on a
 * debounce, flushes on dispose. All timers are unref'd.
 */
export declare class SeenStore {
    private readonly set;
    private readonly file;
    private readonly debounceMs;
    private timer;
    private dirty;
    private disposed;
    constructor(opts?: {
        file?: string;
        ttlMs?: number;
        cap?: number;
        debounceMs?: number;
    });
    has(id: number): boolean;
    mark(id: number): void;
    get size(): number;
    private schedule;
    private flush;
    dispose(): void;
}
//# sourceMappingURL=seen.d.ts.map