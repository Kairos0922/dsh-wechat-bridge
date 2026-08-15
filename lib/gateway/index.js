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
import { ILINK_BASE_URL } from "./types.js";
export const GatewayConfig = z.object({
    baseUrl: z.string().default(ILINK_BASE_URL),
    cdnBaseUrl: z.string().default(''),
    token: z.string().default(''),
    accountId: z.string().default(''),
});
export class WechatGateway extends Service {
    status = 'unauthenticated';
    ctx;
    c;
    constructor(ctx, config) {
        super(ctx, 'wechat');
        this.ctx = ctx;
        this.c = config;
        ctx.effect(() => {
            this.ctx.logger.info('[dsh-wechat-bridge] wechat-gateway mounted (status=%s, baseUrl=%s)', this.status, this.c.baseUrl);
            return () => {
                this.status = 'stopped';
                this.ctx.logger.info('[dsh-wechat-bridge] wechat-gateway disposed');
            };
        });
    }
}
export default WechatGateway;
//# sourceMappingURL=index.js.map