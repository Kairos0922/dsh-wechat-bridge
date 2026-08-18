/**
 * WechatBridgeNode — the orchestration state behind the bridge plugin.
 *
 * Owns: the hard allowlist, per-peer session binding (multi-friend routing),
 * persistent prefs (model/cwd) and peer bindings, numbered choice menus
 * (mode/model/workspace), pending approvals, and the single rate-limit-aware
 * outbound queue. Session creation routes agent presets through the DSH
 * `agentPresets` service (dynamic multi-mode routing — differentiator #1)
 * and stamps the durable `origin: 'wechat'` header so DSH surfaces render
 * the 🟢 WeChat badge.
 *
 * @module dsh-wechat-bridge/node/core
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import type { MessageItem } from '../gateway/types.ts';
import { type PendingApproval } from './approvals.ts';
import { BridgeState } from './state.ts';
import { Outbox, type OutboxEntryKind } from './outbox.ts';
import type { MarkdownMode } from './markdown.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Default-model service seam (provided by dsh-base; sibling loader entry). */
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
    approvalTimeoutSec: number;
    maxMessageChars: number;
    /** Minimum spacing between outbound sends (rate-limit hygiene). */
    minSendIntervalMs: number;
    /** Escalating pause steps after errcode -12 (rate limit). */
    rateLimitBackoffSecs: number[];
    /** Sliding-window send budget window (ms). */
    sendBudgetWindowSec: number;
    /** Sliding-window send budget: max sends per window. */
    sendBudgetMaxPerWindow: number;
    /** Full outbound pause after errcode -14 (session expired). */
    sessionExpiredPauseMin: number;
    /** How often the thinking digest refreshes while a turn is active (sec). */
    thinkingDigestSec: number;
    /** Re-send the typing indicator every N seconds during a long turn (0 = off). */
    typingHeartbeatSec: number;
    /** Numbered choice menus expire after this (sec). */
    menuTimeoutSec: number;
    /** WeChat-bound Markdown rendering policy. */
    markdownMode: MarkdownMode;
    /** Tool-name prefixes that get progress cards; empty = cards disabled. */
    progressToolPrefixes: string[];
    cwd?: string;
    defaultMode?: string;
    agentProvider?: string;
    agentModel?: string;
    mediaDir?: string;
    /** Answers longer than this (chars) ship as a file attachment. */
    fileThresholdChars: number;
    /** Proactively announce task completion (turns ≥ notifyMinTurnSec only). */
    notifyOnComplete: boolean;
    /** Minimum turn duration (sec) before completion notifications fire. */
    notifyMinTurnSec: number;
    /** Delete media/export files older than this many days. */
    mediaRetentionDays: number;
    /** Group chats the bridge may serve: room id → allowed senders. */
    allowGroups: Array<{
        roomId: string;
        allowFrom: string[];
    }>;
    /** Long-image card mode: 'off' | 'long'. */
    cardMode: 'off' | 'long';
    /** Notify trusted users when a non-allowlisted sender attempts contact. */
    notifyRejected: boolean;
    /** Chrome binary path for the long-card renderer (auto-detected when unset). */
    chromePath?: string;
}
/** Default session id prefix for /new-created sessions. */
export declare function newSessionId(): SessionId;
/**
 * Outbox coalesce-key prefix for approval prompts (per-approval key:
 * `approval:<peer>:<number>`). A dropped prompt is marked for re-push
 * (approvalPromptDropped); a re-push of the same approval replaces its
 * still-queued copy instead of duplicating (coalesce semantics).
 */
