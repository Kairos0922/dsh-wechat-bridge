/**
 * Outbound bridge: session events → WeChat messages.
 *
 * Everything flows through the node's single rate-limit-aware outbox. The
 * wiring here emits a small digest vocabulary from the append-only session
 * log: task started, thinking digest (reasoning-delta aggregation), tool
 * progress cards (TOOL_CALL_START/RESULT, rendered natively by the WeChat
 * client), todo snapshots, assistant text (markdown-policy-rendered and
 * chunked), finished/error.
 *
 * The markdown-aware chunker follows the hermes-agent splitting approach
 * (also used by dsh-chatnode-wechat, MIT) — reimplemented here.
 *
 * @module dsh-wechat-bridge/node/outbound
 */
import { ITEM_TOOL_CALL_RESULT, ITEM_TOOL_CALL_START, MAX_MESSAGE_CHARS, } from "../gateway/types.js";
import { renderForWechat } from "./markdown.js";
import { writeExportFile } from "./exports.js";
import { debugLog } from "../debug-log.js";
// ---------------------------------------------------------------------------
// Chunking
const FENCE_RE = /^```([^\n`]*)\s*$/;
/** Collapse runs of blank lines to one; strips surrounding whitespace. */
export function normalizeMarkdownBlocks(content) {
    const lines = content.split('\n');
    const out = [];
    let blankRun = 0;
    let inCode = false;
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (FENCE_RE.test(line.trim())) {
            inCode = !inCode;
            out.push(line);
            blankRun = 0;
            continue;
        }
        if (inCode) {
            out.push(line);
            continue;
        }
        if (!line.trim()) {
            blankRun += 1;
            if (blankRun <= 1)
                out.push('');
            continue;
        }
        blankRun = 0;
        out.push(line);
    }
    return out.join('\n').trim();
}
/** Split content into markdown blocks, keeping fenced code blocks intact. */
export function splitMarkdownBlocks(content) {
    const blocks = [];
    let current = [];
    let inCode = false;
    const flush = () => {
        const block = current.join('\n').trim();
        if (block)
            blocks.push(block);
        current = [];
    };
    for (const raw of content.split('\n')) {
        const line = raw.replace(/\s+$/, '');
        if (FENCE_RE.test(line.trim())) {
            if (!inCode && current.length)
                flush();
            current.push(line);
            inCode = !inCode;
            if (!inCode)
                flush();
            continue;
        }
        if (inCode) {
            current.push(line);
            continue;
        }
        if (!line.trim()) {
            flush();
            continue;
        }
        current.push(line);
    }
    flush();
    return blocks;
}
/** Split one oversized block into ≤max chunks (hard-truncating the tail). */
function hardSplit(text, max) {
    const chunks = [];
    let rest = text;
    while (rest.length > max) {
        chunks.push(rest.slice(0, max));
        rest = rest.slice(max);
    }
    if (rest)
        chunks.push(rest);
    return chunks;
}
/** Greedy-pack markdown blocks into ≤max units. */
function packBlocks(blocks, max) {
    const units = [];
    let current = '';
    for (const block of blocks) {
        const candidate = current ? `${current}\n\n${block}` : block;
        if (candidate.length <= max) {
            current = candidate;
            continue;
        }
        if (current)
            units.push(current);
        if (block.length <= max) {
            current = block;
        }
        else {
            units.push(...hardSplit(block, max));
            current = '';
        }
    }
    if (current)
        units.push(current);
    return units;
}
/** Split assistant text into WeChat delivery units (≤max each). */
export function splitForWechat(content, max = MAX_MESSAGE_CHARS) {
    const normalized = normalizeMarkdownBlocks(content);
    if (!normalized)
        return [];
    if (normalized.length <= max)
        return [normalized];
    return packBlocks(splitMarkdownBlocks(normalized), max);
}
/** Extract the visible text of an assistant message. */
export function textOfAssistantMessage(message) {
    return message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
}
// ---------------------------------------------------------------------------
// Delivery
/** Send text to a peer through the node's rate-limit-aware outbox. */
export async function sendTextToPeer(node, peerId, text, opts = {}) {
    if (!peerId)
        return;
    const chunks = splitForWechat(text, node.resolved.maxMessageChars);
    if (chunks.length === 0)
        return;
    const kind = opts.kind ?? 'text';
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const labeled = chunks.length > 1 && kind === 'text' ? `(${i + 1}/${chunks.length})\n${chunk}` : chunk;
        node.enqueueText(peerId, labeled, {
            kind,
            coalesceKey: opts.coalesceKey !== undefined && i === chunks.length - 1 ? opts.coalesceKey : undefined,
        });
    }
}
/** Friendly Chinese labels for tool progress cards. */
const TOOL_LABELS = {
    bash: '执行命令',
    pwsh: '执行命令',
    fs: '读写文件',
    'fs-search': '搜索文件',
    'fs-read': '读取文件',
    'fs-write': '写入文件',
    web: '网络搜索',
    web_search: '网络搜索',
    http: '网络请求',
    mcp: 'MCP 工具',
};
function toolLabel(name) {
    return TOOL_LABELS[name] ?? name;
}
/** Whether this tool gets its own progress card (long/high-risk tools only). */
export function isProgressTool(node, name) {
    const prefixes = node.resolved.progressToolPrefixes;
    // Empty list = progress cards disabled (the backend may drop them silently —
    // see README); a non-empty list cards only the tools whose names match.
    if (prefixes.length === 0)
        return false;
    return prefixes.some((prefix) => name.startsWith(prefix));
}
/**
 * Attach the outbound digest pipeline. Listens on `session/event` once and
 * filters to sessions owned by a WeChat peer; per-session digest state keyed
 * by session id. Every side effect (interval, listener) is disposed by the
 * returned disposer.
 */
