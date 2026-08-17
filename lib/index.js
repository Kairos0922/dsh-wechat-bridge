/**
 * dsh-wechat-bridge — one DSH bundle, two separable Cordis plugins.
 *
 * 1. **wechat-gateway** (`WechatGateway`) — the iLink gateway as the `wechat`
 *    service: QR login, authenticated long-poll, reconnect/backoff, send
 *    retry, typing indicator, CDN media download (M1/M3).
 * 2. **wechat-bridge-node** (`wechatBridgeNode`) — the WeChat ⇄ DSH
 *    conversation bridge: allowlist gate, dynamic agent-preset routing
 *    (`/modes`, `/new <mode>`), approvals, digest outbound, image-in-session
 *    (M2/M3).
 *
 * Protocol client portions derived from Tencent/openclaw-weixin (MIT);
 * architecture informed by Jesse-njx/dsh-chatnode-wechat (MIT).
 * See LICENSE for attributions.
 *
 * @module dsh-wechat-bridge
 */
import z from '@deepseek-ai/schemastery';
import { ILINK_BASE_URL, WEIXIN_CDN_BASE_URL } from "./gateway/types.js";
import { WechatGateway } from "./gateway/index.js";
import { wechatBridgeNode } from "./node/index.js";
export { WechatGateway } from "./gateway/index.js";
export { wechatBridgeNode } from "./node/index.js";
export * from "./gateway/types.js";
/** Cordis plugin name used by loader diagnostics and profile config. */
export const name = 'dsh-wechat-bridge';
/** Services the bundle needs (provided by dsh-base and the web shell). */
export const inject = ['sessions', 'agents', 'approval', 'credentials', 'webServer'];
export const Config = z.object({
    allowFrom: z.array(z.string()).default([]),
    approvalTimeoutSec: z.number().default(600),
    maxMessageChars: z.number().default(2000),
    minSendIntervalMs: z.number().default(5_000),
    rateLimitBackoffSecs: z.array(z.number()).default([10, 30, 60]),
    sessionExpiredPauseMin: z.number().default(60),
    thinkingDigestSec: z.number().default(10),
    menuTimeoutSec: z.number().default(60),
    markdownMode: z.union(['passthrough', 'filter', 'plain']).default('passthrough'),
    progressToolPrefixes: z.array(z.string()).default([]),
    cwd: z.string(),
    defaultMode: z.string(),
    agentProvider: z.string(),
    agentModel: z.string(),
    mediaDir: z.string(),
    fileThresholdChars: z.number().default(0),
    notifyOnComplete: z.boolean().default(false),
    notifyMinTurnSec: z.number().default(300),
    mediaRetentionDays: z.number().default(30),
    allowGroups: z.array(z.object({ roomId: z.string(), allowFrom: z.array(z.string()) })).default([]),
    cardMode: z.union(['off', 'long']).default('off'),
    chromePath: z.string(),
    baseUrl: z.string().default(ILINK_BASE_URL),
    cdnBaseUrl: z.string().default(WEIXIN_CDN_BASE_URL),
    token: z.string().default(''),
    accountId: z.string().default(''),
});
/**
 * Mount both plugins. The gateway starts polling only when credentials are
 * present (resolved from the `credentials` service at startup).
 */
export function apply(ctx, config) {
    ctx.plugin(WechatGateway, {
        baseUrl: config.baseUrl,
        cdnBaseUrl: config.cdnBaseUrl,
        token: config.token,
        accountId: config.accountId,
    });
    ctx.plugin(wechatBridgeNode, {
        allowFrom: config.allowFrom ?? [],
        approvalTimeoutSec: config.approvalTimeoutSec,
        maxMessageChars: config.maxMessageChars,
        minSendIntervalMs: config.minSendIntervalMs,
        rateLimitBackoffSecs: config.rateLimitBackoffSecs,
        sessionExpiredPauseMin: config.sessionExpiredPauseMin,
        thinkingDigestSec: config.thinkingDigestSec,
        menuTimeoutSec: config.menuTimeoutSec,
        markdownMode: config.markdownMode,
        progressToolPrefixes: config.progressToolPrefixes,
        cwd: config.cwd,
        defaultMode: config.defaultMode,
        agentProvider: config.agentProvider,
        agentModel: config.agentModel,
        mediaDir: config.mediaDir,
        fileThresholdChars: config.fileThresholdChars,
        notifyOnComplete: config.notifyOnComplete,
        notifyMinTurnSec: config.notifyMinTurnSec,
        mediaRetentionDays: config.mediaRetentionDays,
        allowGroups: config.allowGroups,
        cardMode: config.cardMode,
        chromePath: config.chromePath,
    });
}
export default apply;
//# sourceMappingURL=index.js.map