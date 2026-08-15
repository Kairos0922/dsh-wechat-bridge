/**
 * Outbound bridge: session events → WeChat messages.
 *
 * Emits a small digest vocabulary from the append-only session log:
 * task started, heartbeat, assistant text (chunked), finished/error.
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
/** One-line progress summary derived from the session log (cheap, replayable). */
export declare function digestLine(session: Session): string;
/** Send text to the current peer, chunked and throttled. */
export declare function sendTextToPeer(node: WechatBridgeNode, text: string): Promise<void>;
/**
 * Attach the outbound digest pipeline. Listens on `session/event` once and
 * filters to the node's active session; per-session digest state keyed by id.
 */
export declare function attachSessionOutbound(node: WechatBridgeNode): () => void;
//# sourceMappingURL=outbound.d.ts.map