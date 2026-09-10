/**
 * Host API for the Web settings panel (differentiator #3):
 * same-origin endpoints the client calls to show gateway status, start a QR
 * pairing, confirm/reject held pairings, and revoke paired users.
 *
 * Browser-trust fence: every endpoint first passes isTrustedRequest — the
 * same semantics the platform applies to its own /api RPC channels (Host is
 * loopback or a declared trusted authority; `sec-fetch-site: cross-site` is
 * refused; any attached Origin must be same-host). The platform fence lives
 * on the Connection RPC channel registry, which single-owner channels make
 * unavailable to plugins — so the check is replicated here, deliberately and
 * exactly. This is a confused-deputy defense (DNS rebinding, cross-site
 * reads); authentication of the panel itself stays with the DSH deployment
 * (loopback binding by default).
 *
 * @module dsh-wechat-bridge/host-api
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { lastSessionEvent } from './session-events.ts'
import type { WechatGateway } from './gateway/index.ts'
import { listModes } from './node/presets.ts'
import { listSessions, sessionLabel } from './node/commands.ts'
import { OUTBOX_PRIORITY } from './node/outbox.ts'
import type { WechatBridgeNode } from './node/core.ts'

/** Minimal structural typing for the dsh-web `webServer` service seam. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(opts: {
        kind: 'exact'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): void
    }
  }
}

const BASE_PATH = '/api/dsh-wechat-bridge'
const STATUS_PATH = `${BASE_PATH}/status`
const PAIR_PATH = `${BASE_PATH}/pair`
const PAIR_CONFIRM_PATH = `${BASE_PATH}/pair/confirm`
const PAIR_REJECT_PATH = `${BASE_PATH}/pair/reject`
const PAIR_REVOKE_PATH = `${BASE_PATH}/pair/revoke`
const PAIR_VERIFY_CODE_PATH = `${BASE_PATH}/pair/verify-code`
const PAUSE_PATH = `${BASE_PATH}/pause`
const SESSIONS_PATH = `${BASE_PATH}/sessions`
const SESSION_ACCESS_PATH = `${BASE_PATH}/session-access`
const SEND_PATH = `${BASE_PATH}/send`

/**
 * Shared contract for a session shown in the Web settings panel. The client
 * (`./client.ts` Status.sessions) models EXACTLY this shape — keep both in
 * lockstep; a drift here renders an empty/broken session list (see the H2
 * incident). Both `/status` and `/sessions` emit this shape through
 * `buildSessionInfo`.
 */
export interface SessionInfo {
  id: string
  label: string
  status: string
  lastActivityAt: number
  enabled: boolean
}

/** Map a running agent status to a stable display string. */
function agentStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'running': return '运行中'
    case 'idle': return '空闲'
    default: return status ?? '空闲'
  }
}

/** Build the Web-panel session contract for one DSH session. */
function buildSessionInfo(node: WechatBridgeNode, session: Session): SessionInfo {
  const last = lastSessionEvent(session)
  const agent = (node.ctx as unknown as { agents?: { get(id: string): { status?: string } | undefined } }).agents?.get(session.id)
  return {
    id: session.id,
    label: sessionLabel(session),
    status: agentStatusLabel(agent?.status),
    lastActivityAt: last?.time ?? session.header.createdAt,
    enabled: node.isSessionWechatEnabled(session.id),
  }
}

/** localhost, IPv6 loopback, or any IPv4 address in 127/8. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** `host` or `host:port` exact grant; a bare host matches any port. */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((raw) => {
    const entry = raw.trim().toLowerCase()
    if (!entry) return false
    return entry === hostUrl.host.toLowerCase() || entry === hostUrl.hostname.toLowerCase()
  })
}

/**
 * Mirror of the platform's isTrustedApiRequest (dsh-client-connection):
 * true when the Host is ours (loopback or declared trusted) and any attached
 * browser markers are same-origin. Exported for tests.
 */
export function isTrustedRequest(req: IncomingMessage, trustedHosts: readonly string[] = []): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Read a small JSON body (pairing management payloads are tiny by design). */
function readJsonBody(req: IncomingMessage, maxBytes = 4096): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || 'null'))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

export interface HostApiOptions {
  /** Non-loopback authorities this deployment serves (e.g. LAN hostname). */
  trustedHosts?: readonly string[]
}

