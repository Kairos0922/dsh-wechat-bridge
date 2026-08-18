/**
 * Permission-request bridge: DSH `approval/request` → WeChat text prompt.
 *
 * WeChat personal accounts have no buttons, so a permission request is
 * rendered as a numbered text prompt and resolved by `/yes` or `/no` (bare
 * `1`/`2` also work while exactly one request is pending). The prompt now
 * includes a short argument summary (recovered from the session's logged
 * tool call via `callId`), so risky parameters are visible before consent.
 * A reply timeout falls back to DSH's default deny (`'rejected'`).
 *
 * The bridge only answers for agents whose session a WeChat peer owns; every
 * other request delegates via `next()`. Requests route to the owning peer —
 * never to whoever spoke last.
 *
 * @module dsh-wechat-bridge/node/approvals
 */
import { sendTextToPeer } from "./outbound.js";
/** Short argument summary from the logged tool call, when callId links one. */
export function approvalArgsSummary(request) {
    if (!request.callId)
        return null;
    for (const event of request.agent.session.events) {
        if (event.type === 'tool/call' && event.data.callId === request.callId) {
            const collapsed = event.data.arguments.replace(/\s+/g, ' ').trim();
            return collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed;
        }
    }
    return null;
}
/** Build the WeChat approval prompt text (shared by first send and re-push). */
export function buildApprovalPrompt(request, number, timeoutSec) {
    const args = approvalArgsSummary(request);
    return [
        `🔐 #${number} 需要你的确认`,
        `工具: ${request.toolName}`,
        ...(args !== null ? [`参数: ${args}`] : []),
        ...(request.reason ? [`原因: ${request.reason}`] : []),
        '回复 /yes 同意，/no 拒绝（仅一条待确认时也可回复 1/2）',
        `${Math.max(1, Math.round(timeoutSec / 60))} 分钟内未回复将自动拒绝。`,
    ].join('\n');
}
/** Attach the `approval/request` answerer. Returns a disposer. */
export function attachApprovalBridge(node) {
    const listener = async (req, next) => {
        // Only answer for agents whose session a WeChat peer owns.
        const peer = node.peerOf(req.agent.session.id);
        if (peer === null)
            return next();
        const number = node.nextApprovalNumber();
        const timeoutSec = node.resolved.approvalTimeoutSec;
        const prompt = buildApprovalPrompt(req, number, timeoutSec);
        // Show the question FIRST — the user cannot answer what they cannot see.
        // The per-approval coalesce key keeps re-pushes idempotent and concurrent
        // approvals from overwriting each other; a dropped prompt is re-pushed on
        // the user's next inbound message (审批必达手机).
        node.enqueueApprovalPrompt(peer, prompt, number);
        const outcome = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                node.clearApproval(number);
                resolve('rejected'); // default deny on timeout
            }, timeoutSec * 1000);
            timer.unref?.();
            node.registerApproval(number, { number, peerId: peer, request: req, resolve, timer });
        });
        const label = outcome === 'allowed-once' ? '✅ 已同意' : outcome === 'rejected' ? '❌ 已拒绝' : `⏳ ${outcome}`;
        void sendTextToPeer(node, peer, `${label}（#${number}）`, { kind: 'system' });
        return outcome;
    };
    const disposer = node.ctx.on('approval/request', listener);
    return () => {
        disposer();
    };
}
//# sourceMappingURL=approvals.js.map