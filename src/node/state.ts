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

import fs from 'node:fs'
import path from 'node:path'
import { resolveDshHome } from '../home.ts'

export interface BridgePrefs {
  /** Provider route for `/new` sessions (absent = deployment default). */
  provider?: string
  /** Model id for `/new` sessions (absent = deployment default). */
  model?: string
  /** Working directory for `/new` sessions (absent = config cwd). */
  cwd?: string
  /** Show reasoning excerpts in the thinking digest (default off). */
  thinking?: boolean
}

export interface BridgeStateData {
  version: 1
  /**
   * Per-peer preferences (provider/model/cwd/thinking). Each WeChat user's
   * `/model` `/workspace` `/thinking` choices are isolated. The legacy
   * single-user `prefs` field (pre-multi-user) migrates into the `default`
   * bucket: a peer without its own prefs falls back to it, so the original
   * owner keeps their settings after upgrade.
   */
  peerPrefs: Record<string, BridgePrefs>
  /** Legacy single-user prefs — migrated into `peerPrefs['default']`. */
  prefs?: BridgePrefs
  /**
   * Every WeChat id that ever confirmed a pairing QR — each scan adds its
   * scanner (multi-user: anyone who scans becomes trusted; a later scan
   * never displaces an earlier one). This is the "scan = trust" boundary.
   */
  pairedUserIds: string[]
  /** peerId → active session id. */
  peerSessions: Record<string, string>
  /** sessionId → owning peer id (survives restart for reply routing). */
  sessionOwners: Record<string, string>
  /**
   * peerId → latest iLink context token. The official client persists these
   * per account; without them, sends after a restart carry no context_token
   * and the WeChat client may not associate them to a conversation window.
   */
  contextTokens: Record<string, string>
}

export function defaultStateFile(): string {
  return path.join(resolveDshHome(), 'storages', 'dsh-wechat-bridge', 'state.json')
}

export interface BridgeStateOptions {
  file?: string
  debounceMs?: number
}

/** Validate an unknown JSON value into a usable state (never throws). */
export function sanitizeState(value: unknown): BridgeStateData {
  const base: BridgeStateData = { version: 1, peerPrefs: {}, pairedUserIds: [], peerSessions: {}, sessionOwners: {}, contextTokens: {} }
  if (typeof value !== 'object' || value === null) return base
  const record = value as Record<string, unknown>

  const cleanPrefs = (raw: unknown): BridgePrefs => {
    const prefs: BridgePrefs = {}
    if (typeof raw === 'object' && raw !== null) {
      const p = raw as Record<string, unknown>
      if (typeof p.provider === 'string' && p.provider) prefs.provider = p.provider
      if (typeof p.model === 'string' && p.model) prefs.model = p.model
      if (typeof p.cwd === 'string' && p.cwd) prefs.cwd = p.cwd
      if (typeof p.thinking === 'boolean') prefs.thinking = p.thinking
    }
    return prefs
  }

  // New layout: per-peer prefs. Legacy single-user `prefs` migrates into the
  // `default` bucket so the original owner keeps their model/workspace choices.
  const peerPrefs: Record<string, BridgePrefs> = {}
  const rawPeerPrefs = record.peerPrefs
  if (typeof rawPeerPrefs === 'object' && rawPeerPrefs !== null) {
    for (const [peer, raw] of Object.entries(rawPeerPrefs as Record<string, unknown>)) {
      if (!peer) continue
      const prefs = cleanPrefs(raw)
      if (Object.keys(prefs).length > 0) peerPrefs[peer] = prefs
    }
  }
  const legacy = cleanPrefs(record.prefs)
  if (Object.keys(legacy).length > 0 && Object.keys(peerPrefs).length === 0) {
    peerPrefs.default = legacy
  } else if (Object.keys(legacy).length > 0 && peerPrefs.default === undefined) {
    peerPrefs.default = legacy
  }

  const pairedUserIds: string[] = []
  const rawPaired = record.pairedUserIds
  if (Array.isArray(rawPaired)) {
    for (const id of rawPaired) {
      if (typeof id === 'string' && id && !pairedUserIds.includes(id)) pairedUserIds.push(id)
    }
  }
  const peerSessions: Record<string, string> = {}
  const rawPeers = record.peerSessions
  if (typeof rawPeers === 'object' && rawPeers !== null) {
    for (const [peer, session] of Object.entries(rawPeers as Record<string, unknown>)) {
      if (typeof session === 'string' && session) peerSessions[peer] = session
    }
  }
  const sessionOwners: Record<string, string> = {}
  const rawOwners = record.sessionOwners
  if (typeof rawOwners === 'object' && rawOwners !== null) {
    for (const [session, peer] of Object.entries(rawOwners as Record<string, unknown>)) {
      if (typeof session === 'string' && typeof peer === 'string' && session && peer) sessionOwners[session] = peer
    }
  }
  const contextTokens: Record<string, string> = {}
  const rawTokens = record.contextTokens
  if (typeof rawTokens === 'object' && rawTokens !== null) {
    for (const [peer, token] of Object.entries(rawTokens as Record<string, unknown>)) {
      if (typeof peer === 'string' && typeof token === 'string' && peer && token) contextTokens[peer] = token
    }
  }
  return { version: 1, peerPrefs, pairedUserIds, peerSessions, sessionOwners, contextTokens }
}

export class BridgeState {
  private readonly peerPrefs = new Map<string, BridgePrefs>()
  private readonly pairedUserIds = new Set<string>()
  private readonly file: string
  private readonly debounceMs: number
  private peerSessions = new Map<string, string>()
  private sessionOwners = new Map<string, string>()
  private contextTokens = new Map<string, string>()

