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
    prefs: BridgePrefs;
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
    prefs: BridgePrefs;
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
     * Update prefs. An empty string DELETES the key ('' must mean "follow the
     * default" — a stored '' would shadow the config-level fallback chain).
     */
    setPrefs(next: Partial<BridgePrefs>): void;
    toJSON(): BridgeStateData;
    private schedule;
    private flush;
    /** Flush pending writes and stop timers. */
    dispose(): void;
}
//# sourceMappingURL=state.d.ts.map