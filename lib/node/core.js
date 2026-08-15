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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { attachApprovalBridge } from "./approvals.js";
import { listSessions, routeCommand } from "./commands.js";
import { handleInbound } from "./inbound.js";
import { attachSessionOutbound, sendTextToPeer } from "./outbound.js";
import { PresetRegistry } from "./presets.js";
import { debugLog } from "../debug-log.js";
/** Default session id prefix for /new-created sessions. */
export function newSessionId() {
    return SessionId(`wechat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}
export class WechatBridgeNode {
    /** The active session the WeChat user drives. */
    activeSessionId = null;
    /** The allowlisted peer outbound text goes to (last inbound sender). */
    peerId = null;
    /** Latest iLink context token echoed back on replies. */
    peerContextToken = null;
    ctx;
    resolved;
    presets = new PresetRegistry();
    pending = new Map();
    approvalCounter = 0;
    disposers = [];
    constructor(ctx, config) {
        this.ctx = ctx;
        this.resolved = config;
        if (!Array.isArray(config.allowFrom) || config.allowFrom.length === 0) {
            throw new Error('dsh-wechat-bridge: allowFrom is REQUIRED and must list at least one WeChat sender id. ' +
                'An agent that accepts instructions from any WeChat contact is a prompt-injection front door.');
        }
    }
    /** Mount the bridge: outbound digest, approval answerer, inbound gate. */
    attach() {
        this.disposers.push(attachSessionOutbound(this));
        this.disposers.push(attachApprovalBridge(this));
        this.disposers.push(this.ctx.on('wechat/message', (payload) => {
            void handleInbound(this, payload);
        }));
        this.pickDefaultSession();
    }
    dispose() {
        for (const disposer of this.disposers)
            disposer();
        this.disposers = [];
        for (const number of [...this.pending.keys()])
            this.clearApproval(number);
    }
    /** The active session, if any. */
    activeSession() {
        if (!this.activeSessionId)
            return undefined;
        return this.ctx.sessions.get(this.activeSessionId);
    }
    /** The agent driving the active session, if any. */
    activeAgent() {
        const session = this.activeSession();
        if (!session)
            return undefined;
        return this.ctx.agents.get(session.id);
    }
    /** Whether this node drives the given agent (its session is active). */
    ownsAgent(agent) {
        return this.activeSessionId !== null && agent.session.id === this.activeSessionId;
    }
    /** Whether a WeChat sender may drive the bridge. */
    isAllowed(senderId) {
        return this.resolved.allowFrom.includes(senderId);
    }
    /** Pick the most recent session as the default target. */
    pickDefaultSession() {
        const sessions = listSessions(this);
        if (sessions.length > 0)
            this.activeSessionId = sessions[0].id;
    }
    /** Create a fresh agent+session for a mode (preset) and make it active. */
    async createSession(prompt, mode) {
        const preset = this.presets.resolveMode(mode, this.resolved.defaultMode);
        const meta = {};
        if (this.resolved.cwd)
            meta.cwd = this.resolved.cwd;
        if (preset)
            meta.agentPreset = preset;
        try {
            const handle = await this.ctx.agents.create({
                sessionId: newSessionId(),
                meta,
                agentOptions: {
                    ...(this.resolved.agentProvider ? { provider: this.resolved.agentProvider } : {}),
                    ...(this.resolved.agentModel ? { model: this.resolved.agentModel } : {}),
                },
            });
            this.activeSessionId = handle.agent.session.id;
            if (prompt) {
                handle.agent.followup(createUserMessage({
                    content: [{ type: 'text', text: prompt }],
                    source: { kind: 'user' },
                }));
            }
            const modeLabel = preset ? ` · 模式 ${preset}` : '';
            await sendTextToPeer(this, `✅ 已创建新会话 ${handle.agent.session.id}${modeLabel}${prompt ? '，开始处理…' : ''}`);
        }
        catch (error) {
            await sendTextToPeer(this, `❌ 创建会话失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /** Route one inbound text: commands first, then the active agent. */
    async handleText(text) {
        debugLog({
            event: 'text',
            from: this.peerId,
            isCommand: text.trim().startsWith('/'),
            text: text.slice(0, 120),
        });
        if (await routeCommand(this, text))
            return;
        const agent = this.activeAgent();
        if (!agent) {
            await sendTextToPeer(this, '💤 没有活动会话。发送 /new [模式] <prompt> 开始，/modes 查看可用模式，或 /sessions 查看已有会话。');
            return;
        }
        debugLog({ event: 'followup', session: this.activeSessionId });
        agent.followup(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
        }));
        if (this.peerId) {
            await this.ctx.wechat.sendTypingIndicator({ toUserId: this.peerId, status: 1 }).catch(() => { });
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
     * most recent request; bare `1`/`2` only while exactly one is pending.
     */
    resolveApproval(text) {
        const entries = [...this.pending.entries()];
        if (entries.length === 0)
            return false;
        const outcome = text === '/yes' ? 'allowed-once' : text === '/no' ? 'rejected' : undefined;
        if (outcome) {
            const [number, entry] = entries[entries.length - 1];
            this.clearApproval(number);
            entry.resolve(outcome);
            return true;
        }
        if ((text === '1' || text === '2') && entries.length === 1) {
            const [number, entry] = entries[0];
            this.clearApproval(number);
            entry.resolve(text === '1' ? 'allowed-once' : 'rejected');
            return true;
        }
        return false;
    }
}
//# sourceMappingURL=core.js.map