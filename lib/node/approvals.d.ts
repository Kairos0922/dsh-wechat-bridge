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
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type { WechatBridgeNode } from './core.ts';
/** One pending approval awaiting a WeChat reply. */
export interface PendingApproval {
    number: number;
    /** The peer the prompt was sent to — only that peer may answer. */
    peerId: string;
    request: ApprovalRequest;
    resolve: (outcome: ApprovalOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
}
/** Short argument summary from the logged tool call, when callId links one. */
export declare function approvalArgsSummary(request: ApprovalRequest): string | null;
/** Build the WeChat approval prompt text (shared by first send and re-push). */
export declare function buildApprovalPrompt(request: ApprovalRequest, number: number, timeoutSec: number): string;
/** Attach the `approval/request` answerer. Returns a disposer. */
export declare function attachApprovalBridge(node: WechatBridgeNode): () => void;
//# sourceMappingURL=approvals.d.ts.map