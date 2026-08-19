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
import { listSessions, routeCommand } from "./commands.js";
import { handleInbound } from "./inbound.js";
import { attachSessionOutbound, sendTextToPeer, splitForWechat } from "./outbound.js";
import { listModes } from "./presets.js";
import { attachMediaRetention } from "./retention.js";
import { resolveMode } from "./presets.js";
import { debugLog, debugLogEvent } from "../debug-log.js";
import { BridgeState } from "./state.js";
import { Outbox, OUTBOX_PRIORITY } from "./outbox.js";
/** Default session id prefix for /new-created sessions. */
export function newSessionId() {
    return SessionId(`wechat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}
/**
 * Outbox coalesce-key prefix for approval prompts (per-approval key:
 * `approval:<peer>:<number>`). A dropped prompt is marked for re-push
 * (approvalPromptDropped); a re-push of the same approval replaces its
 * still-queued copy instead of duplicating (coalesce semantics).
 */
export const APPROVAL_COALESCE_PREFIX = 'approval:';
/**
 * Cap on MUST-DELIVER messages kept per peer for re-push after a channel
 * outage — a long outage must not dump a wall of stale messages.
 */
export const CRITICAL_RESEND_CAP = 3;
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
    pending = new Map();
    approvalCounter = 0;
    /** Per-sender serialization of inbound message handling (M9 race fix). */
    inboundChains = new Map();
    /**
     * Peers whose approval prompt failed to deliver (outbox drop). The prompt
     * is re-pushed on the peer's next inbound message — the user is at the
     * phone exactly then, and the channel is demonstrably alive.
     */
    approvalPromptDropped = new Set();
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
            send: (entry) => this.dispatchOutboxEntry(entry),
            // Any message that exhausted its retry budget must not fail silently —
            // the user asked for it and gets a straight answer instead of a mystery.
            // (Files already degrade to text via dispatch; system entries are
            // themselves notices, so notifying again would chain forever on a dead
            // channel.)
            onDrop: (entry, reason, result) => {
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
                        else {
                            this.rememberCriticalDropped(entry.to, entry.text, entry.kind);
                            debugLogEvent({ event: 'critical-message-dropped', peer: entry.to, kind: entry.kind, reason });
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
        this.disposers.push(attachApprovalBridge(this));
        this.disposers.push(attachMediaRetention(this));
        this.disposers.push(this.ctx.on('wechat/message', (payload) => {
            // Serialized per sender: two rapid messages must not race session
            // resolution (both seeing "no active agent" → two sessions created,
            // or an orphan adopted twice). Chain failures must not break the
            // chain; an unexpected error is logged, never an unhandled rejection.
            void this.enqueueInbound(payload.senderId ?? 'unknown', () => handleInbound(this, payload)).catch((err) => {
                this.ctx.logger.warn('[dsh-wechat-bridge] inbound handling failed: %s', String(err));
            });
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
        // Stale-session recovery: the server reported the context_token expired
        // ("prepare failed" / "unknown error", protocol.md §5). iLink accepts
        // tokenless sends as a degraded fallback (chatnode/hermes port). Delete
        // the stale token compare-and-delete so a concurrently refreshed token
        // survives, then retry ONCE without a token — this extra attempt does not
        // consume the outbox retry budget, and any later outbox retries are
        // naturally tokenless because the cache entry is gone.
        if (result.failureClass === 'stale-session' && token) {
            if (this.peerContextTokens.get(to) === token) {
                this.setPeerContextToken(to, null);
                debugLogEvent({ event: 'send-token-invalidated', peer: to, token: `…${token.slice(-12)}` });
            }
            // A short pause so the tokenless resend is not a same-instant burst.
            await new Promise((r) => setTimeout(r, 1_000));
            const retried = await this.sendWithEntry(entry, target, undefined, runId);
            debugLogEvent({
                event: 'send-tokenless-retry',
                peer: to,
                ok: retried.ok,
                failureClass: retried.failureClass ?? null,
                errmsg: retried.errmsg?.slice(0, 120) ?? null,
            });
            return retried;
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
     * Enqueue an approval prompt with the approval coalesce key — a newer
     * prompt replaces a still-queued older one (never piles up), and a dropped
     * one is marked for re-push on the peer's next inbound message.
     */
    enqueueApprovalPrompt(peerId, text, number) {
        this.enqueueText(peerId, text, {
            kind: 'system',
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
            this.enqueueText(peerId, item.text, { kind: item.kind, resendOnRecovery: true });
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
        if (this.resolved.allowFrom.includes(senderId))
            return true;
        if (this.state.listPairedUserIds().includes(senderId))
            return true;
        const owner = await this.pairedUserId();
        return owner !== null && senderId === owner;
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
     */
    pendingTrust = null;
    get pendingTrustUserId() {
        return this.pendingTrust;
    }
    /** Admit the held scanner into the persisted paired set. */
    async confirmPendingTrust() {
        if (this.pendingTrust === null)
            return false;
        const userId = this.pendingTrust;
        this.pendingTrust = null;
        this.state.addPairedUserId(userId);
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
            this.sendWelcome(userId);
            return;
        }
        this.pendingTrust = userId;
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
        this.peerSessions.delete(userId);
        this.peerContextTokens.delete(userId);
        this.enqueueText(userId, 'ℹ️ 你的配对已被操作者吊销，后续消息将不再被处理。', { kind: 'system' });
        return true;
    }
    // ------------------------------------------------- rejected-sender notices
    /** Last notice time per stranger (per-sender cooldown). */
    rejectedNoticeAt = new Map();
    rejectedWindowStart = 0;
    rejectedWindowCount = 0;
    /**
     * Notify all trusted peers that a stranger messaged the bot — rate-limited:
     * at most once per 10 min per stranger, at most 3 per 10 min globally.
     * Without this, a spamming stranger would starve the shared outbox budget
     * (system notices outrank answers) — the transparency feature must not
     * become a denial-of-service amplifier.
     */
    notifyRejectedPeers(senderId) {
        if (!this.resolved.notifyRejected)
            return;
        const now = Date.now();
        const WINDOW = 10 * 60_000;
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
                this.sessionOwners.delete(previous);
            }
            this.state.setPeerSession(peerId, null);
            this.state.setSessionOwner(previous ?? '', null);
            return;
        }
        this.peerSessions.set(peerId, sessionId);
        this.sessionOwners.set(sessionId, peerId);
        this.state.setPeerSession(peerId, sessionId);
        this.state.setSessionOwner(sessionId, peerId);
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
    /** Sessions this peer owns, most-recent-first. */
    sessionsForPeer(peerId) {
        return listSessions(this)
            .filter((session) => this.sessionOwners.get(session.id) === peerId)
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
        await sendTextToPeer(this, peerId, '⏹ 正在停止…', { kind: 'system' });
    }
    /** Route one inbound text: menus/approvals → commands → the active agent. */
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
            // No live agent: resume the peer's bound session first; otherwise pick
            // up their most recent ownerless WeChat session; finally — zero-config
            // default — AUTO-CREATE a session in the default mode. A WeChat user
            // must never be left with "no session" instructions: their message
            // always lands in a working session.
            let restored = null;
            const bound = this.activeSession(peerId);
            if (bound) {
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
}
//# sourceMappingURL=core.js.map