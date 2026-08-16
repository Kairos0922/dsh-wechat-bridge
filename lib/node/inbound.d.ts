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
import { type InboundEvent, type InboundMessage, type MessageItem } from '../gateway/types.ts';
import type { WechatBridgeNode } from './core.ts';
/** Default media dir (per-bridge, under DSH storages). */
export declare function defaultMediaDir(): string;
/**
 * Port of official `bodyFromItemList` (Tencent/openclaw-weixin inbound.ts,
 * field-for-field): renders the visible text of one message item list,
 * including quoted-message context (`ref_msg`). Quoted media is NOT rendered
 * as text — only the current message's own text is kept (the official path
 * hands quoted media elsewhere).
 */
export declare function isMediaItem(item: MessageItem | undefined): boolean;
export declare function bodyFromItemList(itemList?: MessageItem[]): string;
/** Extract the visible text of an inbound message (text + quoted context + voice transcription). */
export declare function extractText(message: InboundMessage): string;
/** Whether a message belongs to a group chat (MVP: not supported, ignored). */
export declare function isGroupMessage(message: InboundMessage): boolean;
/** Handle one inbound iLink message. */
export declare function handleInbound(node: WechatBridgeNode, payload: InboundEvent): Promise<void>;
//# sourceMappingURL=inbound.d.ts.map