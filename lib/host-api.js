/**
 * Host API for the Web settings panel (differentiator #3):
 * same-origin endpoints the client calls to show gateway status, start a QR
 * pairing, and read the mode list — no CORS, no extra credentials on the wire.
 *
 * @module dsh-wechat-bridge/host-api
 */
const STATUS_PATH = '/api/dsh-wechat-bridge/status';
const PAIR_PATH = '/api/dsh-wechat-bridge/pair';
function writeJson(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
}
/** Register the settings-panel endpoints on the harness web server. */
export function registerHostApi(ctx, gateway, node) {
    ctx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: async (_req, res) => {
            try {
                const creds = await gateway.resolveCredentials();
                writeJson(res, 200, {
                    ok: true,
                    status: gateway.status,
                    pairingMessage: gateway.pairingMessage,
                    paired: Boolean(creds?.botToken),
                    accountId: creds?.accountId ?? null,
                    allowFrom: node.resolved.allowFrom,
                    modes: node.presets.list().map((p) => p.id),
                    defaultMode: node.resolved.defaultMode ?? null,
                });
            }
            catch (err) {
                writeJson(res, 500, { ok: false, error: String(err) });
            }
        },
    });
    ctx.webServer.register({
        kind: 'exact',
        path: PAIR_PATH,
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                writeJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            try {
                const qr = await gateway.startPairing();
                writeJson(res, 200, { ok: true, svg: qr.svg, scanData: qr.scanData });
            }
            catch (err) {
                writeJson(res, 409, { ok: false, error: String(err) });
            }
        },
    });
}
//# sourceMappingURL=host-api.js.map