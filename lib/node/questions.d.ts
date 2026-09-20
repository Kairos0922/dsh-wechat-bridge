/**
 * User-question bridge: DSH `user-questions/request` → WeChat numbered prompt.
 *
 * The `ask_user_question` tool BLOCKS the whole turn until a human answers, and
 * WeChat personal accounts have no buttons — so before this bridge existed the
 * request was claimed by the remote/browser answerer and quietly parked there
 * while the WeChat user saw nothing at all.
 *
 * 2026-09-20 incident (the reason this file exists): a session asked one
 * confirmation question via `ask_user_question`. The bridge was not an
 * answerer, so `dsh-api-remotes` forwarded the request to the browser client;
 * no browser was watching that session. The turn sat blocked for 32 minutes
 * with zero outbound messages, the stall watchdog reported it as a *model
 * channel* failure (可能是模型通道异常), the user's "看下任务进度啊" queued as a
 * next-turn message that could never answer the pending question, and only
 * `/stop` ended it. `ask_user_question` is now answerable from the phone.
 *
 * Design notes:
 * - Registration is `prepend: true`: the WeChat peer is the human at the
 *   keyboard, so the bridge must claim BEFORE `dsh-api-remotes` parks the
 *   request in a browser the user is not looking at. Sessions with no WeChat
 *   owner still delegate via `next()` — the browser keeps its behaviour.
 * - A slash command is never swallowed as an answer, so `/stop` stays the
 *   escape hatch while a question is pending.
 * - Multiple questions in one request are asked SEQUENTIALLY: one prompt per
 *   question, so a phone reply is never ambiguous about which question it
 *   answers. Concurrent requests from one peer are answered oldest-first.
 * - The wait is bounded (`questionTimeoutSec`): an unanswered question ends as
 *   an explicit tool error the agent can react to, never as an endless hang.
 *
 * @module dsh-wechat-bridge/node/questions
 */
import type { AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions';
import type { WechatBridgeNode } from './core.ts';
/**
 * One pending question request awaiting a WeChat reply.
 *
 * The prompt/answer state machine lives in the closures behind `submit` and
 * `discard`; the node only stores this object so inbound routing can find the
 * peer's pending request and feed it a reply.
 */
export interface PendingQuestion {
    number: number;
    /** The peer the prompt was sent to — only that peer may answer. */
    peerId: string;
    request: AskUserQuestionRequest;
    /** Index of the question currently displayed. */
    index: number;
    /**
     * Offer one inbound message to this request. Accepts it (answering the
     * displayed question and pushing the next one, or resolving the request) and
     * returns `'accepted'`; returns `'ignored'` when the message is not an answer
     * at all (slash command, empty) so normal routing may continue. A malformed
     * reply is answered with a clarification and reported as `'accepted'` — the
     * question stays pending.
     */
    submit: (text: string) => 'accepted' | 'ignored';
    /** Drop the pending state without answering (timeout/abort/dispose). */
    discard: () => void;
}
/** Parsed meaning of one WeChat reply for one question. */
export type QuestionReply = {
    kind: 'answer';
    selected: string[];
    custom?: string;
} | {
    kind: 'invalid';
    reason: string;
} | {
    kind: 'none';
};
/**
 * Parse one WeChat reply against the displayed question.
 *
 * Numbered options are selected by number; anything else is the free-text
 * "Other" answer DSH models already understand (`selected: []` + `custom`).
 * A leading `/` is deliberately NOT an answer: commands outrank a pending
 * question, which is what keeps `/stop` usable mid-question.
 */
export declare function parseQuestionReply(raw: string, question: AskUserQuestionItem): QuestionReply;
/** Build the WeChat prompt for the question currently displayed. */
export declare function buildQuestionPrompt(pending: PendingQuestion, timeoutSec: number): string;
/**
 * Attach the `user-questions/request` answerer. Returns a disposer.
 *
 * Registered with `prepend` so the WeChat bridge wins the waterfall over the
 * remote/browser forwarder for WeChat-owned sessions (see the module doc).
 */
export declare function attachUserQuestionBridge(node: WechatBridgeNode): () => void;
//# sourceMappingURL=questions.d.ts.map