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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Plugin config. `allowFrom` is REQUIRED and validated at apply time. */
export interface NodeConfig {
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
    /** Provider route for `/new` agents. */
    agentProvider?: string;
    /** Model id for `/new` agents. */
    agentModel?: string;
    /** Media storage dir for inbound images (default: $DSH_HOME/storages/dsh-wechat-bridge/media). */
    mediaDir?: string;
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
}>>;
/** Plugin identity + service deps (object form, resolved per plugin row). */
export declare const name = "wechat-bridge-node";
export declare const inject: string[];
declare function apply(ctx: Context, config: NodeConfig): void;
export declare const wechatBridgeNode: {
    name: string;
    inject: string[];
    Config: z<Schemastery.ObjectS<{
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
    }>>;
    apply: typeof apply;
};
export {};
//# sourceMappingURL=index.d.ts.map