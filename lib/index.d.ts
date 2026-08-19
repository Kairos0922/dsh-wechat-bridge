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
import type { MarkdownMode } from './node/markdown.ts';
export { WechatGateway } from './gateway/index.ts';
export { wechatBridgeNode } from './node/index.ts';
export * from './gateway/types.ts';
/** Cordis plugin name used by loader diagnostics and profile config. */
export declare const name = "dsh-wechat-bridge";
/** Services the bundle needs (provided by dsh-base and the web shell). */
export declare const inject: string[];
/** Bundle config: gateway fields plus the node's policy. */
export interface Config {
    /** Hard allowlist of WeChat sender ids. REQUIRED — no permissive default. */
    allowFrom?: string[];
    /** Approval prompt timeout before default-deny (seconds). */
    approvalTimeoutSec?: number;
    /** Max chars per WeChat bubble. */
    maxMessageChars?: number;
    /** Minimum spacing between outbound sends (rate-limit hygiene, ms). */
    minSendIntervalMs?: number;
    /** Escalating pause steps after errcode -12 (rate limit), seconds. */
    rateLimitBackoffSecs?: number[];
    /** Full outbound pause after errcode -14 (session expired), minutes. */
    sessionExpiredPauseMin?: number;
    /** Thinking-digest refresh interval while a turn is active (seconds). */
    thinkingDigestSec?: number;
    /** Numbered choice menus expire after this (seconds). */
    menuTimeoutSec?: number;
    /** WeChat-bound Markdown rendering policy: passthrough | filter | plain. */
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
    /** Provider route override for `/new` agents. */
    agentProvider?: string;
    /** Model id override for `/new` agents. */
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
    /** iLink gateway base url (defaults to ilinkai.weixin.qq.com). */
    baseUrl?: string;
    /** WeChat CDN base url for media. */
    cdnBaseUrl?: string;
    /** Bot token override (prefer credentials). */
    token?: string;
    /** Bot account id override (prefer credentials). */
    accountId?: string;
    /** Notify trusted users when a non-allowlisted sender attempts contact. */
    notifyRejected?: boolean;
    /** Re-send the typing indicator every N seconds during a long turn (0 = off). */
    typingHeartbeatSec?: number;
    /** Sliding-window send budget window (seconds). */
    sendBudgetWindowSec?: number;
    /** Sliding-window send budget: max sends per window. */
    sendBudgetMaxPerWindow?: number;
    /** Directories `/video` may read from (default: cwd + media dir). */
    videoRoots?: string[];
    /** Extra trusted hosts for a server-provided baseUrl redirect (login/poll). */
    trustedBaseHosts?: string[];
    /** Extra trusted hosts for media download/upload CDN urls. */
    trustedMediaHosts?: string[];
    /** Non-loopback authorities the settings panel may be served under (LAN). */
    webTrustedHosts?: string[];
}
export declare const Config: z<Config>;
/**
 * Mount both plugins. The gateway starts polling only when credentials are
 * present (resolved from the `credentials` service at startup).
 */
export declare function apply(ctx: Context, config: Config): void;
export default apply;
//# sourceMappingURL=index.d.ts.map