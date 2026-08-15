/**
 * Host API for the Web settings panel (differentiator #3):
 * same-origin endpoints the client calls to show gateway status, start a QR
 * pairing, and read the mode list — no CORS, no extra credentials on the wire.
 *
 * @module dsh-wechat-bridge/host-api
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WechatGateway } from './gateway/index.ts';
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
/** Stateless node facts the panel needs (mirrors the bridge node's view). */
export interface HostNodeInfo {
    resolved: {
        allowFrom: string[];
        defaultMode?: string;
    };
    presets: {
        list(): Array<{
            id: string;
        }>;
    };
}
/** Register the settings-panel endpoints on the harness web server. */
export declare function registerHostApi(ctx: Context, gateway: WechatGateway, node: HostNodeInfo): void;
//# sourceMappingURL=host-api.d.ts.map