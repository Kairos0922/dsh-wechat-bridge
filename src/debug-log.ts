/**
 * Bridge debug log — a tiny append-only JSONL sink under the DSH storages
 * dir. ctx.logger output does not reach the web profile's log file, so the
 * bridge keeps its own operational trace for field diagnosis.
 *
 * Path: $DSH_HOME/storages/dsh-wechat-bridge/debug.log (capped, tail-kept).
 * Never throws: diagnostics must not break the bridge.
 *
 * @module dsh-wechat-bridge/debug-log
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_BYTES = 512 * 1024
/** Full-fidelity media capture cap — items can be a few KB each (2MB tail). */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
/**
 * Key operational events (inbound/send/poll/notify/approval) live in their
 * own capped sink: debug.log is also capped but assistant/chunk session
 * events fill it within minutes, rolling the facts needed for field
 * diagnosis out of the window (2026-08-18 incident).
 */
const MAX_EVENT_BYTES = 512 * 1024

function debugFilePath(): string {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-wechat-bridge', 'debug.log')
}

/** Dedicated sink for FULL inbound media items (outbound-shape ground truth). */
function mediaCaptureFilePath(): string {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-wechat-bridge', 'media-captures.jsonl')
}

/** Dedicated sink for KEY operational events (inbound/send/poll/notify/approval). */
function eventsFilePath(): string {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-wechat-bridge', 'events.jsonl')
}

// ------------------------------------------------------------- P2-4: redaction

/** Keys whose string values are credentials — masked wherever they appear. */
const REDACT_KEYS = new Set([
  'token',
  'bot_token',
  'aes_key',
  'aeskey',
  'typing_ticket',
  'authorization',
  'qrcode_img_content', // the scannable URL IS the login grant
])

/**
 * P2-4: generic deep redaction for debug sinks — previously each call site
 * redacted by hand (context tokens, aes keys) and a new log point could
 * silently leak a credential. Walks plain objects/arrays only, masks values
 * under credential keys, and is a no-op on everything else.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 6) return value
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, depth + 1)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k) && typeof v === 'string' && v) {
        out[k] = v.length > 8 ? `…${v.slice(-4)}<redacted>` : '<redacted>'
      } else {
        out[k] = redactDeep(v, depth + 1)
      }
    }
    return out as unknown as T
  }
  return value
}

/**
 * encrypt_query_param is the CDN DOWNLOAD credential for one media object.
 * Field diagnosis needs its LENGTH and stability, not its plaintext — keep
 * a shape-preserving mask (`eqp<len>:first12…last6`) so byte-level shape
 * comparison still works without a usable download grant in the sink.
 */
function maskEncryptedQueryParam(s: string): string {
  if (s.length <= 20) return `<eqp${s.length}:redacted>`
  return `<eqp${s.length}:${s.slice(0, 12)}…${s.slice(-6)}>`
}

const EQP_KEY_RE = /"((?:encrypt_query_param|thumb_encrypt_query_param))":"([^"]{4,})"/g

function redactEncryptedQueryParams(text: string): string {
  return text.replace(EQP_KEY_RE, (_m, key: string, val: string) => `"${key}":"${maskEncryptedQueryParam(val)}"`)
}

export function debugLog(event: Record<string, unknown>): void {
  try {
    const file = debugFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), ...redactDeep(event) }) + '\n'
    fs.appendFileSync(file, line)
    if (fs.statSync(file).size > MAX_BYTES) {
      // Keep the tail: the most recent records matter most for diagnosis.
      fs.writeFileSync(file, fs.readFileSync(file).subarray(-Math.floor(MAX_BYTES / 2)))
    }
  } catch {
    // diagnostics are best-effort only
  }
}

/**
 * Append to the key-event sink (events.jsonl). Use for facts that must
 * survive chunk-heavy sessions: inbound, send outcomes, poll health, notify,
 * approval lifecycle. Same capped-tail semantics as debug.log. Values under
 * credential keys are masked generically (P2-4) — call sites no longer have
 * to remember.
 */
export function debugLogEvent(event: Record<string, unknown>): void {
  try {
    const file = eventsFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), ...redactDeep(event) }) + '\n'
    fs.appendFileSync(file, line)
    if (fs.statSync(file).size > MAX_EVENT_BYTES) {
      fs.writeFileSync(file, fs.readFileSync(file).subarray(-Math.floor(MAX_EVENT_BYTES / 2)))
    }
  } catch {
    // diagnostics are best-effort only
  }
}

/**
 * Capture a FULL inbound media item verbatim (no truncation). The debug log
 * only keeps a 1200-char digest; this sink preserves the complete official
 * client outbound shape — including thumb_media and any field the digest
 * would hide — for byte-level comparison against our own sends
 * (docs/porting-notes.md §6). AES keys are redacted upstream
 * (gateway redactItemForCapture); encrypt_query_param values are replaced
 * with a shape-preserving mask here. Append-only JSONL, capped tail.
 * ⚠ The sink is under $DSH_HOME (0700 storages) — treat as sensitive, do not
 * paste into issues.
 */
export function debugLogMediaCapture(event: { msgId?: number | string | null; item: unknown }): void {
  try {
    const file = mediaCaptureFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line =
      redactEncryptedQueryParams(JSON.stringify({ ts: new Date().toISOString(), msgId: event.msgId ?? null, item: event.item })) + '\n'
    fs.appendFileSync(file, line)
    if (fs.statSync(file).size > MAX_CAPTURE_BYTES) {
      fs.writeFileSync(file, fs.readFileSync(file).subarray(-Math.floor(MAX_CAPTURE_BYTES / 2)))
    }
  } catch {
    // diagnostics are best-effort only
  }
}
