/**
 * Permission-request bridge: DSH `approval/request` → WeChat text prompt.
 *
 * WeChat personal accounts have no buttons, so a permission request is
 * rendered as a numbered text prompt and resolved by `/yes` or `/no` (bare
 * `1`/`2` also work while exactly one request is pending). A reply timeout
 * falls back to DSH's default deny (`'rejected'`).
 *
 * The bridge only answers for agents the conversation node drives (the
 * active session); every other request delegates via `next()`.
 *
 * @module dsh-wechat-bridge/node/approvals
 */
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type { WechatBridgeNode } from './core.ts';
/** One pending approval awaiting a WeChat reply. */
export interface PendingApproval {
    number: number;
    request: ApprovalRequest;
    resolve: (outcome: ApprovalOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
}
/** Attach the `approval/request` answerer. Returns a disposer. */
export declare function attachApprovalBridge(node: WechatBridgeNode): () => void;
//# sourceMappingURL=approvals.d.ts.map