export function attachSessionOutbound(node) {
    const digestState = new Map();
    const stopHeartbeat = (state) => {
        if (state.heartbeat) {
            clearInterval(state.heartbeat);
            state.heartbeat = undefined;
        }
        if (state.typingTimer) {
            clearInterval(state.typingTimer);
            state.typingTimer = undefined;
        }
    };
    const sendTyping = (peer, status) => {
        void node.ctx.wechat
            .sendTypingIndicator({ toUserId: peer, status, contextToken: node.getPeerContextToken(peer) ?? undefined })
            .catch(() => { });
    };
    const tickKey = (state) => `${state.reasoningChars}|${state.toolCount}|${state.lastTool ?? ''}`;
    const startHeartbeat = (session, peer, state) => {
        stopHeartbeat(state);
        // Typing heartbeat: the client may stop showing "typing…" during long
        // turns — re-assert it periodically (rate-budget friendly: the ticket is
        // cached, the call itself is lightweight). 0 = disabled.
        if (node.resolved.typingHeartbeatSec > 0) {
            state.typingTimer = setInterval(() => {
                sendTyping(peer, 1);
            }, node.resolved.typingHeartbeatSec * 1000);
            state.typingTimer.unref?.();
        }
        if (node.resolved.thinkingDigestSec <= 0)
            return;
        state.lastTickKey = '';
        state.heartbeat = setInterval(() => {
            const key = tickKey(state);
            // Send only when something changed since the last tick; the empty state
            // ('0|0|') fires exactly once per turn as the "started thinking" signal
            // and stays quiet afterwards (no progress = no spam).
            if (key === state.lastTickKey)
                return;
            state.lastTickKey = key;
            const parts = [];
            if (state.reasoningChars > 0) {
                const excerpt = node.state.getPrefs(peer).thinking && state.lastReasoning ? `，最近: …${state.lastReasoning}` : '';
                parts.push(`🤔 思考中…（${state.reasoningChars} 字${excerpt}）`);
            }
            else {
                parts.push('🤔 思考中…');
            }
            if (state.toolCount > 0) {
                parts.push(`🛠 已调用 ${state.toolCount} 个工具${state.lastTool ? `（最近: ${toolLabel(state.lastTool)}）` : ''}`);
            }
            node.enqueueText(peer, parts.join('\n'), { kind: 'progress', coalesceKey: `think:${session.id}` });
        }, node.resolved.thinkingDigestSec * 1000);
        state.heartbeat.unref?.();
    };
    const onEvent = (session, event) => {
        const peer = node.peerOf(session.id);
        if (peer === null)
            return;
        const group = node.isGroupPeer(peer);
        const state = digestState.get(session.id) ?? {
            startedTurns: new Set(),
            reasoningChars: 0,
            lastReasoning: '',
            toolCount: 0,
            todoHash: '',
            lastTickKey: '',
            cardedCalls: new Map(),
            turnStartedAt: 0,
        };
        digestState.set(session.id, state);
        debugLog({ event: 'session-event', session: session.id, type: event.type });
        if (event.type === 'turn/start') {
            const turn = event.data.turn;
            state.reasoningChars = 0;
            state.lastReasoning = '';
            state.toolCount = 0;
            state.lastTool = undefined;
            state.todoHash = '';
            state.cardedCalls.clear();
            state.turnStartedAt = Date.now();
            if (!state.startedTurns.has(turn)) {
                state.startedTurns.add(turn);
                if (!group) {
                    node.enqueueText(peer, '⏳ 收到，开始处理…', { kind: 'system' });
                    sendTyping(peer, 1);
                }
            }
            // Groups stay quiet: no heartbeat spam in shared chats.
            if (!group)
                startHeartbeat(session, peer, state);
            return;
        }
        if (event.type === 'assistant/chunk') {
            if (event.data.chunk.type === 'reasoning-delta') {
                state.reasoningChars += event.data.chunk.text.length;
                state.lastReasoning = (state.lastReasoning + event.data.chunk.text).slice(-60);
            }
            return;
        }
        if (event.type === 'tool/call') {
            state.toolCount += 1;
            state.lastTool = event.data.name;
            if (!group) {
                const name = event.data.name;
                if (isProgressTool(node, name)) {
                    state.cardedCalls.set(event.data.callId, name);
                    node.enqueueToolCard(peer, 'tool-start', {
                        type: ITEM_TOOL_CALL_START,
                        create_time_ms: Date.now(),
                        is_completed: false,
                        tool_call_start_item: { tool_name: toolLabel(name), tool_call_id: event.data.callId },
                    });
                }
            }
            return;
        }
        if (event.type === 'tool/result') {
            const callId = event.data.message.content[0]?.toolCallId;
            if (!group && callId !== undefined && state.cardedCalls.has(callId)) {
                const name = state.cardedCalls.get(callId) ?? 'tool';
                state.cardedCalls.delete(callId);
                node.enqueueToolCard(peer, 'tool-result', {
                    type: ITEM_TOOL_CALL_RESULT,
                    create_time_ms: Date.now(),
                    is_completed: true,
                    tool_call_result_item: {
                        tool_name: toolLabel(name),
                        tool_call_id: callId,
                        status: event.data.error ? 'failed' : 'completed',
                    },
                });
            }
            return;
        }
        if (event.type === 'todo/write') {
            if (group)
                return;
            const hash = JSON.stringify(event.data.todos);
            if (hash !== state.todoHash) {
                state.todoHash = hash;
                const lines = event.data.todos.map((todo) => {
                    const mark = todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '🔄' : '⭕';
                    return `${mark} ${todo.content}`;
                });
                if (lines.length > 0) {
                    node.enqueueText(peer, `📋 任务计划\n${lines.join('\n')}`, { kind: 'progress', coalesceKey: `todo:${session.id}` });
                }
            }
            return;
        }
        if (event.type === 'assistant/message') {
            const text = textOfAssistantMessage(event.data.message);
            if (text.trim()) {
                const rendered = renderForWechat(text, node.resolved.markdownMode);
                const threshold = node.resolved.fileThresholdChars;
                if (threshold > 0 && rendered.length > threshold) {
                    // Long answer → short digest text + full Markdown file attachment.
                    // The file entry carries the full text: a hard failure falls back to
                    // chunked text delivery (see core.dispatchOutboxEntry).
                    const { filePath, fileName } = writeExportFile(node, session.id, text, 'answer');
                    void sendTextToPeer(node, peer, `${rendered.slice(0, 180)}…\n\n📎 完整内容（${rendered.length} 字）见附件 ${fileName}`);
                    node.enqueueMedia(peer, 'file', filePath, fileName, rendered);
                }
                else {
                    void sendTextToPeer(node, peer, rendered);
                }
            }
            return;
        }
        if (event.type === 'turn/end') {
            stopHeartbeat(state);
            if (!group)
                sendTyping(peer, 2);
            const reason = event.data.reason;
            if (reason.kind === 'error') {
                node.enqueueText(peer, `❌ 处理出错: ${summarizeError(reason.error)}\n回复 /retry 重试上一次任务。`, { kind: 'system' });
            }
            else if (reason.kind === 'aborted') {
                node.enqueueText(peer, '⏹ 已停止', { kind: 'system' });
            }
            else if (reason.kind === 'max-tokens') {
                node.enqueueText(peer, '⚠️ 达到输出上限，本轮已截断（可回复“继续”让我接着完成）', { kind: 'system' });
            }
            // Proactive completion announcement for long tasks (opt-in; groups stay
            // quiet — only command results and final answers reach a shared chat).
            if (!group &&
                reason.kind === 'completed' &&
                node.resolved.notifyOnComplete &&
                state.turnStartedAt > 0 &&
                Date.now() - state.turnStartedAt >= node.resolved.notifyMinTurnSec * 1000) {
                const seconds = Math.round((Date.now() - state.turnStartedAt) / 1000);
                node.enqueueText(peer, `✅ 任务完成（用时 ${seconds}s · ${state.toolCount} 个工具调用${state.reasoningChars > 0 ? ` · 思考 ${state.reasoningChars} 字` : ''}）`, { kind: 'system' });
            }
            return;
        }
    };
    const disposer = node.ctx.on('session/event', onEvent);
    return () => {
        for (const state of digestState.values())
            stopHeartbeat(state);
        disposer();
    };
}
function summarizeError(error) {
    if (error && typeof error === 'object' && 'message' in error) {
        return String(error.message).slice(0, 200);
    }
    return String(error).slice(0, 200);
}
//# sourceMappingURL=outbound.js.map