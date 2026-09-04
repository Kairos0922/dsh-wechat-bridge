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
import { SessionId } from '@deepseek-ai/dsh-session';
import { listModes } from "./node/presets.js";
import { listSessions, sessionLabel } from "./node/commands.js";
const BASE_PATH = '/api/dsh-wechat-bridge';
const STATUS_PATH = `${BASE_PATH}/status`;
const PAIR_PATH = `${BASE_PATH}/pair`;
const PAIR_CONFIRM_PATH = `${BASE_PATH}/pair/confirm`;
const PAIR_REJECT_PATH = `${BASE_PATH}/pair/reject`;
const PAIR_REVOKE_PATH = `${BASE_PATH}/pair/revoke`;
const PAIR_VERIFY_CODE_PATH = `${BASE_PATH}/pair/verify-code`;
const PAUSE_PATH = `${BASE_PATH}/pause`;
const SESSIONS_PATH = `${BASE_PATH}/sessions`;
const SESSION_ACCESS_PATH = `${BASE_PATH}/session-access`;
/** Map a running agent status to a stable display string. */
function agentStatusLabel(status) {
    switch (status) {
        case 'running': return '运行中';
        case 'idle': return '空闲';
        default: return status ?? '空闲';
    }
}
/** Build the Web-panel session contract for one DSH session. */
function buildSessionInfo(node, session) {
    const last = session.events[session.events.length - 1];
    const agent = node.ctx.agents?.get(session.id);
    return {
        id: session.id,
        label: sessionLabel(session),
        status: agentStatusLabel(agent?.status),
        lastActivityAt: last?.time ?? session.header.createdAt,
        enabled: node.isSessionWechatEnabled(session.id),
    };
}
/** localhost, IPv6 loopback, or any IPv4 address in 127/8. */
function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]')
        return true;
    const parts = hostname.split('.');
    return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** `host` or `host:port` exact grant; a bare host matches any port. */
function isTrustedAuthority(hostUrl, trustedHosts) {
    return trustedHosts.some((raw) => {
        const entry = raw.trim().toLowerCase();
        if (!entry)
            return false;
        return entry === hostUrl.host.toLowerCase() || entry === hostUrl.hostname.toLowerCase();
    });
}
/**
 * Mirror of the platform's isTrustedApiRequest (dsh-client-connection):
 * true when the Host is ours (loopback or declared trusted) and any attached
 * browser markers are same-origin. Exported for tests.
 */
