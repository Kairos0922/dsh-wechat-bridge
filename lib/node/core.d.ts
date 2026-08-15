/**
 * WechatBridgeNode — the orchestration state behind the bridge plugin.
 *
 * Holds session targeting, the allowlist, pending approvals, and wires the
 * inbound/outbound/command/approval bridges onto the Cordis context.
 * Session creation routes agent presets through the PresetRegistry
 * (dynamic multi-mode routing — differentiator #1).
 *
 * @module dsh-wechat-bridge/node/core
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import { type PendingApproval } from './approvals.ts';
import { PresetRegistry } from './presets.ts';
/** Default-model service seam (provided by dsh-base; sibling loader entry). */
declare module '@deepseek-ai/cordis' {
    interface Context {
        agentDefaultModel?: {
            currentSelection(): {
                provider?: string;
                model?: string;
                reasoningEffort?: string;
            };
        };
    }
}
/** Runtime shape of the node config (defaults applied). */
export interface ResolvedNodeConfig {
    allowFrom: string[];
    digestIntervalSec: number;
    approvalTimeoutSec: number;
    maxMessageChars: number;
    sendChunkDelayMs: number;
    cwd?: string;
    defaultMode?: string;
    agentProvider?: string;
    agentModel?: string;
    mediaDir?: string;
}
/** Default session id prefix for /new-created sessions. */
export declare function newSessionId(): SessionId;
export declare class WechatBridgeNode {
    /** The active session the WeChat user drives. */
    activeSessionId: SessionId | null;
    /** The allowlisted peer outbound text goes to (last inbound sender). */
    peerId: string | null;
    /** Latest iLink context token echoed back on replies. */
    peerContextToken: string | null;
    readonly ctx: Context;
    readonly resolved: ResolvedNodeConfig;
    readonly presets: PresetRegistry;
    private readonly pending;
    private approvalCounter;
    private disposers;
    constructor(ctx: Context, config: ResolvedNodeConfig);
    /** Mount the bridge: outbound digest, approval answerer, inbound gate. */
    attach(): void;
    dispose(): void;
    /** The active session, if any. */
    activeSession(): Session | undefined;
    /** The agent driving the active session, if any. */
    activeAgent(): Agent | undefined;
    /** Whether this node drives the given agent (its session is active). */
    ownsAgent(agent: Agent): boolean;
    /** Whether a WeChat sender may drive the bridge. */
    isAllowed(senderId: string): boolean;
    /** Pick the most recent session as the default target. */
    pickDefaultSession(): void;
    /** Create a fresh agent+session for a mode (preset) and make it active. */
    createSession(prompt: string, mode?: string): Promise<void>;
    /** Route one inbound text: commands first, then the active agent. */
    handleText(text: string): Promise<void>;
    nextApprovalNumber(): number;
    registerApproval(number: number, approval: PendingApproval): void;
    clearApproval(number: number): void;
    /**
     * Resolve a pending approval from a WeChat reply. `/yes`/`/no` answer the
     * most recent request; bare `1`/`2` only while exactly one is pending.
     */
    resolveApproval(text: string): boolean;
}
//# sourceMappingURL=core.d.ts.map