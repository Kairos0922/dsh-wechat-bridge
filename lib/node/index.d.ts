/**
 * wechat-bridge-node plugin: WeChat ⇄ DSH conversation bridge.
 *
 * M0 skeleton: config + allowlist shell. M2 adds the allowlist gate, the
 * dynamic agent-preset registry (`/modes`, `/new <mode>`), session commands,
 * approvals and digest outbound. M3 adds image-in-session.
 *
 * Consumes the `wechat` gateway service and dsh-base services
 * (`sessions`, `agents`, `approval`, `credentials`).
 *
 * @module dsh-wechat-bridge/node
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export interface NodeConfig {
    allowFrom?: string[];
    digestIntervalSec?: number;
    approvalTimeoutSec?: number;
    maxMessageChars?: number;
    sendChunkDelayMs?: number;
    cwd?: string;
    defaultMode?: string;
    agentProvider?: string;
    agentModel?: string;
}
export declare const NodeConfig: z<Schemastery.ObjectS<{
    allowFrom: z<string[], string[]>;
    digestIntervalSec: z<number, number>;
    approvalTimeoutSec: z<number, number>;
    maxMessageChars: z<number, number>;
    sendChunkDelayMs: z<number, number>;
    cwd: z<string, string>;
    defaultMode: z<string, string>;
    agentProvider: z<string, string>;
    agentModel: z<string, string>;
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
}>>;
export declare function wechatBridgeNode(ctx: Context, config: NodeConfig): void;
export default wechatBridgeNode;
//# sourceMappingURL=index.d.ts.map