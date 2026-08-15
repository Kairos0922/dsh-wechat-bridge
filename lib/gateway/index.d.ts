/**
 * wechat-gateway plugin: the iLink gateway as a Cordis service (`ctx.wechat`).
 *
 * M0 skeleton: service shell + lifecycle + status. M1 adds the iLink client
 * (QR login, authenticated long-poll, sendMessage); M3 adds CDN media
 * download. The conversation node consumes this service and never touches
 * iLink directly.
 *
 * Protocol client derived from Tencent/openclaw-weixin (MIT).
 *
 * @module dsh-wechat-bridge/gateway
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export interface GatewayConfig {
    baseUrl?: string;
    cdnBaseUrl?: string;
    token?: string;
    accountId?: string;
}
export declare const GatewayConfig: z<Schemastery.ObjectS<{
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
}>, Schemastery.ObjectT<{
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
}>>;
export type GatewayStatus = 'unauthenticated' | 'pairing' | 'polling' | 'paused' | 'stopped';
export interface ResolvedGatewayConfig extends Required<GatewayConfig> {
}
export declare class WechatGateway extends Service {
    status: GatewayStatus;
    readonly ctx: Context;
    private c;
    constructor(ctx: Context, config: GatewayConfig);
}
export default WechatGateway;
//# sourceMappingURL=index.d.ts.map