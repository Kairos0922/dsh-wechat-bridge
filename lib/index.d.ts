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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { WechatGateway } from './gateway/index.ts';
export { wechatBridgeNode } from './node/index.ts';
export * from './gateway/types.ts';
/** Cordis plugin name used by loader diagnostics and profile config. */
export declare const name = "dsh-wechat-bridge";
/** Services the bundle needs (provided by dsh-base). */
export declare const inject: string[];
/** Bundle config: gateway fields plus the node's policy. */
export interface Config {
    /** Hard allowlist of WeChat sender ids. REQUIRED — no permissive default. */
    allowFrom?: string[];
    /** Heartbeat interval for progress digests (seconds; 0 disables). */
    digestIntervalSec?: number;
    /** Approval prompt timeout before default-deny (seconds). */
    approvalTimeoutSec?: number;
    /** Max chars per WeChat bubble. */
    maxMessageChars?: number;
    /** Throttle between outbound bubbles (ms). */
    sendChunkDelayMs?: number;
    /** Working directory for `/new` sessions. */
    cwd?: string;
    /** Default agent preset for sessions created without an explicit mode. */
    defaultMode?: string;
    /** Provider route override for `/new` agents. */
    agentProvider?: string;
    /** Model id override for `/new` agents. */
    agentModel?: string;
    /** Media storage dir for inbound images (default: $DSH_HOME/storages/dsh-wechat-bridge/media). */
    mediaDir?: string;
    /** iLink gateway base url (defaults to ilinkai.weixin.qq.com). */
    baseUrl?: string;
    /** WeChat CDN base url for media. */
    cdnBaseUrl?: string;
    /** Bot token override (prefer credentials). */
    token?: string;
    /** Bot account id override (prefer credentials). */
    accountId?: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    allowFrom: z<string[], string[]>;
    digestIntervalSec: z<number, number>;
    approvalTimeoutSec: z<number, number>;
    maxMessageChars: z<number, number>;
    sendChunkDelayMs: z<number, number>;
    cwd: z<string, string>;
    defaultMode: z<string, string>;
    agentProvider: z<string, string>;
    agentModel: z<string, string>;
    mediaDir: z<string, string>;
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
}>, Schemastery.ObjectT<{
    allowFrom: z<string[], string[]>;
    digestIntervalSec: z<number, number>;
    approvalTimeoutSec: z<number, number>;
    maxMessageChars: z<number, number>;
    sendChunkDelayMs: z<number, number>;
    cwd: z<string, string>;
    defaultMode: z<string, string>;
    agentProvider: z<string, string>;
    agentModel: z<string, string>;
    mediaDir: z<string, string>;
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
}>>;
/**
 * Mount both plugins. The gateway starts polling only when credentials are
 * present (resolved from the `credentials` service at startup).
 */
export declare function apply(ctx: Context, config: Config): void;
export default apply;
//# sourceMappingURL=index.d.ts.map