export function isTrustedRequest(req, trustedHosts = []) {
    const host = req.headers.host;
    if (host === undefined)
        return false;
    let hostUrl;
    try {
        hostUrl = new URL(`http://${host}`);
    }
    catch {
        return false;
    }
    if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts))
        return false;
    if (req.headers['sec-fetch-site'] === 'cross-site')
        return false;
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === hostUrl.host;
    }
    catch {
        return false;
    }
}
function writeJson(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
}
/** Read a small JSON body (pairing management payloads are tiny by design). */
function readJsonBody(req, maxBytes = 4096) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('payload too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || 'null'));
            }
            catch {
                reject(new Error('invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}
/** Register the settings-panel endpoints on the harness web server. */
export function registerHostApi(ctx, gateway, node, opts = {}) {
    const trustedHosts = opts.trustedHosts ?? [];
    const guard = (req, res) => {
        if (isTrustedRequest(req, trustedHosts))
            return true;
        writeJson(res, 403, { ok: false, error: 'forbidden' });
        return false;
    };
    const postOnly = (req, res) => {
        if (req.method === 'POST')
            return true;
        writeJson(res, 405, { ok: false, error: 'method not allowed' });
        return false;
    };
    ctx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: async (req, res) => {
            if (!guard(req, res))
                return;
            try {
                const creds = await gateway.resolveCredentials();
                const pausedUntil = node.outboxPausedUntil();
                writeJson(res, 200, {
                    ok: true,
                    status: gateway.status,
                    pairingMessage: gateway.pairingMessage,
                    needVerifyCode: gateway.needVerifyCode,
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
                });
            }
            catch (err) {
                ctx.logger.warn('[dsh-wechat-bridge] status endpoint failed: %s', String(err));
                writeJson(res, 500, { ok: false, error: 'internal' });
            }
        },
    });
    ctx.webServer.register({
        kind: 'exact',
        path: PAIR_PATH,
        handler: async (req, res) => {
            if (!guard(req, res) || !postOnly(req, res))
                return;
            try {
                const qr = await gateway.startPairing();
                writeJson(res, 200, { ok: true, svg: qr.svg, scanData: qr.scanData });
            }
            catch (err) {
                ctx.logger.warn('[dsh-wechat-bridge] pair endpoint failed: %s', String(err));
                writeJson(res, 409, { ok: false, error: 'conflict' });
            }
        },
    });
    ctx.webServer.register({
        kind: 'exact',
        path: PAIR_CONFIRM_PATH,
        handler: async (req, res) => {
            if (!guard(req, res) || !postOnly(req, res))
                return;
            try {
                // A held bot-identity switch outranks a held trust admission.
                if (gateway.pendingPair) {
                    writeJson(res, 200, { ok: true, confirmed: await gateway.confirmPairing() });
                    return;
                }
                if (node.pendingTrustUserId !== null) {
                    writeJson(res, 200, { ok: true, confirmed: await node.confirmPendingTrust() });
                    return;
                }
                writeJson(res, 200, { ok: true, confirmed: false });
            }
            catch (err) {
                ctx.logger.warn('[dsh-wechat-bridge] pair/confirm failed: %s', String(err));
                writeJson(res, 500, { ok: false, error: 'internal' });
            }
        },
    });
    ctx.webServer.register({
        kind: 'exact',
        path: PAIR_REJECT_PATH,
        handler: async (req, res) => {
            if (!guard(req, res) || !postOnly(req, res))
                return;
            try {
                const rejected = gateway.rejectPairing() || node.rejectPendingTrust();
                writeJson(res, 200, { ok: true, rejected });
            }
            catch (err) {
                ctx.logger.warn('[dsh-wechat-bridge] pair/reject failed: %s', String(err));
                writeJson(res, 500, { ok: false, error: 'internal' });
            }
        },
    });
    ctx.webServer.register({
        kind: 'exact',
        path: PAIR_VERIFY_CODE_PATH,
        handler: async (req, res) => {
            if (!guard(req, res) || !postOnly(req, res))
                return;
            try {
                const body = (await readJsonBody(req));
                const code = typeof body?.code === 'string' ? body.code : '';
                if (!code.trim()) {
                    writeJson(res, 400, { ok: false, error: 'code required' });
                    return;
                }
                writeJson(res, 200, { ok: true, submitted: gateway.submitVerifyCode(code) });
            }
            catch (err) {
                ctx.logger.warn('[dsh-wechat-bridge] pair/verify-code failed: %s', String(err));
                writeJson(res, 500, { ok: false, error: 'internal' });
            }
        },
    });
    ctx.webServer.register({
        kind: 'exact',
        path: SESSIONS_PATH,
        handler: async (req, res) => {
            if (!guard(req, res))
                return;
            if (req.method !== 'GET') {
                writeJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            try {
                const sessions = listSessions(node).slice(0, 100).map((session) => buildSessionInfo(node, session));
                writeJson(res, 200, { ok: true, sessions });
            }
            catch (err) {
                ctx.logger.warn('[dsh-wechat-bridge] sessions endpoint failed: %s', String(err));
                writeJson(res, 500, { ok: false, error: 'internal' });
            }
        },
    });
    ctx.webServer.register({
        kind: 'exact',
        path: SESSION_ACCESS_PATH,
        handler: async (req, res) => {
            if (!guard(req, res) || !postOnly(req, res))
                return;
            try {
                const body = (await readJsonBody(req));
                const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
                if (!sessionId || typeof body?.enabled !== 'boolean') {
                    writeJson(res, 400, { ok: false, error: 'sessionId and enabled required' });
                    return;
                }
                const session = ctx.sessions.get(sessionId);
                if (!session) {
                    writeJson(res, 404, { ok: false, error: 'session not found' });
                    return;
                }
                if (body.enabled)
                    node.enableSessionWechat(sessionId);
                else
                    node.disableSessionWechat(sessionId);
                writeJson(res, 200, { ok: true, sessionId, enabled: node.isSessionWechatEnabled(sessionId) });
            }
            catch (err) {
                ctx.logger.warn('[dsh-wechat-bridge] session-access endpoint failed: %s', String(err));
                writeJson(res, 500, { ok: false, error: 'internal' });
            }
        },
    });
    ctx.webServer.register({
        kind: 'exact',
        path: PAUSE_PATH,
        handler: async (req, res) => {
            if (!guard(req, res) || !postOnly(req, res))
                return;
            try {
                const body = (await readJsonBody(req));
                // Strict boolean: body.paused must be `true` exactly. Using
                // Boolean(body.paused) would turn the string "false" (or "0") into
                // true and make the panel unable to resume from a pause.
                node.setPaused(body?.paused === true);
                writeJson(res, 200, { ok: true, paused: node.isPaused() });
            }
            catch (err) {
                ctx.logger.warn('[dsh-wechat-bridge] pause endpoint failed: %s', String(err));
                writeJson(res, 500, { ok: false, error: 'internal' });
            }
        },
    });
    ctx.webServer.register({
        kind: 'exact',
        path: PAIR_REVOKE_PATH,
        handler: async (req, res) => {
            if (!guard(req, res) || !postOnly(req, res))
                return;
            try {
                const body = (await readJsonBody(req));
                const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
                if (!userId) {
                    writeJson(res, 400, { ok: false, error: 'userId required' });
                    return;
                }
                writeJson(res, 200, { ok: true, revoked: await node.revokePairedUser(userId) });
            }
            catch (err) {
                ctx.logger.warn('[dsh-wechat-bridge] pair/revoke failed: %s', String(err));
                writeJson(res, 500, { ok: false, error: 'internal' });
            }
        },
    });
}
//# sourceMappingURL=host-api.js.map