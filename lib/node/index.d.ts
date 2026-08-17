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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { MarkdownMode } from './markdown.ts';
/** Plugin config. `allowFrom` is REQUIRED and validated at apply time. */
export interface NodeConfig {
    /** Hard allowlist of WeChat sender ids. REQUIRED — no permissive default. */
    allowFrom?: string[];
    /** Approval prompt timeout before default-deny (seconds). */
    approvalTimeoutSec?: number;
    /** Max chars per WeChat bubble. */
    maxMessageChars?: number;
    /** Minimum spacing between outbound sends (rate-limit hygiene). */
    minSendIntervalMs?: number;
    /** Escalating pause steps after errcode -12 (rate limit), seconds. */
    rateLimitBackoffSecs?: number[];
    /** Full outbound pause after errcode -14 (session expired), minutes. */
    sessionExpiredPauseMin?: number;
    /** Thinking-digest refresh interval while a turn is active (seconds). */
    thinkingDigestSec?: number;
    /** Re-send the typing indicator every N seconds during a long turn (0 = off). */
    typingHeartbeatSec?: number;
    /** Numbered choice menus expire after this (seconds). */
    menuTimeoutSec?: number;
    /** WeChat-bound Markdown rendering policy. */
    markdownMode?: MarkdownMode;
    /**
     * Tool-name prefixes that get their own progress cards. Empty = disabled
     * (default): the backend currently drops TOOL_CALL items silently (verified
     * by send-only probes) — enable when the channel supports them.
     */
    progressToolPrefixes?: string[];
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
    /** Answers longer than this (chars) ship as a file attachment; 0 = disabled
     *  (default — the backend cannot fetch bot media content yet, probe-verified). */
    fileThresholdChars?: number;
    /** Proactively announce task completion (turns ≥ notifyMinTurnSec only). */
    notifyOnComplete?: boolean;
    /** Minimum turn duration (sec) before completion notifications fire. */
    notifyMinTurnSec?: number;
    /** Delete media/export files older than this many days. */
    mediaRetentionDays?: number;
    /** Group chats the bridge may serve: room id → allowed senders. */
    allowGroups?: Array<{
        roomId: string;
        allowFrom: string[];
    }>;
    /** Long-image card mode: 'off' | 'long' (default off, skeleton). */
    cardMode?: 'off' | 'long';
    /** Chrome binary path for the long-card renderer (auto-detected when unset). */
    chromePath?: string;
}
export declare const Config: z<NodeConfig>;
/** Plugin identity + service deps (object form, resolved per plugin row). */
export declare const name = "wechat-bridge-node";
export declare const inject: string[];
declare function apply(ctx: Context, config: NodeConfig): void;
export declare const wechatBridgeNode: {
    name: string;
    inject: string[];
    Config: z<NodeConfig>;
    apply: typeof apply;
};
export {};
//# sourceMappingURL=index.d.ts.map