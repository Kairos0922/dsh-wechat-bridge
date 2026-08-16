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

import fs from 'node:fs'
import path from 'node:path'
import { resolveDshHome } from './home.ts'

export const DEFAULT_SEEN_TTL_MS = 10 * 60_000
export const DEFAULT_SEEN_CAP = 2000

/** Pure in-memory TTL set — clock-injectable for tests. */
export class SeenSet {
  private readonly ttlMs: number
  private readonly cap: number
  private readonly nowFn: () => number
  private entries = new Map<number, number>()

  constructor(opts: { ttlMs?: number; cap?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_SEEN_TTL_MS
    this.cap = opts.cap ?? DEFAULT_SEEN_CAP
    this.nowFn = opts.now ?? Date.now
  }

  /** Whether the id was seen within the TTL. Expired entries are pruned. */
  has(id: number): boolean {
    const at = this.entries.get(id)
    if (at === undefined) return false
    if (this.nowFn() - at >= this.ttlMs) {
      this.entries.delete(id)
      return false
    }
    return true
  }

  mark(id: number): void {
    this.entries.set(id, this.nowFn())
    if (this.entries.size > this.cap) {
      // Evict the oldest entries down to the cap (TTL may not have expired yet).
      const sorted = [...this.entries.entries()].sort((a, b) => a[1] - b[1])
      for (const [key] of sorted.slice(0, this.entries.size - this.cap)) {
        this.entries.delete(key)
      }
    }
  }

  prune(): void {
    const now = this.nowFn()
    for (const [id, at] of this.entries) {
      if (now - at >= this.ttlMs) this.entries.delete(id)
    }
  }

  get size(): number {
    return this.entries.size
  }

  snapshot(): Array<[number, number]> {
    this.prune()
    return [...this.entries.entries()]
  }

  restore(snapshot: Array<[number, number]>): void {
    const now = this.nowFn()
    for (const [id, at] of snapshot) {
      if (now - at < this.ttlMs) this.entries.set(id, at)
    }
  }
}

/** Default seen-file location under the bridge's storage dir. */
export function defaultSeenFile(): string {
  return path.join(resolveDshHome(), 'storages', 'dsh-wechat-bridge', 'seen.json')
}

/**
 * Persisted {@link SeenSet}: loads the file at open, writes atomically on a
 * debounce, flushes on dispose. All timers are unref'd.
 */
export class SeenStore {
  private readonly set: SeenSet
  private readonly file: string
  private readonly debounceMs: number
  private timer: NodeJS.Timeout | null = null
  private dirty = false
  private disposed = false

  constructor(opts: { file?: string; ttlMs?: number; cap?: number; debounceMs?: number } = {}) {
    this.file = opts.file ?? defaultSeenFile()
    this.debounceMs = opts.debounceMs ?? 5_000
    this.set = new SeenSet({ ttlMs: opts.ttlMs, cap: opts.cap })
    try {
      const raw = fs.readFileSync(this.file, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const snapshot: Array<[number, number]> = []
        for (const entry of parsed) {
          if (Array.isArray(entry) && typeof entry[0] === 'number' && typeof entry[1] === 'number') {
            snapshot.push([entry[0], entry[1]])
          }
        }
        this.set.restore(snapshot)
      }
    } catch {
      // absent or unreadable file = empty history; never fatal
    }
  }

  has(id: number): boolean {
    return this.set.has(id)
  }

  mark(id: number): void {
    this.set.mark(id)
    this.schedule()
  }

  get size(): number {
    return this.set.size
  }

  private schedule(): void {
    if (this.disposed || this.timer !== null) {
      this.dirty = true
      return
    }
    this.dirty = true
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  private flush(): void {
    if (!this.dirty || this.disposed) return
    this.dirty = false
    const payload = JSON.stringify(this.set.snapshot())
    const tmp = `${this.file}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, payload, 'utf-8')
      fs.renameSync(tmp, this.file)
    } catch {
      // persistence is best-effort: in-memory dedup still holds
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
    this.disposed = true
  }
}

/** Default poll-cursor file location under the bridge's storage dir. */
export function defaultPollCursorFile(): string {
  return path.join(resolveDshHome(), 'storages', 'dsh-wechat-bridge', 'poll-cursor.json')
}

/**
 * Persisted `get_updates_buf` continuation cursor, tagged with the accountId
 * it belongs to (a re-paired bot must not reuse the old bot's cursor).
 * Mirrors the official monitor's per-account sync-file semantics. Atomic
 * writes on a debounce; all timers unref'd.
 */
export class PollCursorStore {
  private readonly file: string
  private readonly debounceMs: number
  private cursor: { accountId: string; buf: string } | null = null
  private timer: NodeJS.Timeout | null = null
  private dirty = false
  private disposed = false

  constructor(opts: { file?: string; debounceMs?: number } = {}) {
    this.file = opts.file ?? defaultPollCursorFile()
    this.debounceMs = opts.debounceMs ?? 5_000
    try {
      const raw = fs.readFileSync(this.file, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as Record<string, unknown>
        if (typeof p.accountId === 'string' && typeof p.buf === 'string' && p.accountId && p.buf) {
          this.cursor = { accountId: p.accountId, buf: p.buf }
        }
      }
    } catch {
      // absent or unreadable = no cursor; never fatal
    }
  }

  load(): { accountId: string; buf: string } | null {
    return this.cursor
  }

  save(cursor: { accountId: string; buf: string } | null): void {
    const next = cursor === null ? null : { accountId: cursor.accountId, buf: cursor.buf }
    const cur = this.cursor
    if (
      (cur === null) !== (next === null) ||
      (cur !== null && next !== null && (cur.accountId !== next.accountId || cur.buf !== next.buf))
    ) {
      this.cursor = next
      this.dirty = true
      this.schedule()
    }
  }

  private schedule(): void {
    if (this.disposed) return
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
      fs.writeFileSync(tmp, JSON.stringify(this.cursor), 'utf-8')
      fs.renameSync(tmp, this.file)
    } catch {
      // best-effort persistence
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
    this.disposed = true
  }
}
