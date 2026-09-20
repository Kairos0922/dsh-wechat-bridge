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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { attachApprovalBridge, buildApprovalPrompt } from "./approvals.js";
import { attachUserQuestionBridge, buildQuestionPrompt } from "./questions.js";
import { listSessions, routeCommand } from "./commands.js";
import { handleInbound } from "./inbound.js";
import { attachSessionOutbound, sendTextToPeer, splitForWechat } from "./outbound.js";
import { listModes } from "./presets.js";
import { attachMediaRetention } from "./retention.js";
import { resolveMode } from "./presets.js";
import { debugLog, debugLogEvent } from "../debug-log.js";
import { BridgeState } from "./state.js";
import { Outbox, OUTBOX_PRIORITY } from "./outbox.js";
import { InboundDebouncer } from "./debounce.js";
/** Default session id prefix for /new-created sessions. */
export function newSessionId() {
    return SessionId(`wechat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}
/**
 * Creation timestamp embedded in a bridge session id
 * (`wechat-<base36 ms>-<rand>`). Ids are ordered by construction, so this is the
 * fallback ordering key when the host exposes no header list. Foreign ids
 * (tests, imports) yield 0 and therefore never win the "newest" comparison.
 */
export function sessionIdCreatedAt(id) {
    const match = /^wechat-([0-9a-z]+)-/.exec(id);
    if (!match?.[1])
        return 0;
    const parsed = Number.parseInt(match[1], 36);
    return Number.isFinite(parsed) ? parsed : 0;
}
/**
 * Outbox coalesce-key prefix for approval prompts (per-approval key:
 * `approval:<peer>:<number>`). A dropped prompt is marked for re-push
 * (approvalPromptDropped); a re-push of the same approval replaces its
 * still-queued copy instead of duplicating (coalesce semantics).
 */
export const APPROVAL_COALESCE_PREFIX = 'approval:';
/**
 * Outbox coalesce-key prefix for `ask_user_question` prompts (per-request key:
 * `question:<peer>:<number>`). Mirrors the approval prefix so a dropped
 * question is re-pushed on the peer's next inbound message instead of leaving
 * the turn blocked behind an answer the user never saw.
 */
export const QUESTION_COALESCE_PREFIX = 'question:';
/**
 * Cap on MUST-DELIVER messages kept per peer for re-push after a channel
 * outage — a long outage must not dump a wall of stale messages.
 */
export const CRITICAL_RESEND_CAP = 3;
/** Hard upper bound for best-effort outbound drain during synchronous dispose. */
export const DRAIN_DEADLINE_MS = 4_000;
/** Allowlist entries left unused this long are likely inert configuration. */
export const ALLOWLIST_ZERO_MATCH_MS = 24 * 60 * 60_000;
/** First-run welcome message sent to the pairer right after QR confirmation. */
export function buildWelcomeMessage(opts) {
    const trust = opts.allowFromEmpty
        ? '🔓 你已通过扫码自动获得白名单，可直接使用。'
        : '🔒 白名单已按配置生效，可直接使用。';
    const defaultLine = opts.defaultModeName !== null
        ? `· 直接发消息将使用默认模式：${opts.defaultModeName}（/modes 可切换）`
        : '· 直接发消息将使用 DSH 默认角色（/modes 可切换）';
    return [
        '✅ 微信桥配对成功，欢迎使用！',
        trust,
        '',
        '快速上手：',
        defaultLine,
        '· 发送 /modes 查看全部可用模式（回复编号直接开会话）',
        '· 发送 /new <模式> <任务> 指定模式开会话',
        '· /status 查看会话与通道状态 · /help 查看全部命令',
        '',
        '提示：危险操作会先征求你的批准（/yes 或 /no），放心使用。',
    ].join('\n');
}
export class WechatBridgeNode {
    ctx;
    resolved;
    state;
    outbox;
    /**
     * P0 (OpenClaw 2.0 alignment): per-peer record of the latest UNCERTAIN
     * outbound send (timed out without a confirmed server result). Never
     * auto-resent (duplicate risk); consumed as a one-line system note on the
     * peer's next inbound text message (takeUncertainNotice).
     */
    uncertainSends = new Map();
    /**
     * P1-6 (OpenClaw 2.0 alignment #131129): allowFrom entries that matched at
     * least one inbound sender. Entries absent after ALLOWLIST_ZERO_MATCH_MS
     * are probably inert (wxid normalization drift) and get a startup+runtime
     * warning — an allowlist guard that silently never fires is a security bug.
     */
    allowFromHits = new Set();
    allowFromWarned = new Set();
    /** peerId → active session (persisted through state). */
    peerSessions = new Map();
    /** sessionId → owning peer (so outbound events route back correctly). */
    sessionOwners = new Map();
    /** Latest iLink context token per peer, echoed back on replies. */
    peerContextTokens = new Map();
    /** Latest iLink run id per peer — progress cards associate to it. */
    peerRunIds = new Map();
    /** Outbound target per peer: sender id for 1:1, room id for groups. */
    peerTargets = new Map();
    menus = new Map();
    /** Last user prompt per peer (for /retry). */
    lastUserText = new Map();
    /**
     * Last "liveness" per peer: any message delivered to the peer or any
     * inbound from the peer refreshes it. The stall watchdog uses this to tell
     * a genuinely stuck run (no outbound for minutes) from a long but healthy
     * one (heartbeats keep flowing).
     */
    lastActivityAt = new Map();
    /** Per-peer throttle for the busy-queue notice (one per 2 min max). */
    lastBusyAckAt = new Map();
    /** Per-peer throttle for the stall notice (one per stall window). */
    lastStallNoticeAt = new Map();
    /** Stall threshold: no outbound AND no inbound for this long → notice. */
    static STALL_MS = 5 * 60_000;
    pending = new Map();
    approvalCounter = 0;
    /**
     * Latest final-answer text per peer (with its WeChat chunks). When a chunk
     * of it is dropped by the outbox, the WHOLE answer joins the recovery
     * resend list — the peer must never get "(2/2)" without "(1/2)".
     */
    pendingAnswers = new Map();
    /**
     * Peers whose whole answer already joined the recovery resend list after a
     * chunk drop — further chunks of the SAME answer must not be appended
     * individually (that would duplicate content on the re-push).
     */
    pendingAnswerRescued = new Set();
    /** Per-sender serialization of inbound message handling (M9 race fix). */
    inboundChains = new Map();
    /** Coalesces rapid plain-text inbound messages per conversation. */
    debouncer;
    /**
     * When the current config was mounted, used to avoid warning immediately
     * about allowFrom entries that have not had time to match.
     */
    allowFromStartedAt = Date.now();
    /**
     * Peers whose approval prompt failed to deliver (outbox drop). The prompt
     * is re-pushed on the peer's next inbound message — the user is at the
     * phone exactly then, and the channel is demonstrably alive.
     */
    approvalPromptDropped = new Set();
    /**
     * `ask_user_question` requests awaiting a WeChat reply, keyed by their prompt
     * number. The turn is BLOCKED on these — see questions.ts.
     */
    pendingQuestions = new Map();
    questionCounter = 0;
    /** Peers whose question prompt failed to deliver (outbox drop). */
    questionPromptDropped = new Set();
    /**
     * MUST-DELIVER messages that were dropped while the channel was down
     * (final answers, error/stop notices). Re-pushed on the peer's next
     * inbound message, in order, up to CRITICAL_RESEND_CAP entries.
     */
    criticalDropped = new Map();
    disposers = [];
    constructor(ctx, config) {
        this.ctx = ctx;
        this.resolved = config;
        // allowFrom is OPTIONAL since 0.2.x: the QR pairing itself is the trust
        // action — the pairer's WeChat id (WEIXIN_ILINK_USER_ID) is auto-allowlisted
        // at runtime (see isAllowed). allowFrom stays as an extra restriction /
        // multi-user gate for power users.
        if (Array.isArray(config.allowFrom) && config.allowFrom.length === 0) {
            this.ctx.logger.warn('[dsh-wechat-bridge] allowFrom is empty — relying on the paired WeChat id as the sole trusted sender. ' +
                'An agent that accepts instructions from any WeChat contact is a prompt-injection front door; ' +
                'only the account that scanned the pairing QR is trusted.');
        }
        this.state = new BridgeState();
        this.debouncer = new InboundDebouncer({
            windowMs: config.inboundDebounceMs ?? 2000,
            onFlush: (payload) => {
                void this.enqueueInbound(payload.senderId, () => handleInbound(this, payload)).catch((err) => {
                    this.ctx.logger.warn('[dsh-wechat-bridge] debounced inbound handling failed: %s', String(err));
                });
            },
        });
        this.outbox = new Outbox({
            minIntervalMs: config.minSendIntervalMs,
            backoffSecs: config.rateLimitBackoffSecs,
            sessionExpiredPauseMs: config.sessionExpiredPauseMin * 60_000,
            // The server's per-window send quota is not public; observed behavior
            // (2026-08-18): ~5-10 sends per session window then prepare failed for
            // minutes. Throttle ourselves below that so the server never rejects.
            budget: {
                windowMs: config.sendBudgetWindowSec * 1000,
                maxPerWindow: config.sendBudgetMaxPerWindow,
            },
            // Server-side per-inbound-window send cap (protocol.md §5, 2026-08-19
            // 实测): ~10 successful sends then `prepare failed` until the peer's
            // next inbound message. The outbox skips non-must entries beyond the
            // cap so heartbeats can never starve the final answer.
            sessionWindowMax: config.sessionWindowSendMax,
            send: (entry) => this.dispatchOutboxEntry(entry),
            // Any message that exhausted its retry budget must not fail silently —
            // the user asked for it and gets a straight answer instead of a mystery.
            // (Files already degrade to text via dispatch; system entries are
            // themselves notices, so notifying again would chain forever on a dead
            // channel.)
            onDrop: (entry, reason, result) => {
                // 'quota': the peer's session window is spent — a SKIPPED non-must
                // entry (heartbeat/todo/context line). Silent by design: retrying is
                // pointless until the user's next inbound resets the window, and the
                // window budget must stay reserved for must-tier messages.
                if (reason === 'quota')
                    return;
                // P0: timeout outcomes are uncertain, never replay automatically.
                if (reason === 'uncertain') {
                    this.rememberUncertain(entry.to, entry.kind);
                    return;
                }
                // MUST-DELIVER messages (approval prompts, final answers, error/stop
                // notices) are NOT dropped for good: they are re-pushed the moment
                // the user's next inbound message proves the channel recovered
                // (see retryApprovalPrompt / retryCriticalMessages). This is the
                // "必须触达" guarantee without a success ack.
                if (entry.resendOnRecovery) {
                    if (reason !== 'coalesced' && entry.to && entry.text) {
                        if (entry.coalesceKey?.startsWith(APPROVAL_COALESCE_PREFIX)) {
                            this.approvalPromptDropped.add(entry.to);
                            debugLogEvent({ event: 'approval-prompt-dropped', peer: entry.to, reason });
                        }
                        else if (entry.coalesceKey?.startsWith(QUESTION_COALESCE_PREFIX)) {
                            // A lost question prompt is worse than a lost approval: the turn
                            // stays blocked until the user answers something they never saw.
                            this.questionPromptDropped.add(entry.to);
                            debugLogEvent({ event: 'question-prompt-dropped', peer: entry.to, reason });
                        }
                        else {
                            // A dropped chunk of a pending final answer re-pushes the WHOLE
                            // answer — the peer must never receive "(2/2)" without "(1/2)".
                            // Once rescued, later chunks of the same answer are dropped
                            // silently (the whole answer already sits in the resend list).
                            const full = this.takePendingAnswerForChunk(entry.to, entry.text);
                            if (full !== null) {
                                this.rememberCriticalDropped(entry.to, full, entry.kind);
                                debugLogEvent({ event: 'critical-message-dropped', peer: entry.to, kind: entry.kind, reason, wholeAnswer: true });
                            }
                            else if (!this.pendingAnswerRescued.has(entry.to)) {
                                this.rememberCriticalDropped(entry.to, entry.text, entry.kind);
                                debugLogEvent({ event: 'critical-message-dropped', peer: entry.to, kind: entry.kind, reason });
                            }
                        }
                    }
                    return;
                }
                if (reason !== 'failed' || entry.kind === 'system' || entry.kind === 'file')
                    return;
                const label = entry.kind === 'image' ? '图片' : entry.kind === 'video' ? '视频' : '消息';
                const err = result?.errmsg ? `：${result.errmsg.slice(0, 120)}` : '';
                this.enqueueText(entry.to ?? '', `❌ ${label}发送失败${err}`, { kind: 'system' });
            },
            // The pump is a floating promise: an escaping error there would be an
            // unhandled rejection, which DSH's fail-loud policy turns into a process
            // exit — losing the whole queue. Swallow it loudly instead.
            onError: (error) => {
                debugLogEvent({ event: 'outbox-pump-error', error: String(error).slice(0, 300) });
                this.ctx.logger.warn('[dsh-wechat-bridge] outbox pump failed: %s', String(error).slice(0, 300));
            },
        });
    }
    /** Mount the bridge: outbound digest, approval answerer, inbound gate. */
    attach() {
        // Migrate the legacy single-owner credential (pre-multi-user) into the
        // persisted paired set so the original owner stays trusted.
        void this.pairedUserId().then((owner) => {
            if (owner)
                this.state.addPairedUserId(owner);
        });
        // Restore persisted peer bindings and owner registry.
        for (const [peerId, sessionId] of this.state.listPeerSessions()) {
            this.peerSessions.set(peerId, SessionId(sessionId));
            this.sessionOwners.set(sessionId, peerId);
        }
        for (const [sessionId, peerId] of this.state.listSessionOwners()) {
            this.sessionOwners.set(sessionId, peerId);
        }
        // Restore context tokens: without them, sends after a restart carry no
        // context_token and the WeChat client may not associate them to a
        // conversation window (official client persists these per account).
        for (const [peerId, token] of this.state.listContextTokens()) {
            this.peerContextTokens.set(peerId, token);
        }
        this.disposers.push(attachSessionOutbound(this));
        // Stall watchdog: a running turn that goes silent (no outbound delivered
        // and no inbound for STALL_MS) is almost certainly stuck (LLM retry loop,
        // dead provider) — the peer gets a visible notice instead of silence.
        const watchdog = setInterval(() => this.watchdogTick(), 60_000);
        watchdog.unref?.();
        this.disposers.push(() => clearInterval(watchdog));
        this.disposers.push(attachApprovalBridge(this));
        // The WeChat peer is the human at the keyboard: answer `ask_user_question`
        // over WeChat instead of letting the turn block on a browser prompt the
        // user cannot see (2026-09-20 incident).
        this.disposers.push(attachUserQuestionBridge(this));
        this.disposers.push(attachMediaRetention(this));
        this.disposers.push(this.ctx.on('wechat/message', (payload) => {
            // P1-4 (OpenClaw 2.0 alignment): coalesce rapid TEXT-only messages
            // from the same conversation into one agent turn before the
            // per-sender chain. Media payloads flush any pending buffer first
            // (ordering preserved), then dispatch themselves immediately.
            for (const ready of this.debouncer.admit(payload)) {
                // Serialized per sender: two rapid messages must not race session
                // resolution (both seeing "no active agent" → two sessions created,
                // or an orphan adopted twice). Chain failures must not break the
                // chain; an unexpected error is logged, never an unhandled rejection.
                void this.enqueueInbound(ready.senderId ?? 'unknown', () => handleInbound(this, ready)).catch((err) => {
                    this.ctx.logger.warn('[dsh-wechat-bridge] inbound handling failed: %s', String(err));
                });
            }
        }));
        // Back-online notice: after consecutive poll failures the gateway emits
        // once on recovery; every trusted peer gets a one-line status ping.
        this.disposers.push(this.ctx.on('wechat/back-online', () => {
            const targets = new Set([...this.resolved.allowFrom, ...this.state.listPairedUserIds()]);
            for (const peer of targets) {
                this.enqueueText(peer, '✅ 已恢复在线', { kind: 'system' });
            }
        }));
        // First-run experience: a freshly confirmed pairing pushes a welcome
        // message straight into the pairer's chat — zero-config onboarding.
        // Trust admission is gated: the first scanner (empty trust set) bootstraps
        // automatically; further scanners are HELD for operator confirmation in
        // the settings panel (see confirmPendingTrust / rejectPendingTrust).
        this.disposers.push(this.ctx.on('wechat/paired', (payload) => {
            if (!payload.userId)
                return;
            void this.handlePairAdmission(payload.userId);
        }));
        // A DIFFERENT bot identity scanned while the old credentials still work:
        // the gateway holds the switch until confirmed — auto-confirm only when
        // the trust set is empty (first-run bootstrap keeps scan-and-go).
        this.disposers.push(this.ctx.on('wechat/pair-pending', () => {
            void this.trustSetSize().then((size) => {
                if (size === 0)
                    void this.ctx.wechat.confirmPairing();
            });
        }));
        // Migration: sessions created before per-peer binding (id prefix `wechat-`,
        // no owner) belong to the allowlisted peers without a binding yet — an
        // upgrade never orphans an ongoing WeChat conversation. Adoption rules
        // (creator match, released exclusion, single-user legacy gate) apply here
        // exactly as at runtime. Newest-first distribution across unbound peers.
        const unbound = this.resolved.allowFrom.filter((peerId) => !this.peerSessions.has(peerId));
        const orphans = listSessions(this).filter((session) => session.id.startsWith('wechat-') && this.sessionOwners.get(session.id) === undefined);
        void (async () => {
            try {
                let orphanIndex = 0;
                for (const peerId of unbound) {
                    while (orphanIndex < orphans.length) {
                        const orphan = orphans[orphanIndex];
                        orphanIndex += 1;
                        if (await this.adoptable(orphan.id, peerId)) {
                            this.setActiveSession(peerId, orphan.id);
                            break;
                        }
                    }
                }
            }
            catch (err) {
                this.ctx.logger.warn('[dsh-wechat-bridge] orphan migration failed: %s', String(err));
            }
        })();
    }
    dispose() {
        for (const disposer of this.disposers)
            disposer();
        this.disposers = [];
        for (const menu of this.menus.values())
            clearTimeout(menu.timer);
        this.menus.clear();
        for (const number of [...this.pending.keys()])
            this.clearApproval(number);
        // Settle pending questions: a disposed node can no longer receive the reply
        // that would unblock them, and a promise that never settles would hang the
        // asker forever. `discard` rejects, which surfaces as a tool error the
        // agent can act on.
        for (const question of [...this.pendingQuestions.values()])
            question.discard();
        // DSH disposers are synchronous. Flush already-seen debounce entries into
        // the serialized inbound chain before closing the state store; otherwise
        // an update can acknowledge a message and then discard it.
        for (const ready of this.debouncer.flushAll()) {
            void this.enqueueInbound(ready.senderId, () => handleInbound(this, ready)).catch((err) => {
                this.ctx.logger.warn('[dsh-wechat-bridge] teardown inbound flush failed: %s', String(err));
            });
        }
        void this.finishDispose();
    }
    async finishDispose() {
        // Inbound work can enqueue replies after its promise resolves, so drain it
        // first and only then wait for the outbox. A single deadline bounds both.
        const started = Date.now();
        const inbound = Promise.allSettled([...this.inboundChains.values()]).then(() => { });
        await Promise.race([
            inbound,
            new Promise((resolve) => setTimeout(resolve, DRAIN_DEADLINE_MS)),
        ]);
        const remaining = Math.max(0, DRAIN_DEADLINE_MS - (Date.now() - started));
        if (remaining > 0) {
            await Promise.race([
                this.outbox.drain().catch(() => { }),
                new Promise((resolve) => setTimeout(resolve, remaining)),
            ]);
        }
        this.outbox.dispose();
        this.state.dispose();
    }
    // ---------------------------------------------------------------- outbox
    async dispatchOutboxEntry(entry) {
        const to = entry.to;
        if (!to)
            return { ok: false, errmsg: 'no peer bound to outbox entry' };
        const target = this.peerTargets.get(to) ?? to;
        let token = this.peerContextTokens.get(to);
        const runId = this.peerRunIds.get(to);
        const result = await this.sendWithEntry(entry, target, token, runId);
        // Any delivered message is liveness: the stall watchdog anchors on this.
        if (result.ok)
            this.lastActivityAt.set(to, Date.now());
        // stale-session（协议.md §5：ret=-2 prepare failed = 用户入站窗口配额
        // 耗尽，不是 token 失效）。**不销毁 token、不 tokenless 重试**——
        // porting-notes 实测 tokenless 5/5 失败；删 token 会让后续出站永久
        // 失效。恢复唯一路径 = 用户下一条入站（新 token + 新窗口），must
        // 条目经恢复重推队列自动补发（对齐 openclaw/wxclawbot：永不销毁
        // context token，宁可等待窗口也不降级）。
        if (result.failureClass === 'stale-session' && token) {
            debugLogEvent({ event: 'send-window-exhausted', peer: to, token: `…${token.slice(-12)}` });
            return result;
        }
        return result;
    }
    /** One actual send for an outbox entry (kind-dispatch). */
    async sendWithEntry(entry, target, contextToken, runId) {
        if (entry.kind === 'tool-start' || entry.kind === 'tool-result') {
            if (entry.item === undefined)
                return { ok: false, errmsg: 'missing item' };
            return this.ctx.wechat.sendItem({ toUserId: target, contextToken, runId, item: entry.item });
        }
        if (entry.kind === 'file' || entry.kind === 'image' || entry.kind === 'video') {
            if (entry.media === undefined)
                return { ok: false, errmsg: 'missing media' };
            if (entry.kind === 'image') {
                return this.ctx.wechat.sendImage({ toUserId: target, filePath: entry.media.filePath, contextToken, runId });
            }
            if (entry.kind === 'video') {
                return this.ctx.wechat.sendVideo({ toUserId: target, filePath: entry.media.filePath, contextToken, runId });
            }
            const result = await this.ctx.wechat.sendFile({
                toUserId: target,
                filePath: entry.media.filePath,
                fileName: entry.media.fileName,
                contextToken,
                runId,
            });
            // Graceful degradation: when the file channel fails outright, deliver the
            // full answer as chunked text instead of losing it behind a dead digest.
            // Fallback fires AT MOST ONCE per entry — after it, the file entry
            // settles (see outbox handleResult) instead of duplicating the text on
            // every transport retry.
            if (!result.ok && entry.text && !entry.fallbackFired) {
                entry.fallbackFired = true;
                const chunks = splitForWechat(entry.text, this.resolved.maxMessageChars);
                for (const [index, chunk] of chunks.entries()) {
                    this.enqueueText(entry.to ?? '', index === 0 ? chunk : chunk, { kind: 'text' });
                }
            }
            return result;
        }
        return this.ctx.wechat.sendText({ toUserId: target, text: entry.text ?? '', contextToken, runId });
    }
    /** Enqueue a text-ish bubble for a peer (chunking already applied by callers). */
    enqueueText(peerId, text, opts = {}) {
        const trimmed = text.trim();
        if (!trimmed)
            return;
        const kind = opts.kind ?? 'text';
        const priority = opts.priority ?? (kind === 'system' ? OUTBOX_PRIORITY.system : kind === 'progress' ? OUTBOX_PRIORITY.progress : OUTBOX_PRIORITY.text);
        this.outbox.enqueue({
            kind,
            priority,
            to: peerId,
            text: trimmed,
            coalesceKey: opts.coalesceKey,
            resendOnRecovery: opts.resendOnRecovery,
            createdAt: Date.now(),
        });
    }
    /**
     * Register the peer's latest final answer so a dropped chunk re-pushes the
     * whole answer. `chunks` must be the exact WeChat delivery units (the same
     * splitForWechat output the outbound path enqueues).
     */
    setPendingAnswer(peerId, full, chunks) {
        if (chunks.length > 1)
            this.pendingAnswers.set(peerId, { full, chunks });
        else
            this.pendingAnswers.delete(peerId);
        // A new answer resets the rescue marker of the previous one.
        this.pendingAnswerRescued.delete(peerId);
    }
    /**
     * If `chunkText` is one of the peer's pending answer chunks, consume the
     * registration and return the WHOLE answer (for re-push); null otherwise.
     * Chunks arrive labeled "(i/n)\n…" (or bare for single-chunk sends).
     */
    takePendingAnswerForChunk(peerId, chunkText) {
        const entry = this.pendingAnswers.get(peerId);
        if (!entry)
            return null;
        const bare = chunkText.replace(/^\(\d+\/\d+\)\n/, '');
        if (!entry.chunks.includes(bare))
            return null;
        this.pendingAnswers.delete(peerId);
        this.pendingAnswerRescued.add(peerId);
        return entry.full;
    }
    /** Sends still available in the peer's session window (outbox accounting). */
    sessionWindowRemaining(peerId) {
        return this.outbox.windowRemaining(peerId);
    }
    /**
     * Enqueue an approval prompt with the approval coalesce key — a newer
     * prompt replaces a still-queued older one (never piles up), and a dropped
     * one is marked for re-push on the peer's next inbound message.
     */
    enqueueApprovalPrompt(peerId, text, number) {
        this.enqueueText(peerId, text, {
            kind: 'system',
            // MUST-DELIVER: approval prompts outrank everything and are exempt from
            // the session-window quota — the user must always be able to say /yes.
            priority: OUTBOX_PRIORITY.must,
            coalesceKey: `${APPROVAL_COALESCE_PREFIX}${peerId}:${number}`,
            resendOnRecovery: true,
        });
    }
    /**
     * Re-push the peer's pending approval prompt after a delivery failure —
     * called on the peer's next inbound message (channel recovered, user at
     * the phone). No-op unless a prompt was actually dropped; re-pushes EVERY
     * pending approval of the peer so concurrent requests stay visible.
     */
    retryApprovalPrompt(peerId) {
        if (!this.approvalPromptDropped.has(peerId))
            return;
        this.approvalPromptDropped.delete(peerId);
        let pushed = 0;
        for (const pending of this.pending.values()) {
            if (pending.peerId !== peerId)
                continue;
            const prompt = buildApprovalPrompt(pending.request, pending.number, this.resolved.approvalTimeoutSec);
            this.enqueueApprovalPrompt(peerId, prompt, pending.number);
            pushed += 1;
        }
        if (pushed > 0) {
            debugLogEvent({ event: 'approval-prompt-resent', peer: peerId, count: pushed });
        }
    }
    /** Record a MUST-DELIVER message for re-push on the peer's next inbound. */
    rememberCriticalDropped(peerId, text, kind) {
        const list = this.criticalDropped.get(peerId) ?? [];
        // De-duplicate identical retries (e.g. the same notice re-enqueued).
        if (list.some((item) => item.text === text))
            return;
        list.push({ text, kind });
        // Cap the backlog: a long outage must not dump a wall of stale messages.
        if (list.length > CRITICAL_RESEND_CAP)
            list.splice(0, list.length - CRITICAL_RESEND_CAP);
        this.criticalDropped.set(peerId, list);
    }
    /**
     * Re-push MUST-DELIVER messages that were dropped while the channel was
     * down — called on the peer's next inbound message (the user is at the
     * phone and the channel is demonstrably alive). Final answers, error/stop
     * notices and the like land here; approval prompts have their own path
     * (retryApprovalPrompt) so they can be rebuilt from live state.
     */
    retryCriticalMessages(peerId) {
        const list = this.criticalDropped.get(peerId);
        if (!list || list.length === 0)
            return;
        this.criticalDropped.delete(peerId);
        for (const item of list) {
            // MUST-DELIVER tier: re-pushed answers/notices outrank the reply to the
            // very message that unblocked the channel. Re-chunked so an oversized
            // answer survives the resend.
            const chunks = splitForWechat(item.text, this.resolved.maxMessageChars);
            for (let i = 0; i < chunks.length; i++) {
                const labeled = chunks.length > 1 && item.kind === 'text' ? `(${i + 1}/${chunks.length})\n${chunks[i]}` : chunks[i];
                this.enqueueText(peerId, labeled, {
                    kind: item.kind,
                    priority: OUTBOX_PRIORITY.must,
                    resendOnRecovery: true,
                });
            }
        }
        debugLogEvent({ event: 'critical-messages-resent', peer: peerId, count: list.length });
    }
    /** Enqueue a bot progress card item (TOOL_CALL_START / TOOL_CALL_RESULT). */
    enqueueToolCard(peerId, kind, item) {
        this.outbox.enqueue({
            kind,
            priority: OUTBOX_PRIORITY.tool,
            to: peerId,
            item,
            createdAt: Date.now(),
        });
    }
    /** Enqueue a local file/image/video artifact for CDN upload + send. */
    enqueueMedia(peerId, kind, filePath, fileName, fallbackText) {
        this.outbox.enqueue({
            kind,
            priority: OUTBOX_PRIORITY.text,
            to: peerId,
            media: { filePath, fileName },
            text: fallbackText,
            createdAt: Date.now(),
        });
    }
    /** Whether this peer key routes to a group chat (quiet-mode rules apply). */
    isGroupPeer(peerId) {
        return peerId.startsWith('group:');
    }
    /** Remember the peer's outbound target (room id for groups). */
    setPeerTarget(peerId, target) {
        this.peerTargets.set(peerId, target);
    }
    outboxPausedUntil() {
        return this.outbox.getPausedUntil();
    }
    // ---------------------------------------------------------------- uncertain delivery / debounce
    rememberUncertain(peer, kind) {
        if (!peer)
            return;
        this.uncertainSends.set(peer, { at: Date.now(), kind });
        debugLogEvent({ event: 'send-uncertain', peer, kind });
    }
    /** Consume the warning for the peer's next inbound text contact. */
    takeUncertainNotice(peerKey) {
        const hit = this.uncertainSends.get(peerKey);
        if (!hit)
            return null;
        this.uncertainSends.delete(peerKey);
        if (Date.now() - hit.at > 24 * 60 * 60_000)
            return null;
        const what = hit.kind === 'image' ? '图片' : hit.kind === 'video' ? '视频' : hit.kind === 'file' ? '文件' : '消息';
        return `[系统备注：上一条回复（${what}）发送超时，可能未送达。如对方表示没收到，可重新发送；不要盲目重发全部历史消息。]`;
    }
    disposeInboundDebounce() {
        for (const dropped of this.debouncer.dispose()) {
            debugLogEvent({ event: 'inbound-debounce-dropped', key: dropped.key, count: dropped.texts.length });
        }
    }
    // ---------------------------------------------------------------- routing
    /** The owning peer of a session, if known. */
    peerOf(sessionId) {
        return this.sessionOwners.get(sessionId) ?? null;
    }
    /** The peer's active session, if any. */
    activeSession(peerId) {
        const id = this.peerSessions.get(peerId);
        if (id === undefined)
            return undefined;
        return this.ctx.sessions.get(id);
    }
    /** The agent driving the peer's active session, if any. */
    activeAgent(peerId) {
        const session = this.activeSession(peerId);
        if (!session)
            return undefined;
        return this.ctx.agents.get(session.id);
    }
    /**
     * Stall watchdog (called every 60s): a peer whose agent is still running
     * but has had NO delivered outbound and NO inbound for STALL_MS gets an
     * explicit notice — silence is not feedback (2026-09-08 stuck-run incident:
     * an OpenRouter 404 retry loop ran for hours with zero notices).
     */
    watchdogTick() {
        for (const peerId of [...this.peerSessions.keys()]) {
            const agent = this.activeAgent(peerId);
            if (agent?.status !== 'running')
                continue;
            const last = this.lastActivityAt.get(peerId) ?? 0;
            const stalledMs = Date.now() - last;
            if (stalledMs < WechatBridgeNode.STALL_MS)
                continue;
            const lastNotice = this.lastStallNoticeAt.get(peerId) ?? 0;
            if (Date.now() - lastNotice < WechatBridgeNode.STALL_MS)
                continue;
            this.lastStallNoticeAt.set(peerId, Date.now());
            const mins = Math.round(stalledMs / 60_000);
            // Silence while blocked on the USER is not a channel failure. Reporting
            // "模型通道异常" there sends the operator hunting the wrong problem: on
            // 2026-09-20 a question the user never received was reported as a model
            // failure five times over 32 minutes. Name the actual blocker instead.
            const blockedOnQuestion = this.hasPendingQuestion(peerId);
            const blockedOnApproval = !blockedOnQuestion && this.hasPendingApproval(peerId);
            // A question the user never saw blocks the turn forever, and the user
            // cannot speak up about a prompt they do not know exists — so a dropped
            // prompt gets a second delivery attempt on every watchdog tick, not only
            // after the peer's next inbound.
            if (blockedOnQuestion)
                this.retryQuestionPrompt(peerId);
            const notice = blockedOnQuestion
                ? `⚠️ 任务已等待你的回答 ${mins} 分钟——有一个提问还没作答，任务卡在这里。回复编号作答，或 /stop 中断。`
                : blockedOnApproval
                    ? `⚠️ 任务已等待你的确认 ${mins} 分钟——有一条审批还没回复。回复 /yes 同意、/no 拒绝，或 /stop 中断。`
                    : `⚠️ 任务已运行 ${mins} 分钟没有动静（可能是模型通道异常）。回复 /stop 中断、/retry 重跑，或继续等待。`;
            this.enqueueText(peerId, notice, { kind: 'system', resendOnRecovery: true });
            debugLogEvent({
                event: 'stall-notice',
                peer: peerId,
                stalledMs,
                blockedOn: blockedOnQuestion ? 'question' : blockedOnApproval ? 'approval' : 'none',
            });
        }
    }
    /** Whether this node drives the given agent (its session belongs to a peer). */
    ownsAgent(agent) {
        return this.sessionOwners.has(agent.session.id);
    }
    /** Public accessor for the status panel: the pairer's auto-allowlisted id. */
    async getPairedUserId() {
        return this.pairedUserId();
    }
    /** The pairer's WeChat id (auto-allowlisted), read from credentials. */
    pairedUserIdCache = null;
    pairedUserIdAt = 0;
    pairedUserIdTtlMs = 30_000;
    /**
     * The WeChat id of the account that scanned the pairing QR — the implicit
     * owner/trust anchor. Cached briefly; refreshed after a (re)pairing takes
     * effect within one TTL.
     */
    async pairedUserId() {
        const now = Date.now();
        if (this.pairedUserIdCache !== null && now - this.pairedUserIdAt < this.pairedUserIdTtlMs) {
            return this.pairedUserIdCache;
        }
        let id = null;
        try {
            // Typed via the dsh-credentials Context augmentation (same service the
            // gateway injects); resolved as an optional service at runtime.
            const credentials = this.ctx.get('credentials');
            const resolved = await credentials?.resolve(credentialRef('WEIXIN_ILINK_USER_ID'));
            const value = resolved?.value;
            id = typeof value === 'string' && value.trim() ? value.trim() : null;
        }
        catch {
            id = null;
        }
        this.pairedUserIdCache = id;
        this.pairedUserIdAt = now;
        return id;
    }
    /** Whether a WeChat sender may drive the bridge: configured allowFrom ∪ all pairing-confirmed scanners. */
    async isAllowed(senderId) {
        if (this.resolved.allowFrom.includes(senderId)) {
            this.allowFromHits.add(senderId);
            this.warnInertAllowFrom();
            return true;
        }
        this.warnInertAllowFrom();
        if (this.state.listPairedUserIds().includes(senderId))
            return true;
        const owner = await this.pairedUserId();
        return owner !== null && senderId === owner;
    }
    warnInertAllowFrom() {
        const age = Date.now() - this.allowFromStartedAt;
        if (age < ALLOWLIST_ZERO_MATCH_MS)
            return;
        for (const entry of this.resolved.allowFrom) {
            if (!this.allowFromHits.has(entry) && !this.allowFromWarned.has(entry)) {
                this.allowFromWarned.add(entry);
                this.ctx.logger.warn('[dsh-wechat-bridge] allowFrom entry has matched no sender for 24h; check wxid normalization: %s', entry);
                debugLogEvent({ event: 'allowfrom-inert', entry });
            }
        }
    }
    /** All pairing-confirmed trusted WeChat ids (persisted). */
    listPairedUserIds() {
        return this.state.listPairedUserIds();
    }
    // ---------------------------------------------------------------- trust set
    /** The full trust set: configured allowFrom ∪ persisted paired scanners ∪ credential owner. */
    async trustSet() {
        const set = new Set([...this.resolved.allowFrom, ...this.state.listPairedUserIds()]);
        const owner = await this.pairedUserId();
        if (owner !== null)
            set.add(owner);
        return set;
    }
    /** Size of the trust set (used for pairing bootstrap and orphan guards). */
    async trustSetSize() {
        return (await this.trustSet()).size;
    }
    /**
     * A scanner whose pairing the gateway confirmed but whose trust admission
     * is held for operator confirmation in the settings panel (the trust set
     * was non-empty at scan time — pairing ≠ blind trust anymore).
     * P2-6: held requests carry a TTL (10 min, cf. the official pairing-store
     * 1h pending TTL) and every admission transition is audit-logged to
     * events.jsonl (requested/approved/rejected/expired).
     */
    pendingTrust = null;
    pendingTrustAt = 0;
    /** Held trust requests expire — an operator cannot confirm a stale scan. */
    static PENDING_TRUST_TTL_MS = 10 * 60_000;
    pendingTrustExpired() {
        return (this.pendingTrust !== null &&
            Date.now() - this.pendingTrustAt > WechatBridgeNode.PENDING_TRUST_TTL_MS);
    }
    get pendingTrustUserId() {
        if (this.pendingTrust !== null && this.pendingTrustExpired()) {
            debugLog({ event: 'pair-audit', action: 'expired', userId: this.pendingTrust });
            this.pendingTrust = null;
        }
        return this.pendingTrust;
    }
    /** Admit the held scanner into the persisted paired set. */
    async confirmPendingTrust() {
        if (this.pendingTrust === null)
            return false;
        if (this.pendingTrustExpired()) {
            debugLog({ event: 'pair-audit', action: 'expired', userId: this.pendingTrust });
            this.pendingTrust = null;
            return false;
        }
        const userId = this.pendingTrust;
        this.pendingTrust = null;
        this.state.addPairedUserId(userId);
        debugLog({ event: 'pair-audit', action: 'approved', userId });
        this.sendWelcome(userId);
        return true;
    }
    /**
     * Trust admission for a confirmed scanner. Already-trusted re-scans are
     * silent no-ops (credential refresh). The first-ever scanner bootstraps
     * the trust set automatically. Everyone else waits for the operator.
     */
    async handlePairAdmission(userId) {
        const set = await this.trustSet();
        if (set.has(userId))
            return;
        if (set.size === 0) {
            this.state.addPairedUserId(userId);
            debugLog({ event: 'pair-audit', action: 'bootstrap', userId });
            this.sendWelcome(userId);
            return;
        }
        this.pendingTrust = userId;
        this.pendingTrustAt = Date.now();
        debugLog({ event: 'pair-audit', action: 'requested', userId });
        this.ctx.logger.info('[dsh-wechat-bridge] scanner %s held for operator confirmation', userId);
    }
    sendWelcome(userId) {
        void this.modeDisplayName(this.resolved.defaultMode ?? '').then((name) => {
            this.enqueueText(userId, buildWelcomeMessage({
                allowFromEmpty: this.resolved.allowFrom.length === 0,
                defaultModeName: this.resolved.defaultMode ? name : null,
            }), { kind: 'system' });
        });
    }
    /** Discard the held scanner (never trusted, nothing persisted). */
    rejectPendingTrust() {
        if (this.pendingTrust === null)
            return false;
        debugLog({ event: 'pair-audit', action: 'rejected', userId: this.pendingTrust });
        this.pendingTrust = null;
        return true;
    }
    /** Operator revocation: unpair, drop the peer's bindings/tokens, tell them. */
    async revokePairedUser(userId) {
        if (!this.state.listPairedUserIds().includes(userId))
            return false;
        this.state.removePairedUserId(userId);
        this.state.clearPeerArtifacts(userId);
        if (this.pendingTrust === userId)
            this.pendingTrust = null;
        // Runtime maps must mirror the state cascade: the in-memory sessionOwners
        // (which peerOf/approval routing read) is a SEPARATE lifecycle from the
        // persisted copy `clearPeerArtifacts` just cleared. Forget this peer's
        // live bindings so a revoked user cannot keep receiving outbound replies
        // or approval prompts for sessions they own until the process restarts.
        const ownedSessionIds = [...this.sessionOwners.entries()]
            .filter(([, owner]) => owner === userId)
            .map(([sessionId]) => sessionId);
        for (const sessionId of ownedSessionIds) {
            this.sessionOwners.delete(sessionId);
            const agent = this.ctx.agents.get(SessionId(sessionId));
            if (agent?.status === 'running')
                agent.cancel({ kind: 'user' });
        }
        this.peerSessions.delete(userId);
        this.peerContextTokens.delete(userId);
        debugLog({ event: 'pair-audit', action: 'revoked', userId });
        this.enqueueText(userId, 'ℹ️ 你的配对已被操作者吊销，后续消息将不再被处理。', { kind: 'system' });
        return true;
    }
    // ------------------------------------------------- rejected-sender notices
    /** Last notice time per stranger (per-sender cooldown). */
    rejectedNoticeAt = new Map();
    rejectedWindowStart = 0;
    rejectedWindowCount = 0;
    // P1-6: bridge-level pause switch — a first-class runtime state (not a
    // process kill). Paused: inbound messages are logged but never routed to
    // the model; the outbox, credentials and sessions are untouched. Exposed
    // in the status snapshot and toggled from the settings panel.
    pausedState = false;
    setPaused(paused) {
        if (this.pausedState === paused)
            return;
        this.pausedState = paused;
        debugLog({ event: 'bridge-pause', paused });
        this.ctx.logger.info('[dsh-wechat-bridge] bridge %s', paused ? 'PAUSED (inbound ignored)' : 'resumed');
    }
    isPaused() {
        return this.pausedState;
    }
    /**
     * Notify all trusted peers that a stranger messaged the bot — rate-limited:
     * at most once per HOUR per stranger (aligned with the official
     * pairing-challenge resend throttle: a stranger's repeat messages must not
     * re-notify the owner), at most 3 per 10 min globally. Without this, a
     * spamming stranger would starve the shared outbox budget (system notices
     * outrank answers) — the transparency feature must not become a
     * denial-of-service amplifier.
     */
    notifyRejectedPeers(senderId) {
        if (!this.resolved.notifyRejected)
            return;
        const now = Date.now();
        const WINDOW = 60 * 60_000;
        if (now - (this.rejectedNoticeAt.get(senderId) ?? 0) < WINDOW)
            return;
        if (now - this.rejectedWindowStart > WINDOW) {
            this.rejectedWindowStart = now;
            this.rejectedWindowCount = 0;
        }
        if (this.rejectedWindowCount >= 3)
            return;
        // Evict stale entries so a flood of unique strangers cannot grow the map.
        if (this.rejectedNoticeAt.size > 1000) {
            for (const [id, at] of this.rejectedNoticeAt) {
                if (now - at >= WINDOW)
                    this.rejectedNoticeAt.delete(id);
            }
            if (this.rejectedNoticeAt.size > 1000)
                this.rejectedNoticeAt.clear();
        }
        this.rejectedNoticeAt.set(senderId, now);
        this.rejectedWindowCount += 1;
        const targets = new Set([...this.resolved.allowFrom, ...this.state.listPairedUserIds()]);
        for (const peer of targets) {
            this.enqueueText(peer, '👤 陌生账号尝试联系（已忽略，未进入任何会话）', { kind: 'system' });
        }
    }
    /** Set (and persist) the peer's active session. */
    setActiveSession(peerId, sessionId) {
        if (sessionId === null) {
            const previous = this.peerSessions.get(peerId);
            if (previous !== undefined) {
                this.peerSessions.delete(peerId);
                // A shared session may still be active for another peer. Only remove
                // the output-route owner when this peer is the current route owner;
                // disabling one peer must never revoke another peer's access.
                if (this.sessionOwners.get(previous) === peerId) {
                    this.sessionOwners.delete(previous);
                    this.state.setSessionOwner(previous, null);
                }
            }
            this.state.setPeerSession(peerId, null);
            return;
        }
        this.peerSessions.set(peerId, sessionId);
        // Binding a shared session must not steal its existing output route. The
        // original owner remains the canonical WeChat recipient; only an unowned
        // session gets its first route owner here.
        const currentOwner = this.sessionOwners.get(sessionId);
        if (currentOwner === undefined) {
            this.sessionOwners.set(sessionId, peerId);
            this.state.setSessionOwner(sessionId, peerId);
        }
        this.state.setPeerSession(peerId, sessionId);
    }
    /** Cleanup hooks fired when a session is released (e.g. digest state). */
    sessionCleanupHooks = new Set();
    /** Register a session-release cleanup hook; returns the unregister. */
    registerSessionCleanup(fn) {
        this.sessionCleanupHooks.add(fn);
        return () => this.sessionCleanupHooks.delete(fn);
    }
    /**
     * Release the peer's active session (/close): unbind and permanently
     * exclude the session from orphan adoption — a closed session never
     * silently changes hands to another peer later.
     */
    releaseSession(peerId) {
        const previous = this.peerSessions.get(peerId);
        if (previous !== undefined) {
            this.state.markSessionReleased(previous);
            for (const fn of this.sessionCleanupHooks)
                fn(previous);
        }
        this.setActiveSession(peerId, null);
    }
    /** Enable or disable access to a session from trusted WeChat peers. */
    enableSessionWechat(sessionId) {
        this.state.setSessionAccess(sessionId, true);
    }
    disableSessionWechat(sessionId) {
        this.state.setSessionAccess(sessionId, false);
    }
    isSessionWechatEnabled(sessionId) {
        return this.state.isSessionAccessEnabled(sessionId);
    }
    /** Sessions explicitly opened for WeChat access. */
    listAccessibleSessions() {
        return listSessions(this).filter((session) => this.isSessionWechatEnabled(session.id)).slice(0, 50);
    }
    /** Sessions this peer owns, most-recent-first. */
    sessionsForPeer(peerId) {
        return listSessions(this)
            .filter((session) => this.sessionOwners.get(session.id) === peerId)
            .slice(0, 50);
    }
    /** Sessions visible to a trusted peer: owned or explicitly opened. */
    sessionsAccessibleToPeer(peerId) {
        // Keep this as the single ordering/filtering seam used by both `/sessions`
        // and `/use N`; changing one without the other would make numbers point at
        // the wrong session.
        return listSessions(this)
            .filter((session) => this.sessionOwners.get(session.id) === peerId || this.isSessionWechatEnabled(session.id))
            .slice(0, 50);
    }
    /** Remember the peer's latest context token (echoed on replies). */
    setPeerContextToken(peerId, token) {
        if (token) {
            this.peerContextTokens.set(peerId, token);
            this.state.setContextToken(peerId, token);
        }
        else {
            this.peerContextTokens.delete(peerId);
            this.state.setContextToken(peerId, null);
        }
    }
    /** Remember the peer's latest run id (progress-card association). */
    setPeerRunId(peerId, runId) {
        if (runId)
            this.peerRunIds.set(peerId, runId);
        else
            this.peerRunIds.delete(peerId);
    }
    getPeerContextToken(peerId) {
        return this.peerContextTokens.get(peerId) ?? null;
    }
    rememberUserText(peerId, text) {
        this.lastUserText.set(peerId, text);
    }
    getUserText(peerId) {
        return this.lastUserText.get(peerId) ?? null;
    }
    // ---------------------------------------------------------------- menus
    /** Open (or replace) a numbered choice menu for a peer. */
    registerMenu(peerId, kind, options, context) {
        this.clearMenu(peerId);
        const expiresAt = Date.now() + this.resolved.menuTimeoutSec * 1000;
        const timer = setTimeout(() => {
            this.menus.delete(peerId);
        }, this.resolved.menuTimeoutSec * 1000);
        timer.unref?.();
        this.menus.set(peerId, { kind, options, context, expiresAt, timer });
    }
    clearMenu(peerId) {
        const menu = this.menus.get(peerId);
        if (menu) {
            clearTimeout(menu.timer);
            this.menus.delete(peerId);
        }
    }
    hasMenu(peerId) {
        return this.menus.has(peerId);
    }
    /** Try to resolve a bare-number reply against the peer's open menu. */
    tryResolveMenu(peerId, text) {
        const menu = this.menus.get(peerId);
        if (!menu)
            return false;
        const trimmed = text.trim();
        if (!/^\d+$/.test(trimmed))
            return false;
        const index = parseInt(trimmed, 10);
        if (index === 0) {
            this.clearMenu(peerId);
            this.enqueueText(peerId, '已取消', { kind: 'system' });
            return true;
        }
        const option = menu.options[index - 1];
        if (option === undefined) {
            // A typo must not end the whole menu interaction: keep it open.
            this.registerMenu(peerId, menu.kind, menu.options, menu.context);
            this.enqueueText(peerId, `❌ 无效编号（可选 1–${menu.options.length}，回复 0 取消）`, { kind: 'system' });
            return true;
        }
        this.clearMenu(peerId);
        void this.onMenuChoice(peerId, menu, option.value);
        return true;
    }
    async onMenuChoice(peerId, menu, value) {
        switch (menu.kind) {
            case 'mode':
                await this.createSession(peerId, '', value);
                return;
            case 'provider': {
                const models = await this.listModels(value);
                if (models.length === 0) {
                    this.enqueueText(peerId, `❌ 供应商 ${value} 没有可列出的模型，可用 /model <provider>/<model> 直接指定`, { kind: 'system' });
                    return;
                }
                this.registerMenu(peerId, 'model', models.slice(0, 20).map((m) => ({ label: m, value: m })), value);
                this.enqueueText(peerId, `🤖 选择模型（回复编号，0 取消）：\n${models.slice(0, 20).map((m, i) => `${i + 1}. ${m}`).join('\n')}`, { kind: 'system' });
                return;
            }
            case 'model': {
                const provider = menu.context;
                if (!provider)
                    return;
                this.state.setPrefs(peerId, { provider, model: value });
                this.enqueueText(peerId, `✅ 模型已设为 ${provider}/${value}（对 /new 新建的会话生效；/model default 恢复跟随 DSH 默认）`, { kind: 'system' });
                return;
            }
            case 'workspace': {
                this.state.setPrefs(peerId, { cwd: value });
                this.enqueueText(peerId, `✅ 工作区已设为 ${value}（对 /new 新建的会话生效；/workspace default 恢复默认）`, { kind: 'system' });
                return;
            }
        }
    }
    async listModels(provider) {
        const llm = this.ctx.get('llm');
        if (!llm)
            return [];
        try {
            const models = await llm.listModels(provider);
            return models.map((m) => m.id);
        }
        catch {
            return [];
        }
    }
    // ---------------------------------------------------------------- sessions
    /** Create a fresh agent+session for a mode (preset) and make it active. */
    async createSession(peerId, prompt, mode) {
        const preset = await resolveMode(this.ctx, mode, this.resolved.defaultMode);
        const meta = {};
        // `{{cwd}}` in preset personas resolves from this meta; always provide one
        // (pref → explicit config → deployment working directory).
        meta.cwd = this.state.getPrefs(peerId).cwd || this.resolved.cwd || process.cwd();
        if (preset)
            meta.agentPreset = preset;
        // Preset personas assemble template variables such as `{{model}}` — an
        // agent created without a model selection fails the assembly. Preference
        // chain: bridge prefs → bridge config → deployment default.
        const fallback = this.ctx.agentDefaultModel?.currentSelection?.() ?? {};
        const provider = this.state.getPrefs(peerId).provider ?? this.resolved.agentProvider ?? fallback.provider;
        const model = this.state.getPrefs(peerId).model ?? this.resolved.agentModel ?? fallback.model;
        try {
            // The agent factory does NOT compose presets from meta.agentPreset on its
            // own — the caller must supply `setup` that mounts the preset onto the
            // agent scope (exactly what the web host's composeAgent does). Without
            // this the session runs on the deployment's default persona.
            const setup = preset
                ? async (agentCtx) => {
                    await this.ctx.agentPresets.mount(agentCtx, preset);
                }
                : undefined;
            const handle = await this.ctx.agents.create({
                sessionId: newSessionId(),
                meta,
                agentOptions: {
                    ...(provider ? { provider } : {}),
                    ...(model ? { model } : {}),
                },
                ...(setup ? { setup } : {}),
            });
            const session = handle.agent.session;
            this.setActiveSession(peerId, session.id);
            this.state.setSessionCreator(session.id, peerId);
            if (prompt) {
                this.rememberUserText(peerId, prompt);
                handle.agent.followup(createUserMessage({
                    content: [{ type: 'text', text: prompt }],
                    source: { kind: 'user' },
                }));
            }
            const modeLabel = preset ? ` · 模式 ${await this.modeDisplayName(preset)}` : '';
            const modelLabel = provider || model ? ` · ${provider ?? '默认'}/${model ?? '默认'}` : '';
            this.enqueueText(peerId, `✅ 已创建新会话${modeLabel || '（默认角色）'}${modelLabel}${prompt ? '，开始处理…' : ''}`, { kind: 'system' });
        }
        catch (error) {
            this.enqueueText(peerId, `❌ 创建会话失败: ${error instanceof Error ? error.message : String(error)}`, { kind: 'system' });
        }
    }
    /**
     * Natural-language stop words answered ONLY while a turn is running — a
     * WeChat user says "停" instead of typing /stop; nothing is intercepted
     * while idle so ordinary messages never get swallowed.
     */
    stopWords = new Set(['停', '停止', '算了', '别做了', '不做了']);
    /** Request cancellation of the peer's running turn with instant feedback. */
    async stopTurn(peerId) {
        const agent = this.activeAgent(peerId);
        if (!agent || agent.status !== 'running') {
            await sendTextToPeer(this, peerId, '✅ 当前没有执行中的任务', { kind: 'system' });
            return;
        }
        agent.cancel({ kind: 'user' });
        await sendTextToPeer(this, peerId, '⏹ 正在停止…', { kind: 'system', priority: OUTBOX_PRIORITY.must });
    }
    /** Route one inbound text: questions/approvals → menus → commands → the active agent. */
    async handleText(peerId, text) {
        debugLog({
            event: 'text',
            from: peerId,
            isCommand: text.trim().startsWith('/'),
            text: text.slice(0, 120),
        });
        if (this.stopWords.has(text.trim())) {
            const agent = this.activeAgent(peerId);
            if (agent?.status === 'running') {
                await this.stopTurn(peerId);
                return;
            }
            // idle: the word is just an ordinary message — fall through
        }
        // A blocked `ask_user_question` needs the reply MORE than anything else
        // does — the turn cannot proceed without it. It is tried before approvals
        // because a question may offer 3+ options, so bare numbers must reach it;
        // an approval's unambiguous `/yes` `/no` still fall through (a slash
        // command is never an answer), only its bare `1`/`2` shortcut can be
        // shadowed while a question is pending.
        if (this.resolveUserQuestion(text, peerId))
            return;
        if (this.resolveApproval(text, peerId))
            return;
        if (this.tryResolveMenu(peerId, text))
            return;
        let routed;
        try {
            routed = await routeCommand(this, peerId, text);
        }
        catch (err) {
            // A failing command must surface as a reply, not as an unhandled
            // rejection that silently swallows the user's message.
            this.ctx.logger.warn('[dsh-wechat-bridge] command failed for %s: %s', peerId, String(err));
            this.enqueueText(peerId, '❌ 命令执行出错，请稍后重试', { kind: 'system' });
            return;
        }
        if (routed === 'handled')
            return;
        const unescaped = routed === 'forward' ? text.replace(/^\/\//, '/') : text;
        let agent = this.activeAgent(peerId);
        if (!agent) {
            // No live agent: resume the peer's bound session first, then their own
            // (owned) most recent session, then their most recent ownerless WeChat
            // session; finally — zero-config default — AUTO-CREATE a session in the
            // default mode. A WeChat user must never be left with "no session"
            // instructions: their message always lands in a working session.
            let restored = null;
            let restoreAttempted = false;
            const bound = this.activeSession(peerId);
            if (bound) {
                restoreAttempted = true;
                try {
                    await this.resumeSession(SessionId(bound.id));
                    agent = this.activeAgent(peerId);
                    restored = bound.id;
                }
                catch {
                    this.setActiveSession(peerId, null); // stale binding — drop it
                }
            }
            if (!agent) {
                // Owned-session recovery. `activeSession()` needs a LIVE Session and
                // the in-memory session store is empty right after a host restart, so a
                // persisted binding can point at nothing reachable. Orphan adoption
                // deliberately skips OWNED sessions (multi-user safety), so without
                // this step a restart silently forks the conversation into a brand-new
                // session in the default mode (2026-09-10 incident).
                const ownedId = await this.pickOwnedSession(peerId);
                if (ownedId !== null) {
                    restoreAttempted = true;
                    try {
                        await this.resumeSession(SessionId(ownedId));
                        this.setActiveSession(peerId, SessionId(ownedId));
                        agent = this.activeAgent(peerId);
                        restored = ownedId;
                    }
                    catch {
                        // unreadable owned session — orphan adoption is the next fallback
                    }
                }
            }
            if (!agent) {
                const orphanId = await this.pickOrphanSession(peerId);
                if (orphanId) {
                    try {
                        await this.resumeSession(SessionId(orphanId));
                        this.setActiveSession(peerId, SessionId(orphanId));
                        agent = this.activeAgent(peerId);
                        restored = orphanId;
                    }
                    catch {
                        // unreadable orphan — fall through to auto-create
                    }
                }
            }
            if (agent && restored) {
                this.enqueueText(peerId, '🟢 已恢复你上次的会话，继续投递…', { kind: 'system' });
            }
            if (!agent) {
                // Never fork a conversation silently: when the peer had a session that
                // could not be revived, say so and point at the surviving record.
                if (restoreAttempted) {
                    this.enqueueText(peerId, '⚠️ 上次的会话暂时没能恢复，已新建会话继续。原会话记录仍在，/sessions 可查看。', { kind: 'system' });
                }
                // Auto-create in the default mode and deliver the message in one go.
                await this.createSession(peerId, unescaped, this.resolved.defaultMode);
                const created = this.activeAgent(peerId);
                if (!created) {
                    this.enqueueText(peerId, '💤 会话创建失败。可尝试 /new [模式] <任务> 手动创建，/modes 查看可用模式。', { kind: 'system' });
                }
                return;
            }
        }
        this.rememberUserText(peerId, unescaped);
        debugLog({ event: 'followup', session: this.activeSession(peerId)?.id ?? null });
        // Any user inbound proves the channel is alive; refresh the stall anchor
        // and give an immediate ack when the session is busy with a prior turn
        // (IM-native silence is not a notice — the peer must know the message was
        // queued, see the 2026-09-08 stuck-run incident).
        this.lastActivityAt.set(peerId, Date.now());
        if (agent.status === 'running' && Date.now() - (this.lastBusyAckAt.get(peerId) ?? 0) > 120_000) {
            this.lastBusyAckAt.set(peerId, Date.now());
            this.enqueueText(peerId, '⏳ 上一条任务还在处理中，你的消息已排队；回复 /stop 可中断，/retry 可重跑。', { kind: 'system' });
        }
        // The agent loop queues follow-ups while a turn is running and processes
        // them afterwards — no queue notice needed (IM-native silence; the
        // thinking heartbeat already signals busy). Messages are never dropped.
        agent.followup(createUserMessage({
            content: [{ type: 'text', text: unescaped }],
            source: { kind: 'user' },
        }));
    }
    /** Resume a persisted session's agent (dsh-agent registry). */
    async resumeSession(sessionId) {
        await this.ctx.agents.resume({ resumeSessionId: sessionId });
    }
    /**
     * Run inbound work for one sender strictly after the previous task for the
     * same sender settled. A throwing task logs and does not poison the chain.
     */
    enqueueInbound(peerId, task) {
        const prev = this.inboundChains.get(peerId) ?? Promise.resolve();
        const next = prev.then(task, (err) => {
            this.ctx.logger.warn('[dsh-wechat-bridge] inbound task failed for %s: %s', peerId, String(err));
        });
        this.inboundChains.set(peerId, next);
        // Map hygiene: once the chain is empty again, drop the entry.
        void next.finally(() => {
            if (this.inboundChains.get(peerId) === next)
                this.inboundChains.delete(peerId);
        });
        return next;
    }
    /** User-facing mode name (falls back to the id when no display name). */
    async modeDisplayName(modeId) {
        try {
            const modes = await listModes(this.ctx);
            return modes.find((m) => m.id === modeId)?.name || modeId;
        }
        catch {
            return modeId;
        }
    }
    /**
     * Most recent ownerless WeChat session id, for continuity migration. Live
     * sessions win; after a restart the persisted headers are consulted so the
     * binding survives even before the session is opened in the Web UI.
     *
     * Multi-user guard: only a peer with own history (a message context token
     * or a prior session binding) may pick up an orphan. A brand-new user must
     * not inherit another user's closed/released session.
     */
    /**
     * Whether `peerId` may adopt the ownerless session `sessionId`. Rules:
     * - sessions explicitly released via /close are NEVER adoptable;
     * - a session is adoptable by its recorded creator;
     * - a legacy session (no recorded creator, pre-migration) is adoptable only
     *   when the whole trust set is ONE person (single-user upgrade path) and
     *   that peer has own history. Multi-user deployments never hand one
     *   peer's history to another.
     */
    async adoptable(sessionId, peerId) {
        if (this.state.isSessionReleased(sessionId))
            return false;
        const creator = this.state.getSessionCreator(sessionId);
        if (creator !== undefined)
            return creator === peerId;
        return (await this.trustSetSize()) === 1 && this.state.hasPeerHistory(peerId);
    }
    /**
     * The peer's most recent OWNED session id (live or merely persisted), for
     * continuity across a host restart. `pickOrphanSession` cannot serve this:
     * it adopts only OWNERLESS sessions (the multi-user safety rule), while the
     * peer's own conversation is by definition owned — which is exactly how a
     * restart used to fork it into a new default-mode session (2026-09-10).
     *
     * Ordering prefers the persisted header `createdAt`; the id's embedded
     * timestamp is the fallback. Released (/close) sessions are never revived.
     */
    async pickOwnedSession(peerId) {
        const boundId = this.peerSessions.get(peerId);
        if (boundId !== undefined && !this.state.isSessionReleased(boundId))
            return boundId;
        const owned = new Set();
        // sessionOwners is restored from persisted state at attach(), so it already
        // covers sessions the current process has never loaded.
        for (const [sessionId, owner] of this.sessionOwners) {
            if (owner === peerId && !this.state.isSessionReleased(sessionId))
                owned.add(sessionId);
        }
        if (owned.size === 0)
            return null;
        const createdAt = new Map();
        try {
            const persistence = this.ctx.get('sessionPersistence');
            for (const header of (await persistence?.list()) ?? [])
                createdAt.set(header.id, header.createdAt);
        }
        catch {
            // Ordering is best-effort; ids stay comparable through their own stamp.
        }
        let best = null;
        let bestAt = -1;
        for (const id of owned) {
            const at = createdAt.get(id) ?? sessionIdCreatedAt(id);
            if (at > bestAt) {
                bestAt = at;
                best = id;
            }
        }
        return best;
    }
    async pickOrphanSession(peerId) {
        if (!this.state.hasPeerHistory(peerId))
            return null;
        // Best-effort recovery: any failure here falls through to auto-create.
        try {
            for (const session of listSessions(this)) {
                if (session.id.startsWith('wechat-') &&
                    this.sessionOwners.get(session.id) === undefined &&
                    (await this.adoptable(session.id, peerId))) {
                    return session.id;
                }
            }
            const persistence = this.ctx.get('sessionPersistence');
            if (!persistence)
                return null;
            const headers = await persistence.list();
            const candidates = headers
                .filter((header) => header.id.startsWith('wechat-') && this.sessionOwners.get(header.id) === undefined)
                .sort((a, b) => b.createdAt - a.createdAt);
            for (const candidate of candidates) {
                if (await this.adoptable(candidate.id, peerId))
                    return candidate.id;
            }
            return null;
        }
        catch {
            return null;
        }
    }
    // ---------------------------------------------------------------- approvals
    nextApprovalNumber() {
        this.approvalCounter += 1;
        return this.approvalCounter;
    }
    registerApproval(number, approval) {
        this.pending.set(number, approval);
    }
    clearApproval(number) {
        const entry = this.pending.get(number);
        if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(number);
        }
    }
    /**
     * Resolve a pending approval from a WeChat reply. `/yes`/`/no` answer the
     * most recent request of THAT peer; bare `1`/`2` only while exactly one of
     * the peer's requests is pending.
     */
    resolveApproval(text, peerId) {
        const entries = [...this.pending.entries()].filter(([, entry]) => entry.peerId === peerId);
        if (entries.length === 0)
            return false;
        const approvalText = text.trim();
        const outcome = approvalText === '/yes' ? 'allowed-once' : approvalText === '/no' ? 'rejected' : undefined;
        if (outcome) {
            const [number, entry] = entries[entries.length - 1];
            this.clearApproval(number);
            entry.resolve(outcome);
            return true;
        }
        if ((approvalText === '1' || approvalText === '2') && entries.length === 1) {
            const [number, entry] = entries[0];
            this.clearApproval(number);
            entry.resolve(approvalText === '1' ? 'allowed-once' : 'rejected');
            return true;
        }
        return false;
    }
    // ---------------------------------------------------------------- questions
    nextQuestionNumber() {
        this.questionCounter += 1;
        return this.questionCounter;
    }
    registerQuestion(number, question) {
        this.pendingQuestions.set(number, question);
    }
    /**
     * Forget a pending question. Settlement belongs to the bridge's own settle
     * path (questions.ts `cleanup`), which deregisters through here — so this is
     * deliberately a plain removal, never a rejection.
     */
    clearQuestion(number) {
        this.pendingQuestions.delete(number);
    }
    /** Whether the peer is blocked waiting on an `ask_user_question` answer. */
    hasPendingQuestion(peerId) {
        for (const pending of this.pendingQuestions.values()) {
            if (pending.peerId === peerId)
                return true;
        }
        return false;
    }
    /** Whether the peer has an approval prompt outstanding (see approvals.ts). */
    hasPendingApproval(peerId) {
        for (const pending of this.pending.values()) {
            if (pending.peerId === peerId)
                return true;
        }
        return false;
    }
    /**
     * Enqueue a question prompt with the question coalesce key — a newer prompt
     * for the same request replaces a still-queued older one (a multi-question
     * request re-renders as the user advances), and a dropped one is marked for
     * re-push on the peer's next inbound message.
     */
    enqueueQuestionPrompt(peerId, text, number) {
        this.enqueueText(peerId, text, {
            kind: 'system',
            // MUST-DELIVER: the whole turn is blocked on this prompt — it outranks
            // everything else and is exempt from the session-window quota.
            priority: OUTBOX_PRIORITY.must,
            coalesceKey: `${QUESTION_COALESCE_PREFIX}${peerId}:${number}`,
            resendOnRecovery: true,
        });
    }
    /**
     * Re-push the peer's pending question prompt after a delivery failure —
     * called on the peer's next inbound message. A question the user never saw
     * blocks the turn indefinitely, so this path matters more than its approval
     * twin: the prompt is rebuilt from live state at the question now on screen.
     */
    retryQuestionPrompt(peerId) {
        if (!this.questionPromptDropped.has(peerId))
            return;
        this.questionPromptDropped.delete(peerId);
        let pushed = 0;
        for (const pending of this.pendingQuestions.values()) {
            if (pending.peerId !== peerId)
                continue;
            this.enqueueQuestionPrompt(peerId, buildQuestionPrompt(pending, this.resolved.questionTimeoutSec), pending.number);
            pushed += 1;
        }
        if (pushed > 0) {
            debugLogEvent({ event: 'question-prompt-resent', peer: peerId, count: pushed });
        }
    }
    /**
     * Feed an inbound message to the peer's oldest pending `ask_user_question`
     * request. Returns whether the message was consumed; `false` lets ordinary
     * routing continue, which is what keeps `/stop` reachable while a question
     * blocks the turn (a slash command is never an answer — see questions.ts).
     */
    resolveUserQuestion(text, peerId) {
        const entries = [...this.pendingQuestions.entries()].filter(([, question]) => question.peerId === peerId);
        if (entries.length === 0)
            return false;
        // Oldest-first (Map insertion order): with several requests outstanding the
        // prompts are answered in the order they were shown.
        const [, pending] = entries[0];
        return pending.submit(text) === 'accepted';
    }
}
//# sourceMappingURL=core.js.map