/** Register the settings-panel endpoints on the harness web server. */
export function registerHostApi(ctx: Context, gateway: WechatGateway, node: WechatBridgeNode, opts: HostApiOptions = {}): void {
  const trustedHosts = opts.trustedHosts ?? []
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isTrustedRequest(req, trustedHosts)) return true
    writeJson(res, 403, { ok: false, error: 'forbidden' })
    return false
  }
  const postOnly = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method === 'POST') return true
    writeJson(res, 405, { ok: false, error: 'method not allowed' })
    return false
  }

  ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      try {
        const creds = await gateway.resolveCredentials()
        const pausedUntil = node.outboxPausedUntil()
        writeJson(res, 200, {
          ok: true,
          status: gateway.status,
          pairingMessage: gateway.pairingMessage,
          needVerifyCode: gateway.needVerifyCode,
          // L3: the gateway updates pairingQr on every QR refresh (expired /
          // verify_code_blocked reissues a fresh code). Exposing the CURRENT
          // svg lets the panel auto-refresh the displayed QR instead of
          // showing a stale one that can never be scanned.
          qr: gateway.pairingQr?.svg ?? null,
          paused: node.isPaused(),
          paired: Boolean(creds?.botToken),
          accountId: creds?.accountId ?? null,
          allowFrom: node.resolved.allowFrom,
          pairedUserId: await node.getPairedUserId(),
          pairedUserIds: node.listPairedUserIds(),
          pendingPair: gateway.pendingPair ?? null,
          pendingTrustUserId: node.pendingTrustUserId,
          defaultMode: node.resolved.defaultMode ?? null,
          markdownMode: node.resolved.markdownMode,
          modes: await listModes(ctx),
          prefs: { ...node.state.getPrefs('default') },
          outbox: {
            pending: node.outbox.pendingCount(),
            pausedUntil: pausedUntil === null || pausedUntil <= Date.now() ? null : pausedUntil,
          },
          lastSendError: gateway.lastSendError,
          health: gateway.healthSnapshot(),
          sessions: listSessions(node).slice(0, 100).map((session) => buildSessionInfo(node, session)),
        })
      } catch (err) {
        ctx.logger.warn('[dsh-wechat-bridge] status endpoint failed: %s', String(err))
        writeJson(res, 500, { ok: false, error: 'internal' })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: PAIR_PATH,
    handler: async (req, res) => {
      if (!guard(req, res) || !postOnly(req, res)) return
      try {
        const qr = await gateway.startPairing()
        writeJson(res, 200, { ok: true, svg: qr.svg, scanData: qr.scanData })
      } catch (err) {
        ctx.logger.warn('[dsh-wechat-bridge] pair endpoint failed: %s', String(err))
        writeJson(res, 409, { ok: false, error: 'conflict' })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: PAIR_CONFIRM_PATH,
    handler: async (req, res) => {
      if (!guard(req, res) || !postOnly(req, res)) return
      try {
        // A held bot-identity switch outranks a held trust admission.
        if (gateway.pendingPair) {
          writeJson(res, 200, { ok: true, confirmed: await gateway.confirmPairing() })
          return
        }
        if (node.pendingTrustUserId !== null) {
          writeJson(res, 200, { ok: true, confirmed: await node.confirmPendingTrust() })
          return
        }
        writeJson(res, 200, { ok: true, confirmed: false })
      } catch (err) {
        ctx.logger.warn('[dsh-wechat-bridge] pair/confirm failed: %s', String(err))
        writeJson(res, 500, { ok: false, error: 'internal' })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: PAIR_REJECT_PATH,
    handler: async (req, res) => {
      if (!guard(req, res) || !postOnly(req, res)) return
      try {
        const rejected = gateway.rejectPairing() || node.rejectPendingTrust()
        writeJson(res, 200, { ok: true, rejected })
      } catch (err) {
        ctx.logger.warn('[dsh-wechat-bridge] pair/reject failed: %s', String(err))
        writeJson(res, 500, { ok: false, error: 'internal' })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: PAIR_VERIFY_CODE_PATH,
    handler: async (req, res) => {
      if (!guard(req, res) || !postOnly(req, res)) return
      try {
        const body = (await readJsonBody(req)) as { code?: unknown } | null
        const code = typeof body?.code === 'string' ? body.code : ''
        if (!code.trim()) {
          writeJson(res, 400, { ok: false, error: 'code required' })
          return
        }
        writeJson(res, 200, { ok: true, submitted: gateway.submitVerifyCode(code) })
      } catch (err) {
        ctx.logger.warn('[dsh-wechat-bridge] pair/verify-code failed: %s', String(err))
        writeJson(res, 500, { ok: false, error: 'internal' })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: SESSIONS_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const sessions = listSessions(node).slice(0, 100).map((session) => buildSessionInfo(node, session))
        writeJson(res, 200, { ok: true, sessions })
      } catch (err) {
        ctx.logger.warn('[dsh-wechat-bridge] sessions endpoint failed: %s', String(err))
        writeJson(res, 500, { ok: false, error: 'internal' })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: SESSION_ACCESS_PATH,
    handler: async (req, res) => {
      if (!guard(req, res) || !postOnly(req, res)) return
      try {
        const body = (await readJsonBody(req)) as { sessionId?: unknown; enabled?: unknown } | null
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId || typeof body?.enabled !== 'boolean') {
          writeJson(res, 400, { ok: false, error: 'sessionId and enabled required' })
          return
        }
        const session = ctx.sessions.get(sessionId as never)
        if (!session) {
          writeJson(res, 404, { ok: false, error: 'session not found' })
          return
        }
        if (body.enabled) node.enableSessionWechat(sessionId as never)
        else node.disableSessionWechat(sessionId as never)
        writeJson(res, 200, { ok: true, sessionId, enabled: node.isSessionWechatEnabled(sessionId) })
      } catch (err) {
        ctx.logger.warn('[dsh-wechat-bridge] session-access endpoint failed: %s', String(err))
        writeJson(res, 500, { ok: false, error: 'internal' })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: PAUSE_PATH,
    handler: async (req, res) => {
      if (!guard(req, res) || !postOnly(req, res)) return
      try {
        const body = (await readJsonBody(req)) as { paused?: unknown } | null
        // Strict boolean: body.paused must be `true` exactly. Using
        // Boolean(body.paused) would turn the string "false" (or "0") into
        // true and make the panel unable to resume from a pause.
        node.setPaused(body?.paused === true)
        writeJson(res, 200, { ok: true, paused: node.isPaused() })
      } catch (err) {
        ctx.logger.warn('[dsh-wechat-bridge] pause endpoint failed: %s', String(err))
        writeJson(res, 500, { ok: false, error: 'internal' })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: SEND_PATH,
    handler: async (req, res) => {
      if (!guard(req, res) || !postOnly(req, res)) return
      try {
        const body = (await readJsonBody(req, 16384)) as { toUserId?: unknown; text?: unknown } | null
        const toUserId = typeof body?.toUserId === 'string' ? body.toUserId.trim() : ''
        const text = typeof body?.text === 'string' ? body.text : ''
        if (!toUserId || !text.trim()) {
          writeJson(res, 400, { ok: false, error: 'toUserId and text required' })
          return
        }
        // The send endpoint is a channel for automation (e.g. the daily digest),
        // not an open relay: the target must be a trusted peer. Delivery goes
        // through the rate-limit-aware outbox as a MUST entry with recovery
        // resend: if the server's per-user inbound window is exhausted
        // (ret=-2 prepare failed), the digest rides the peer's next inbound
        // instead of being dropped (see protocol.md §5).
        if (!(await node.isAllowed(toUserId))) {
          writeJson(res, 403, { ok: false, error: 'toUserId not trusted' })
          return
        }
        node.enqueueText(toUserId, text, {
          kind: 'text',
          priority: OUTBOX_PRIORITY.must,
          resendOnRecovery: true,
        })
        writeJson(res, 200, { ok: true, queued: true })
      } catch (err) {
        ctx.logger.warn('[dsh-wechat-bridge] send endpoint failed: %s', String(err))
        writeJson(res, 500, { ok: false, error: 'internal' })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: PAIR_REVOKE_PATH,
    handler: async (req, res) => {
      if (!guard(req, res) || !postOnly(req, res)) return
      try {
        const body = (await readJsonBody(req)) as { userId?: unknown } | null
        const userId = typeof body?.userId === 'string' ? body.userId.trim() : ''
        if (!userId) {
          writeJson(res, 400, { ok: false, error: 'userId required' })
          return
        }
        writeJson(res, 200, { ok: true, revoked: await node.revokePairedUser(userId) })
      } catch (err) {
        ctx.logger.warn('[dsh-wechat-bridge] pair/revoke failed: %s', String(err))
        writeJson(res, 500, { ok: false, error: 'internal' })
      }
    },
  })
}
