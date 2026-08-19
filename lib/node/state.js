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
import fs from 'node:fs';
import path from 'node:path';
import { resolveDshHome } from "../home.js";
/**
 * A session id is always the bridge's own `wechat-` namespaced form (see
 * `newSessionId()`: `wechat-<base36-ts>-<base36-rand>`). Anything else is
 * untrusted garbage — M10 drops such entries at sanitize time instead of
 * trusting them as routing keys.
 */
const SESSION_ID_RE = /^wechat-[0-9a-z-]+$/;
/**
 * A peer id is a WeChat contact id string: non-empty, bounded, and free of
 * control characters that could smuggle bytes into paths or log lines.
 */
const PEER_ID_MAX_LENGTH = 128;
const PEER_ID_FORBIDDEN_RE = /[\0\n\r]/;
function isSessionId(value) {
    return typeof value === 'string' && SESSION_ID_RE.test(value);
}
function isPeerId(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= PEER_ID_MAX_LENGTH &&
        !PEER_ID_FORBIDDEN_RE.test(value));
}
/** Flush write-retry: 5s apart, at most 3 retries after the first failure. */
const FLUSH_RETRY_DELAY_MS = 5_000;
const FLUSH_RETRY_MAX_ATTEMPTS = 3;
export function defaultStateFile() {
    return path.join(resolveDshHome(), 'storages', 'dsh-wechat-bridge', 'state.json');
}
/** Validate an unknown JSON value into a usable state (never throws). */
export function sanitizeState(value) {
    const base = {
        version: 1,
        peerPrefs: {},
        pairedUserIds: [],
        peerSessions: {},
        sessionOwners: {},
        sessionCreators: {},
        releasedSessions: [],
        contextTokens: {},
    };
    if (typeof value !== 'object' || value === null)
        return base;
    const record = value;
    const cleanPrefs = (raw) => {
        const prefs = {};
        if (typeof raw === 'object' && raw !== null) {
            const p = raw;
            if (typeof p.provider === 'string' && p.provider)
                prefs.provider = p.provider;
            if (typeof p.model === 'string' && p.model)
                prefs.model = p.model;
            if (typeof p.cwd === 'string' && p.cwd)
                prefs.cwd = p.cwd;
            if (typeof p.thinking === 'boolean')
                prefs.thinking = p.thinking;
        }
        return prefs;
    };
    // New layout: per-peer prefs. Legacy single-user `prefs` migrates into the
    // `default` bucket so the original owner keeps their model/workspace choices.
    const peerPrefs = {};
    const rawPeerPrefs = record.peerPrefs;
    if (typeof rawPeerPrefs === 'object' && rawPeerPrefs !== null) {
        for (const [peer, raw] of Object.entries(rawPeerPrefs)) {
            if (!peer)
                continue;
            const prefs = cleanPrefs(raw);
            if (Object.keys(prefs).length > 0)
                peerPrefs[peer] = prefs;
        }
    }
    const legacy = cleanPrefs(record.prefs);
    if (Object.keys(legacy).length > 0 && Object.keys(peerPrefs).length === 0) {
        peerPrefs.default = legacy;
    }
    else if (Object.keys(legacy).length > 0 && peerPrefs.default === undefined) {
        peerPrefs.default = legacy;
    }
    const pairedUserIds = [];
    const rawPaired = record.pairedUserIds;
    if (Array.isArray(rawPaired)) {
        for (const id of rawPaired) {
            if (isPeerId(id) && !pairedUserIds.includes(id))
                pairedUserIds.push(id);
        }
    }
    const peerSessions = {};
    const rawPeers = record.peerSessions;
    if (typeof rawPeers === 'object' && rawPeers !== null) {
        for (const [peer, session] of Object.entries(rawPeers)) {
            if (isPeerId(peer) && isSessionId(session))
                peerSessions[peer] = session;
        }
    }
    const sessionOwners = {};
    const rawOwners = record.sessionOwners;
    if (typeof rawOwners === 'object' && rawOwners !== null) {
        for (const [session, peer] of Object.entries(rawOwners)) {
            if (isSessionId(session) && isPeerId(peer))
                sessionOwners[session] = peer;
        }
    }
    const sessionCreators = {};
    const rawCreators = record.sessionCreators;
    if (typeof rawCreators === 'object' && rawCreators !== null) {
        for (const [session, creator] of Object.entries(rawCreators)) {
            if (isSessionId(session) && isPeerId(creator))
                sessionCreators[session] = creator;
        }
    }
    const releasedSessions = [];
    const rawReleased = record.releasedSessions;
    if (Array.isArray(rawReleased)) {
        for (const session of rawReleased) {
            if (isSessionId(session) && !releasedSessions.includes(session))
                releasedSessions.push(session);
        }
    }
    const contextTokens = {};
    const rawTokens = record.contextTokens;
    if (typeof rawTokens === 'object' && rawTokens !== null) {
        for (const [peer, token] of Object.entries(rawTokens)) {
            if (typeof peer === 'string' && typeof token === 'string' && peer && token)
                contextTokens[peer] = token;
        }
    }
    return {
        version: 1,
        peerPrefs,
        pairedUserIds,
        peerSessions,
        sessionOwners,
        sessionCreators,
        releasedSessions,
        contextTokens,
    };
}
export class BridgeState {
    peerPrefs = new Map();
    pairedUserIds = new Set();
    file;
    debounceMs;
    retryMs;
    warn;
    peerSessions = new Map();
    sessionOwners = new Map();
    sessionCreators = new Map();
    releasedSessions = new Set();
    contextTokens = new Map();
    timer = null;
    retryTimer = null;
    retryCount = 0;
    dirty = false;
    disposed = false;
    constructor(opts = {}) {
        this.file = opts.file ?? defaultStateFile();
        this.debounceMs = opts.debounceMs ?? 3_000;
        this.retryMs = opts.retryMs ?? FLUSH_RETRY_DELAY_MS;
        this.warn = opts.logger ?? ((message) => console.warn(message));
        let loaded = {
            version: 1,
            peerPrefs: {},
            pairedUserIds: [],
            peerSessions: {},
            sessionOwners: {},
            sessionCreators: {},
            releasedSessions: [],
            contextTokens: {},
        };
        try {
            // Self-heal an existing state file to owner-only permissions (M7).
            // chmod failure only warns: loading must never break because of it.
            if (fs.existsSync(this.file)) {
                try {
                    fs.chmodSync(this.file, 0o600);
                }
                catch (error) {
                    this.warn(`[dsh-wechat-bridge] could not tighten permissions on ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            const raw = fs.readFileSync(this.file, 'utf-8');
            const parsed = JSON.parse(raw);
            // Version tolerance (LOW): a missing version is treated as 1; any other
            // version warns visibly but still loads the known fields — never reject,
            // forward compatible.
            if (typeof parsed === 'object' && parsed !== null) {
                const version = parsed.version;
                if (version !== undefined && version !== 1) {
                    this.warn(`[dsh-wechat-bridge] state file ${this.file} has unsupported version ${String(version)} (expected 1); loading known fields only`);
                }
            }
            loaded = sanitizeState(parsed);
        }
        catch {
            // absent or unreadable = fresh state; never fatal
        }
        for (const id of loaded.pairedUserIds)
            this.pairedUserIds.add(id);
        this.peerPrefs.set('default', loaded.peerPrefs.default ?? {});
        for (const [peer, prefs] of Object.entries(loaded.peerPrefs)) {
            if (peer !== 'default')
                this.peerPrefs.set(peer, prefs);
        }
        this.peerSessions = new Map(Object.entries(loaded.peerSessions));
        this.sessionOwners = new Map(Object.entries(loaded.sessionOwners));
        this.sessionCreators = new Map(Object.entries(loaded.sessionCreators));
        for (const id of loaded.releasedSessions)
            this.releasedSessions.add(id);
        this.contextTokens = new Map(Object.entries(loaded.contextTokens));
    }
    getPeerSession(peerId) {
        return this.peerSessions.get(peerId) ?? null;
    }
    setPeerSession(peerId, sessionId) {
        if (sessionId === null) {
            if (this.peerSessions.delete(peerId))
                this.schedule();
            return;
        }
        if (this.peerSessions.get(peerId) !== sessionId) {
            this.peerSessions.set(peerId, sessionId);
            this.schedule();
        }
    }
    listPeerSessions() {
        return [...this.peerSessions.entries()];
    }
    getSessionOwner(sessionId) {
        return this.sessionOwners.get(sessionId) ?? null;
    }
    setSessionOwner(sessionId, peerId) {
        if (peerId === null) {
            if (this.sessionOwners.delete(sessionId))
                this.schedule();
            return;
        }
        if (this.sessionOwners.get(sessionId) !== peerId) {
            this.sessionOwners.set(sessionId, peerId);
            this.schedule();
        }
    }
    listSessionOwners() {
        return [...this.sessionOwners.entries()];
    }
    getContextToken(peerId) {
        return this.contextTokens.get(peerId) ?? null;
    }
    setContextToken(peerId, token) {
        if (token === null) {
            if (this.contextTokens.delete(peerId))
                this.schedule();
            return;
        }
        if (this.contextTokens.get(peerId) !== token) {
            this.contextTokens.set(peerId, token);
            this.schedule();
        }
    }
    listContextTokens() {
        return [...this.contextTokens.entries()];
    }
    /** The peer id that created a session (undefined = created before creators
     * were tracked — consumers treat that as 'legacy'). */
    getSessionCreator(sessionId) {
        return this.sessionCreators.get(sessionId);
    }
    setSessionCreator(sessionId, peerId) {
        if (this.sessionCreators.get(sessionId) !== peerId) {
            this.sessionCreators.set(sessionId, peerId);
            this.schedule();
        }
    }
    /** Permanently mark a session as released by `/close` — never adoptable. */
    markSessionReleased(sessionId) {
        if (this.releasedSessions.has(sessionId))
            return;
        this.releasedSessions.add(sessionId);
        this.schedule();
    }
    isSessionReleased(sessionId) {
        return this.releasedSessions.has(sessionId);
    }
    /**
     * This peer's preferences: own bucket, falling back to the migrated legacy
     * `default` bucket so the original single-user settings keep applying.
     */
    getPrefs(peerId) {
        return this.peerPrefs.get(peerId) ?? this.peerPrefs.get('default') ?? {};
    }
    /** Record a pairing-confirmed WeChat id (idempotent, never displaces). */
    addPairedUserId(userId) {
        if (!userId || this.pairedUserIds.has(userId))
            return;
        this.pairedUserIds.add(userId);
        this.schedule();
    }
    /** All pairing-confirmed WeChat ids. */
    listPairedUserIds() {
        return [...this.pairedUserIds];
    }
    /** Forget a paired WeChat id (its session artifacts stay until cleared). */
    removePairedUserId(userId) {
        if (this.pairedUserIds.delete(userId))
            this.schedule();
    }
    /** Whether this peer has any history (message context or session binding). */
    hasPeerHistory(peerId) {
        return this.contextTokens.has(peerId) || this.peerSessions.has(peerId);
    }
    /**
     * Remove every trace of a peer: its active-session binding, its context
     * token, and every session it owns (cascade). Other peers are untouched.
     */
    clearPeerArtifacts(peerId) {
        let changed = false;
        if (this.peerSessions.delete(peerId))
            changed = true;
        if (this.contextTokens.delete(peerId))
            changed = true;
        for (const [session, owner] of [...this.sessionOwners.entries()]) {
            if (owner === peerId) {
                this.sessionOwners.delete(session);
                changed = true;
            }
        }
        if (changed)
            this.schedule();
    }
    /**
     * Update one peer's prefs. An empty string DELETES the key ('' must mean
     * "follow the default" — a stored '' would shadow the config-level
     * fallback chain).
     */
    setPrefs(peerId, next) {
        const current = { ...(this.peerPrefs.get(peerId) ?? {}) };
        let changed = false;
        for (const key of ['provider', 'model', 'cwd']) {
            const value = next[key];
            if (value === undefined)
                continue;
            if (value === '') {
                if (key in current) {
                    delete current[key];
                    changed = true;
                }
                continue;
            }
            if (current[key] !== value) {
                current[key] = value;
                changed = true;
            }
        }
        if (next.thinking !== undefined && current.thinking !== next.thinking) {
            current.thinking = next.thinking;
            changed = true;
        }
        if (!changed)
            return;
        if (Object.keys(current).length === 0)
            this.peerPrefs.delete(peerId);
        else
            this.peerPrefs.set(peerId, current);
        this.schedule();
    }
    toJSON() {
        return {
            version: 1,
            peerPrefs: Object.fromEntries(this.peerPrefs),
            pairedUserIds: [...this.pairedUserIds],
            peerSessions: Object.fromEntries(this.peerSessions),
            sessionOwners: Object.fromEntries(this.sessionOwners),
            sessionCreators: Object.fromEntries(this.sessionCreators),
            releasedSessions: [...this.releasedSessions],
            contextTokens: Object.fromEntries(this.contextTokens),
        };
    }
    schedule() {
        if (this.disposed)
            return;
        this.dirty = true;
        if (this.timer !== null)
            return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, this.debounceMs);
        this.timer.unref?.();
    }
    flush(allowRetry = true) {
        if (!this.dirty || this.disposed)
            return;
        const tmp = `${this.file}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.file), { mode: 0o700, recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2), { encoding: 'utf-8', mode: 0o600 });
            fs.renameSync(tmp, this.file);
            // The pending flag drops only after the bytes are on disk: a crash or a
            // failed write must never lose the fact that state changed (M8).
            this.dirty = false;
            this.retryCount = 0;
        }
        catch {
            // Write failed: keep dirty so nothing is lost, then back off and retry
            // (unref'd — never holds the process open). A fresh mutation re-triggers
            // a debounced flush anyway, so retry exhaustion is not a dead end.
            this.dirty = true;
            this.retryCount += 1;
            if (allowRetry && this.retryCount <= FLUSH_RETRY_MAX_ATTEMPTS)
                this.scheduleRetry();
        }
    }
    scheduleRetry() {
        if (this.retryTimer !== null)
            return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.flush();
        }, this.retryMs);
        this.retryTimer.unref?.();
    }
    /** Flush pending writes and stop timers. */
    dispose() {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        // One last synchronous attempt. A failure keeps dirty=true and is not
        // retried: the object is going away.
        this.flush(false);
        this.disposed = true;
    }
}
//# sourceMappingURL=state.js.map