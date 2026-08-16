/**
 * Host API for the Web settings panel (differentiator #3):
 * same-origin endpoints the client calls to show gateway status, start a QR
 * pairing, and read the mode list — no CORS, no extra credentials on the wire.
 *
 * @module dsh-wechat-bridge/host-api
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WechatGateway } from './gateway/index.ts'
import { listModes } from './node/presets.ts'
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

const STATUS_PATH = '/api/dsh-wechat-bridge/status'
const PAIR_PATH = '/api/dsh-wechat-bridge/pair'

function writeJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Register the settings-panel endpoints on the harness web server. */
export function registerHostApi(ctx: Context, gateway: WechatGateway, node: WechatBridgeNode): void {
  ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (_req, res) => {
      try {
        const creds = await gateway.resolveCredentials()
        const pausedUntil = node.outboxPausedUntil()
        writeJson(res, 200, {
          ok: true,
          status: gateway.status,
          pairingMessage: gateway.pairingMessage,
          paired: Boolean(creds?.botToken),
          accountId: creds?.accountId ?? null,
          allowFrom: node.resolved.allowFrom,
          defaultMode: node.resolved.defaultMode ?? null,
          markdownMode: node.resolved.markdownMode,
          modes: await listModes(ctx),
          prefs: { ...node.state.prefs },
          outbox: {
            pending: node.outbox.pendingCount(),
            pausedUntil: pausedUntil === null || pausedUntil <= Date.now() ? null : pausedUntil,
          },
          lastSendError: gateway.lastSendError,
        })
      } catch (err) {
        writeJson(res, 500, { ok: false, error: String(err) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: PAIR_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const qr = await gateway.startPairing()
        writeJson(res, 200, { ok: true, svg: qr.svg, scanData: qr.scanData })
      } catch (err) {
        writeJson(res, 409, { ok: false, error: String(err) })
      }
    },
  })
}
