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
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WechatGateway } from './gateway/index.ts';
import type { WechatBridgeNode } from './node/core.ts';
/** Minimal structural typing for the dsh-web `webServer` service seam. */
declare module '@deepseek-ai/cordis' {
    interface Context {
        webServer: {
            register(opts: {
                kind: 'exact';
                path: string;
                handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
            }): void;
        };
    }
}
/**
 * Mirror of the platform's isTrustedApiRequest (dsh-client-connection):
 * true when the Host is ours (loopback or declared trusted) and any attached
 * browser markers are same-origin. Exported for tests.
 */
export declare function isTrustedRequest(req: IncomingMessage, trustedHosts?: readonly string[]): boolean;
export interface HostApiOptions {
    /** Non-loopback authorities this deployment serves (e.g. LAN hostname). */
    trustedHosts?: readonly string[];
}
/** Register the settings-panel endpoints on the harness web server. */
export declare function registerHostApi(ctx: Context, gateway: WechatGateway, node: WechatBridgeNode, opts?: HostApiOptions): void;
//# sourceMappingURL=host-api.d.ts.map