  private timer: NodeJS.Timeout | null = null
  private dirty = false
  private disposed = false

  constructor(opts: BridgeStateOptions = {}) {
    this.file = opts.file ?? defaultStateFile()
    this.debounceMs = opts.debounceMs ?? 3_000
    let loaded: BridgeStateData = { version: 1, peerPrefs: {}, pairedUserIds: [], peerSessions: {}, sessionOwners: {}, contextTokens: {} }
    try {
      loaded = sanitizeState(JSON.parse(fs.readFileSync(this.file, 'utf-8')) as unknown)
    } catch {
      // absent or unreadable = fresh state; never fatal
    }
    for (const id of loaded.pairedUserIds) this.pairedUserIds.add(id)
    this.peerPrefs.set('default', loaded.peerPrefs.default ?? {})
    for (const [peer, prefs] of Object.entries(loaded.peerPrefs)) {
      if (peer !== 'default') this.peerPrefs.set(peer, prefs)
    }
    this.peerSessions = new Map(Object.entries(loaded.peerSessions))
    this.sessionOwners = new Map(Object.entries(loaded.sessionOwners))
    this.contextTokens = new Map(Object.entries(loaded.contextTokens))
  }

  getPeerSession(peerId: string): string | null {
    return this.peerSessions.get(peerId) ?? null
  }

  setPeerSession(peerId: string, sessionId: string | null): void {
    if (sessionId === null) {
      if (this.peerSessions.delete(peerId)) this.schedule()
      return
    }
    if (this.peerSessions.get(peerId) !== sessionId) {
      this.peerSessions.set(peerId, sessionId)
      this.schedule()
    }
  }

  listPeerSessions(): Array<[string, string]> {
    return [...this.peerSessions.entries()]
  }

  getSessionOwner(sessionId: string): string | null {
    return this.sessionOwners.get(sessionId) ?? null
  }

  setSessionOwner(sessionId: string, peerId: string | null): void {
    if (peerId === null) {
      if (this.sessionOwners.delete(sessionId)) this.schedule()
      return
    }
    if (this.sessionOwners.get(sessionId) !== peerId) {
      this.sessionOwners.set(sessionId, peerId)
      this.schedule()
    }
  }

  listSessionOwners(): Array<[string, string]> {
    return [...this.sessionOwners.entries()]
  }

  getContextToken(peerId: string): string | null {
    return this.contextTokens.get(peerId) ?? null
  }

  setContextToken(peerId: string, token: string | null): void {
    if (token === null) {
      if (this.contextTokens.delete(peerId)) this.schedule()
      return
    }
    if (this.contextTokens.get(peerId) !== token) {
      this.contextTokens.set(peerId, token)
      this.schedule()
    }
  }

  listContextTokens(): Array<[string, string]> {
    return [...this.contextTokens.entries()]
  }



  /**
   * This peer's preferences: own bucket, falling back to the migrated legacy
   * `default` bucket so the original single-user settings keep applying.
   */
  getPrefs(peerId: string): BridgePrefs {
    return this.peerPrefs.get(peerId) ?? this.peerPrefs.get('default') ?? {}
  }

  /** Record a pairing-confirmed WeChat id (idempotent, never displaces). */
  addPairedUserId(userId: string): void {
    if (!userId || this.pairedUserIds.has(userId)) return
    this.pairedUserIds.add(userId)
    this.schedule()
  }

  /** All pairing-confirmed WeChat ids. */
  listPairedUserIds(): string[] {
    return [...this.pairedUserIds]
  }

  /** Whether this peer has any history (message context or session binding). */
  hasPeerHistory(peerId: string): boolean {
    return this.contextTokens.has(peerId) || this.peerSessions.has(peerId)
  }

  /**
   * Update one peer's prefs. An empty string DELETES the key ('' must mean
   * "follow the default" — a stored '' would shadow the config-level
   * fallback chain).
   */
  setPrefs(peerId: string, next: Partial<BridgePrefs>): void {
    const current = { ...(this.peerPrefs.get(peerId) ?? {}) }
    let changed = false
    for (const key of ['provider', 'model', 'cwd'] as const) {
      const value = next[key]
      if (value === undefined) continue
      if (value === '') {
        if (key in current) {
          delete current[key]
          changed = true
        }
        continue
      }
      if (current[key] !== value) {
        current[key] = value
        changed = true
      }
    }
    if (next.thinking !== undefined && current.thinking !== next.thinking) {
      current.thinking = next.thinking
      changed = true
    }
    if (!changed) return
    if (Object.keys(current).length === 0) this.peerPrefs.delete(peerId)
    else this.peerPrefs.set(peerId, current)
    this.schedule()
  }

  toJSON(): BridgeStateData {
    return {
      version: 1,
      peerPrefs: Object.fromEntries(this.peerPrefs),
      pairedUserIds: [...this.pairedUserIds],
      peerSessions: Object.fromEntries(this.peerSessions),
      sessionOwners: Object.fromEntries(this.sessionOwners),
      contextTokens: Object.fromEntries(this.contextTokens),
    }
  }

  private schedule(): void {
    if (this.disposed) return
    this.dirty = true
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  private flush(): void {
    if (!this.dirty || this.disposed) return
    this.dirty = false
    const tmp = `${this.file}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2), 'utf-8')
      fs.renameSync(tmp, this.file)
    } catch {
      // best-effort persistence; in-memory state still governs this process
    }
  }

  /** Flush pending writes and stop timers. */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
    this.disposed = true
  }
}