export declare const APPROVAL_COALESCE_PREFIX = "approval:";
/** First-run welcome message sent to the pairer right after QR confirmation. */
export declare function buildWelcomeMessage(opts: {
    allowFromEmpty: boolean;
    defaultModeName: string | null;
}): string;
/** One numbered choice menu pending for a peer. */
export interface PendingMenu {
    kind: 'mode' | 'provider' | 'model' | 'workspace';
    options: Array<{
        label: string;
        value: string;
    }>;
    /** Extra choice context (e.g. the provider a model menu belongs to). */
    context?: string;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout>;
}
export declare class WechatBridgeNode {
    readonly ctx: Context;
    readonly resolved: ResolvedNodeConfig;
    readonly state: BridgeState;
    readonly outbox: Outbox;
    /** peerId → active session (persisted through state). */
    private readonly peerSessions;
    /** sessionId → owning peer (so outbound events route back correctly). */
    private readonly sessionOwners;
    /** Latest iLink context token per peer, echoed back on replies. */
    private readonly peerContextTokens;
    /** Latest iLink run id per peer — progress cards associate to it. */
    private readonly peerRunIds;
    /** Outbound target per peer: sender id for 1:1, room id for groups. */
    private readonly peerTargets;
    private readonly menus;
    /** Last user prompt per peer (for /retry). */
    private readonly lastUserText;
    private readonly pending;
    private approvalCounter;
    /**
     * Peers whose approval prompt failed to deliver (outbox drop). The prompt
     * is re-pushed on the peer's next inbound message — the user is at the
     * phone exactly then, and the channel is demonstrably alive.
     */
    private readonly approvalPromptDropped;
    private disposers;
    constructor(ctx: Context, config: ResolvedNodeConfig);
    /** Mount the bridge: outbound digest, approval answerer, inbound gate. */
    attach(): void;
    dispose(): void;
    private dispatchOutboxEntry;
    /** One actual send for an outbox entry (kind-dispatch). */
    private sendWithEntry;
    /** Enqueue a text-ish bubble for a peer (chunking already applied by callers). */
    enqueueText(peerId: string, text: string, opts?: {
        kind?: OutboxEntryKind;
        priority?: number;
        coalesceKey?: string;
    }): void;
    /**
     * Enqueue an approval prompt with the approval coalesce key — a newer
     * prompt replaces a still-queued older one (never piles up), and a dropped
     * one is marked for re-push on the peer's next inbound message.
     */
    enqueueApprovalPrompt(peerId: string, text: string, number: number): void;
    /**
     * Re-push the peer's pending approval prompt after a delivery failure —
     * called on the peer's next inbound message (channel recovered, user at
     * the phone). No-op unless a prompt was actually dropped and the approval
     * is still within its waiting window.
     */
    retryApprovalPrompt(peerId: string): void;
    /** Enqueue a bot progress card item (TOOL_CALL_START / TOOL_CALL_RESULT). */
    enqueueToolCard(peerId: string, kind: 'tool-start' | 'tool-result', item: MessageItem): void;
    /** Enqueue a local file/image/video artifact for CDN upload + send. */
    enqueueMedia(peerId: string, kind: 'file' | 'image' | 'video', filePath: string, fileName: string, fallbackText?: string): void;
    /** Whether this peer key routes to a group chat (quiet-mode rules apply). */
    isGroupPeer(peerId: string): boolean;
    /** Remember the peer's outbound target (room id for groups). */
    setPeerTarget(peerId: string, target: string): void;
    outboxPausedUntil(): number | null;
    /** The owning peer of a session, if known. */
    peerOf(sessionId: string): string | null;
    /** The peer's active session, if any. */
    activeSession(peerId: string): Session | undefined;
    /** The agent driving the peer's active session, if any. */
    activeAgent(peerId: string): Agent | undefined;
    /** Whether this node drives the given agent (its session belongs to a peer). */
    ownsAgent(agent: Agent): boolean;
    /** Public accessor for the status panel: the pairer's auto-allowlisted id. */
    getPairedUserId(): Promise<string | null>;
    /** The pairer's WeChat id (auto-allowlisted), read from credentials. */
    private pairedUserIdCache;
    private pairedUserIdAt;
    private readonly pairedUserIdTtlMs;
    /**
     * The WeChat id of the account that scanned the pairing QR — the implicit
     * owner/trust anchor. Cached briefly; refreshed after a (re)pairing takes
     * effect within one TTL.
     */
    private pairedUserId;
    /** Whether a WeChat sender may drive the bridge: configured allowFrom ∪ all pairing-confirmed scanners. */
    isAllowed(senderId: string): Promise<boolean>;
    /** All pairing-confirmed trusted WeChat ids (persisted). */
    listPairedUserIds(): string[];
    /** Set (and persist) the peer's active session. */
    setActiveSession(peerId: string, sessionId: SessionId | null): void;
    /** Sessions this peer owns, most-recent-first. */
    sessionsForPeer(peerId: string): Session[];
    /** Remember the peer's latest context token (echoed on replies). */
    setPeerContextToken(peerId: string, token: string | null): void;
    /** Remember the peer's latest run id (progress-card association). */
    setPeerRunId(peerId: string, runId: string | null): void;
    getPeerContextToken(peerId: string): string | null;
    rememberUserText(peerId: string, text: string): void;
    getUserText(peerId: string): string | null;
    /** Open (or replace) a numbered choice menu for a peer. */
    registerMenu(peerId: string, kind: PendingMenu['kind'], options: Array<{
        label: string;
        value: string;
    }>, context?: string): void;
    clearMenu(peerId: string): void;
    hasMenu(peerId: string): boolean;
    /** Try to resolve a bare-number reply against the peer's open menu. */
    tryResolveMenu(peerId: string, text: string): boolean;
    private onMenuChoice;
    private listModels;
    /** Create a fresh agent+session for a mode (preset) and make it active. */
    createSession(peerId: string, prompt: string, mode?: string): Promise<void>;
    /**
     * Natural-language stop words answered ONLY while a turn is running — a
     * WeChat user says "停" instead of typing /stop; nothing is intercepted
     * while idle so ordinary messages never get swallowed.
     */
    private readonly stopWords;
    /** Request cancellation of the peer's running turn with instant feedback. */
    stopTurn(peerId: string): Promise<void>;
    /** Route one inbound text: menus/approvals → commands → the active agent. */
    handleText(peerId: string, text: string): Promise<void>;
    /** Resume a persisted session's agent (dsh-agent registry). */
    private resumeSession;
    /** User-facing mode name (falls back to the id when no display name). */
    private modeDisplayName;
    /**
     * Most recent ownerless WeChat session id, for continuity migration. Live
     * sessions win; after a restart the persisted headers are consulted so the
     * binding survives even before the session is opened in the Web UI.
     *
     * Multi-user guard: only a peer with own history (a message context token
     * or a prior session binding) may pick up an orphan. A brand-new user must
     * not inherit another user's closed/released session.
     */
    private pickOrphanSession;
    nextApprovalNumber(): number;
    registerApproval(number: number, approval: PendingApproval): void;
    clearApproval(number: number): void;
    /**
     * Resolve a pending approval from a WeChat reply. `/yes`/`/no` answer the
     * most recent request of THAT peer; bare `1`/`2` only while exactly one of
     * the peer's requests is pending.
     */
    resolveApproval(text: string, peerId: string): boolean;
}
//# sourceMappingURL=core.d.ts.map