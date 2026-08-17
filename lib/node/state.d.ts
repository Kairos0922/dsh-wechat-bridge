/**
 * Persistent bridge state: session/model/cwd preferences and the per-peer
 * active-session binding.
 *
 * Preferences are bridge-local (decision: never mutate the deployment's
 * global default model); they apply to sessions created afterwards. Peer
 * bindings make multi-friend routing deterministic: replies always return to
 * the peer that owns the active session, not whoever spoke last.
 *
 * Written atomically (tmp + rename) on a debounce; every timer unref'd.
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
}
/** Validate an unknown JSON value into a usable state (never throws). */
export declare function sanitizeState(value: unknown): BridgeStateData;
export declare class BridgeState {
    private readonly peerPrefs;
    private readonly pairedUserIds;
    private readonly file;
    private readonly debounceMs;
    private peerSessions;
    private sessionOwners;
    private contextTokens;
    private timer;
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
    /**
     * This peer's preferences: own bucket, falling back to the migrated legacy
     * `default` bucket so the original single-user settings keep applying.
     */
    getPrefs(peerId: string): BridgePrefs;
    /** Record a pairing-confirmed WeChat id (idempotent, never displaces). */
    addPairedUserId(userId: string): void;
    /** All pairing-confirmed WeChat ids. */
    listPairedUserIds(): string[];
    /** Whether this peer has any history (message context or session binding). */
    hasPeerHistory(peerId: string): boolean;
    /**
     * Update one peer's prefs. An empty string DELETES the key ('' must mean
     * "follow the default" — a stored '' would shadow the config-level
     * fallback chain).
     */
    setPrefs(peerId: string, next: Partial<BridgePrefs>): void;
    toJSON(): BridgeStateData;
    private schedule;
    private flush;
    /** Flush pending writes and stop timers. */
    dispose(): void;
}
//# sourceMappingURL=state.d.ts.map