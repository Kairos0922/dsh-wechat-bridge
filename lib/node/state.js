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
import fs from 'node:fs';
import path from 'node:path';
import { resolveDshHome } from "../home.js";
export function defaultStateFile() {
    return path.join(resolveDshHome(), 'storages', 'dsh-wechat-bridge', 'state.json');
}
/** Validate an unknown JSON value into a usable state (never throws). */
export function sanitizeState(value) {
    const base = { version: 1, prefs: {}, peerSessions: {}, sessionOwners: {}, contextTokens: {} };
    if (typeof value !== 'object' || value === null)
        return base;
    const record = value;
    const prefsRaw = record.prefs;
    const prefs = {};
    if (typeof prefsRaw === 'object' && prefsRaw !== null) {
        const p = prefsRaw;
        if (typeof p.provider === 'string' && p.provider)
            prefs.provider = p.provider;
        if (typeof p.model === 'string' && p.model)
            prefs.model = p.model;
        if (typeof p.cwd === 'string' && p.cwd)
            prefs.cwd = p.cwd;
        if (typeof p.thinking === 'boolean')
            prefs.thinking = p.thinking;
    }
    const peerSessions = {};
    const rawPeers = record.peerSessions;
    if (typeof rawPeers === 'object' && rawPeers !== null) {
        for (const [peer, session] of Object.entries(rawPeers)) {
            if (typeof session === 'string' && session)
                peerSessions[peer] = session;
        }
    }
    const sessionOwners = {};
    const rawOwners = record.sessionOwners;
    if (typeof rawOwners === 'object' && rawOwners !== null) {
        for (const [session, peer] of Object.entries(rawOwners)) {
            if (typeof session === 'string' && typeof peer === 'string' && session && peer)
                sessionOwners[session] = peer;
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
    return { version: 1, prefs, peerSessions, sessionOwners, contextTokens };
}
export class BridgeState {
    prefs;
    file;
    debounceMs;
    peerSessions = new Map();
    sessionOwners = new Map();
    contextTokens = new Map();
    timer = null;
    dirty = false;
    disposed = false;
    constructor(opts = {}) {
        this.file = opts.file ?? defaultStateFile();
        this.debounceMs = opts.debounceMs ?? 3_000;
        let loaded = { version: 1, prefs: {}, peerSessions: {}, sessionOwners: {}, contextTokens: {} };
        try {
            loaded = sanitizeState(JSON.parse(fs.readFileSync(this.file, 'utf-8')));
        }
        catch {
            // absent or unreadable = fresh state; never fatal
        }
        this.prefs = loaded.prefs;
        this.peerSessions = new Map(Object.entries(loaded.peerSessions));
        this.sessionOwners = new Map(Object.entries(loaded.sessionOwners));
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
    /**
     * Update prefs. An empty string DELETES the key ('' must mean "follow the
     * default" — a stored '' would shadow the config-level fallback chain).
     */
    setPrefs(next) {
        let changed = false;
        for (const key of ['provider', 'model', 'cwd']) {
            const value = next[key];
            if (value === undefined)
                continue;
            if (value === '') {
                if (key in this.prefs) {
                    delete this.prefs[key];
                    changed = true;
                }
                continue;
            }
            if (this.prefs[key] !== value) {
                this.prefs[key] = value;
                changed = true;
            }
        }
        if (next.thinking !== undefined && this.prefs.thinking !== next.thinking) {
            this.prefs.thinking = next.thinking;
            changed = true;
        }
        if (changed)
            this.schedule();
    }
    toJSON() {
        return {
            version: 1,
            prefs: { ...this.prefs },
            peerSessions: Object.fromEntries(this.peerSessions),
            sessionOwners: Object.fromEntries(this.sessionOwners),
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
    flush() {
        if (!this.dirty || this.disposed)
            return;
        this.dirty = false;
        const tmp = `${this.file}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2), 'utf-8');
            fs.renameSync(tmp, this.file);
        }
        catch {
            // best-effort persistence; in-memory state still governs this process
        }
    }
    /** Flush pending writes and stop timers. */
    dispose() {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.flush();
        this.disposed = true;
    }
}
//# sourceMappingURL=state.js.map