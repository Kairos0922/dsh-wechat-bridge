/**
 * wechat-bridge-node plugin: WeChat ⇄ DSH conversation bridge.
 *
 * Consumes the `wechat` gateway service and dsh-base services (`sessions`,
 * `agents`, `approval`). Inbound WeChat text becomes a user message on the
 * sender's active session; session events become digest-style WeChat messages
 * (thinking digest, tool progress cards, todo snapshots, answers). Commands
 * (`/modes /new /use /sessions /stop /status /model /workspace /retry /close
 * /help`) are handled locally. The allowlist gate lives here — non-allowlisted
 * senders are never fed to the model.
 *
 * @module dsh-wechat-bridge/node
 */
import z from '@deepseek-ai/schemastery';
import { MAX_MESSAGE_CHARS } from "../gateway/types.js";
import { WechatBridgeNode } from "./core.js";
import { registerHostApi } from "../host-api.js";
export const Config = z.object({
    allowFrom: z.array(z.string()).default([]),
    approvalTimeoutSec: z.number().default(600),
    maxMessageChars: z.number().default(MAX_MESSAGE_CHARS),
    minSendIntervalMs: z.number().default(5_000),
    rateLimitBackoffSecs: z.array(z.number()).default([10, 30, 60]),
    sessionExpiredPauseMin: z.number().default(60),
    thinkingDigestSec: z.number().default(10),
    typingHeartbeatSec: z.number().default(25),
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
});
/** Plugin identity + service deps (object form, resolved per plugin row). */
export const name = 'wechat-bridge-node';
export const inject = ['wechat', 'sessions', 'agents', 'approval', 'webServer', 'agentDefaultModel', 'agentPresets', 'credentials'];
function apply(ctx, config) {
    const resolved = {
        allowFrom: config.allowFrom ?? [],
        approvalTimeoutSec: config.approvalTimeoutSec ?? 600,
        maxMessageChars: config.maxMessageChars ?? MAX_MESSAGE_CHARS,
        minSendIntervalMs: config.minSendIntervalMs ?? 5_000,
        rateLimitBackoffSecs: config.rateLimitBackoffSecs ?? [10, 30, 60],
        sessionExpiredPauseMin: config.sessionExpiredPauseMin ?? 60,
        thinkingDigestSec: config.thinkingDigestSec ?? 10,
        typingHeartbeatSec: config.typingHeartbeatSec ?? 25,
        menuTimeoutSec: config.menuTimeoutSec ?? 60,
        markdownMode: config.markdownMode ?? 'passthrough',
        progressToolPrefixes: config.progressToolPrefixes ?? [],
        cwd: config.cwd,
        defaultMode: config.defaultMode,
        agentProvider: config.agentProvider,
        agentModel: config.agentModel,
        mediaDir: config.mediaDir,
        fileThresholdChars: config.fileThresholdChars ?? 0,
        notifyOnComplete: config.notifyOnComplete ?? false,
        notifyMinTurnSec: config.notifyMinTurnSec ?? 300,
        mediaRetentionDays: config.mediaRetentionDays ?? 30,
        allowGroups: config.allowGroups ?? [],
        cardMode: config.cardMode ?? 'off',
        chromePath: config.chromePath,
    };
    const node = new WechatBridgeNode(ctx, resolved);
    node.attach();
    ctx.logger.info('[dsh-wechat-bridge] wechat-bridge-node mounted (allowFrom=%d, defaultMode=%s, markdownMode=%s)', resolved.allowFrom.length, resolved.defaultMode || '(unset)', resolved.markdownMode);
    // Settings-panel host API (differentiator #3) — registered here because the
    // node row can inject `wechat` while the bundle row cannot (same-scope mount).
    registerHostApi(ctx, ctx.wechat, node);
    ctx.effect(() => {
        return () => {
            node.dispose();
            ctx.logger.info('[dsh-wechat-bridge] wechat-bridge-node disposed');
        };
    });
}
export const wechatBridgeNode = { name, inject, Config, apply };
//# sourceMappingURL=index.js.map