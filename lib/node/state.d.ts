/**
 * Persistent bridge state: session/model/cwd preferences and the per-peer
 * active-session binding.
 *
 * Preferences are bridge-local (decision: never mutate the deployment's
 * global default model); they apply to sessions created afterwards. Peer
 * bindings make multi-friend routing deterministic: replies always return to
 * the peer that owns the active session, not whoever spoke last.
 *
 * Written atomically (tmp + rename) on a debounce; writes are owner-only
 * (0600 file / 0700 dir), existing files are self-healed to 0600 on load, and
 * a failed write keeps the pending flag and retries with backoff. Every timer
 * unref'd.
 *
 * @module dsh-wechat-bridge/node/state
 */
export interface BridgePrefs {
    /** Provider route for `/new` sessions (absent = deployment default). */
    provider?: string;
    /** Model id for `/new` sessions (absent = deployment default). */
    model?: string;
    /** Working directory for `/new` sessions (absent = config cwd). */
    cwd?: string;
    /** Show reasoning excerpts in the thinking digest (default off). */
    thinking?: boolean;
}
export interface BridgeStateData {
    version: 1;
    /**
     * Per-peer preferences (provider/model/cwd/thinking). Each WeChat user's
     * `/model` `/workspace` `/thinking` choices are isolated. The legacy
     * single-user `prefs` field (pre-multi-user) migrates into the `default`
     * bucket: a peer without its own prefs falls back to it, so the original
     * owner keeps their settings after upgrade.
     */
    peerPrefs: Record<string, BridgePrefs>;
    /** Legacy single-user prefs — migrated into `peerPrefs['default']`. */
    prefs?: BridgePrefs;
    /**
     * Every WeChat id that ever confirmed a pairing QR — each scan adds its
     * scanner (multi-user: anyone who scans becomes trusted; a later scan
     * never displaces an earlier one). This is the "scan = trust" boundary.
     */
    pairedUserIds: string[];
    /** peerId → active session id. */
    peerSessions: Record<string, string>;
    /** sessionId → owning peer id (survives restart for reply routing). */
    sessionOwners: Record<string, string>;
    /**
     * sessionId → peer id that created it. Survives restart so `/close` and
     * orphan handling can tell who may reclaim a session. Old state files
     * simply lack the map — consumers treat an absent creator as 'legacy'
     * (the state layer never writes a 'legacy' literal).
     */
    sessionCreators: Record<string, string>;
    /**
     * Sessions released by `/close`: permanently ineligible for orphan
     * adoption, even if the session still exists in the deployment.
     */
    releasedSessions: string[];
    /**
     * peerId → latest iLink context token. The official client persists these
     * per account; without them, sends after a restart carry no context_token
     * and the WeChat client may not associate them to a conversation window.
     */
    contextTokens: Record<string, string>;
}
export declare function defaultStateFile(): string;
export interface BridgeStateOptions {
    file?: string;
    debounceMs?: number;
    /** Delay between failed flush attempts (default 5s; at most 3 retries). */
    retryMs?: number;
    /** Warn sink for non-fatal persistence issues (default console.warn). */
    logger?: (message: string) => void;
}
/** Validate an unknown JSON value into a usable state (never throws). */
export declare function sanitizeState(value: unknown): BridgeStateData;
export declare class BridgeState {
    private readonly peerPrefs;
    private readonly pairedUserIds;
    private readonly file;
    private readonly debounceMs;
    private readonly retryMs;
    private readonly warn;
    private peerSessions;
    private sessionOwners;
    private sessionCreators;
    private releasedSessions;
    private contextTokens;
    private timer;
    private retryTimer;
    private retryCount;
    private dirty;
    private disposed;
    constructor(opts?: BridgeStateOptions);
    getPeerSession(peerId: string): string | null;
    setPeerSession(peerId: string, sessionId: string | null): void;
    listPeerSessions(): Array<[string, string]>;
    getSessionOwner(sessionId: string): string | null;
    setSessionOwner(sessionId: string, peerId: string | null): void;
    listSessionOwners(): Array<[string, string]>;
    getContextToken(peerId: string): string | null;
    setContextToken(peerId: string, token: string | null): void;
    listContextTokens(): Array<[string, string]>;
    /** The peer id that created a session (undefined = created before creators
     * were tracked — consumers treat that as 'legacy'). */
    getSessionCreator(sessionId: string): string | undefined;
    setSessionCreator(sessionId: string, peerId: string): void;
    /** Permanently mark a session as released by `/close` — never adoptable. */
    markSessionReleased(sessionId: string): void;
    isSessionReleased(sessionId: string): boolean;
    /**
     * This peer's preferences: own bucket, falling back to the migrated legacy
     * `default` bucket so the original single-user settings keep applying.
     */
    getPrefs(peerId: string): BridgePrefs;
    /** Record a pairing-confirmed WeChat id (idempotent, never displaces). */
    addPairedUserId(userId: string): void;
    /** All pairing-confirmed WeChat ids. */
    listPairedUserIds(): string[];
    /** Forget a paired WeChat id (its session artifacts stay until cleared). */
    removePairedUserId(userId: string): void;
    /** Whether this peer has any history (message context or session binding). */
    hasPeerHistory(peerId: string): boolean;
    /**
     * Remove every trace of a peer: its active-session binding, its context
     * token, and every session it owns (cascade). Other peers are untouched.
     */
    clearPeerArtifacts(peerId: string): void;
    /**
     * Update one peer's prefs. An empty string DELETES the key ('' must mean
     * "follow the default" — a stored '' would shadow the config-level
     * fallback chain).
     */
    setPrefs(peerId: string, next: Partial<BridgePrefs>): void;
    toJSON(): BridgeStateData;
    private schedule;
    private flush;
    private scheduleRetry;
    /** Flush pending writes and stop timers. */
    dispose(): void;
}
//# sourceMappingURL=state.d.ts.map