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
import type { AssistantMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { WechatBridgeNode } from './core.ts';
/** Collapse runs of blank lines to one; strips surrounding whitespace. */
export declare function normalizeMarkdownBlocks(content: string): string;
/** Split content into markdown blocks, keeping fenced code blocks intact. */
export declare function splitMarkdownBlocks(content: string): string[];
/** Split assistant text into WeChat delivery units (≤max each). */
export declare function splitForWechat(content: string, max?: number): string[];
/** Extract the visible text of an assistant message. */
export declare function textOfAssistantMessage(message: AssistantMessage): string;
/** Send text to a peer through the node's rate-limit-aware outbox. */
export declare function sendTextToPeer(node: WechatBridgeNode, peerId: string, text: string, opts?: {
    kind?: 'system' | 'text' | 'progress';
    coalesceKey?: string;
    priority?: number;
}): Promise<void>;
/** Whether this tool gets its own progress card (long/high-risk tools only). */
export declare function isProgressTool(node: WechatBridgeNode, name: string): boolean;
/**
 * Attach the outbound digest pipeline. Listens on `session/event` once and
 * filters to sessions owned by a WeChat peer; per-session digest state keyed
 * by session id. Every side effect (interval, listener) is disposed by the
 * returned disposer.
 */
export declare function attachSessionOutbound(node: WechatBridgeNode): () => void;
/**
 * Per-turn context usage line: latest reported input tokens (each step's
 * input includes the whole history in LLM accounting, so it approximates the
 * current context size) vs the model's disclosed context window. Returns
 * null when no usage was reported.
 */
/** Latest reported input tokens ≈ current context size (or 0). */
export declare function latestContextInput(session: Session): number;
export declare function buildContextUsageLine(session: Session, node: WechatBridgeNode): Promise<string | null>;
//# sourceMappingURL=outbound.d.ts.map