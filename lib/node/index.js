/**
 * wechat-bridge-node plugin: WeChat ⇄ DSH conversation bridge.
 *
 * Consumes the `wechat` gateway service and dsh-base services (`sessions`,
 * `agents`, `approval`). Inbound WeChat text becomes a user message on the
 * active session; session events become digest-style WeChat messages.
 * Commands (`/modes /new /use /sessions /stop /status /yes /no`) are handled
 * locally. The allowlist gate lives here — non-allowlisted senders are never
 * fed to the model.
 *
 * @module dsh-wechat-bridge/node
 */
import z from '@deepseek-ai/schemastery';
import { MAX_MESSAGE_CHARS } from "../gateway/types.js";
import { WechatBridgeNode } from "./core.js";
import { registerHostApi } from "../host-api.js";
export const Config = z.object({
    allowFrom: z.array(z.string()).default([]),
    digestIntervalSec: z.number().default(300),
    approvalTimeoutSec: z.number().default(600),
    maxMessageChars: z.number().default(MAX_MESSAGE_CHARS),
    sendChunkDelayMs: z.number().default(1_500),
    cwd: z.string(),
    defaultMode: z.string(),
    agentProvider: z.string(),
    agentModel: z.string(),
    mediaDir: z.string(),
});
/** Plugin identity + service deps (object form, resolved per plugin row). */
export const name = 'wechat-bridge-node';
export const inject = ['wechat', 'sessions', 'agents', 'approval', 'webServer', 'agentDefaultModel', 'agentPresets'];
function apply(ctx, config) {
    const resolved = {
        allowFrom: config.allowFrom ?? [],
        digestIntervalSec: config.digestIntervalSec ?? 300,
        approvalTimeoutSec: config.approvalTimeoutSec ?? 600,
        maxMessageChars: config.maxMessageChars ?? MAX_MESSAGE_CHARS,
        sendChunkDelayMs: config.sendChunkDelayMs ?? 1_500,
        cwd: config.cwd,
        defaultMode: config.defaultMode,
        agentProvider: config.agentProvider,
        agentModel: config.agentModel,
        mediaDir: config.mediaDir,
    };
    const node = new WechatBridgeNode(ctx, resolved);
    node.attach();
    ctx.logger.info('[dsh-wechat-bridge] wechat-bridge-node mounted (allowFrom=%d, modes=%d, defaultMode=%s)', resolved.allowFrom.length, node.presets.list().length, resolved.defaultMode || '(unset)');
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