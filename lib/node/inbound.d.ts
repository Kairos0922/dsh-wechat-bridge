/**
 * Inbound bridge: iLink messages → DSH conversation events.
 *
 * Policy enforced here (the security boundary of the bundle):
 * - only `allowFrom` senders are ever routed to the model; everyone else is
 *   logged and ignored (a prompt-injection front door otherwise);
 * - text is extracted from `text_item` (and `voice_item.text` transcription
 *   when WeChat supplied no downloadable audio);
 * - commands are handled locally; everything else becomes a user message on
 *   the sender's active agent via `agent.followup`;
 * - images are downloaded locally and handed to the agent as paths — the
 *   WeChat ack shows a count, never machine paths (mobile users cannot act on
 *   them and they leak directory structure).
 *
 * @module dsh-wechat-bridge/node/inbound
 */
import { type InboundEvent, type InboundMessage } from '../gateway/types.ts';
import type { WechatBridgeNode } from './core.ts';
/** Default media dir (per-bridge, under DSH storages). */
export declare function defaultMediaDir(): string;
/** Extract the visible text of an inbound message (text + voice transcription). */
export declare function extractText(message: InboundMessage): string;
/** Whether a message belongs to a group chat (MVP: not supported, ignored). */
export declare function isGroupMessage(message: InboundMessage): boolean;
/** Handle one inbound iLink message. */
export declare function handleInbound(node: WechatBridgeNode, payload: InboundEvent): Promise<void>;
//# sourceMappingURL=inbound.d.ts.map