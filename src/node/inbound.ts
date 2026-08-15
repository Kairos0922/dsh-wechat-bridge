/**
 * Inbound bridge: iLink messages → DSH conversation events.
 *
 * Policy enforced here (the security boundary of the bundle):
 * - only `allowFrom` senders are ever routed to the model; everyone else is
 *   logged and ignored (a prompt-injection front door otherwise);
 * - text is extracted from `text_item` (and `voice_item.text` transcription
 *   when WeChat supplied no downloadable audio);
 * - commands are handled locally; everything else becomes a user message on
 *   the active agent via `agent.followup`.
 * - media-only messages are ignored (image-in-session arrives in M3).
 *
 * @module dsh-wechat-bridge/node/inbound
 */

import { ITEM_TEXT, ITEM_VOICE, type InboundEvent, type InboundMessage } from '../gateway/types.ts'
import type { WechatBridgeNode } from './core.ts'
import { routeCommand } from './commands.ts'
import { sendTextToPeer } from './outbound.ts'

/** Extract the visible text of an inbound message (text + voice transcription). */
export function extractText(message: InboundMessage): string {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  for (const item of items) {
    if (item?.type === ITEM_TEXT) {
      const text = String(item.text_item?.text ?? '')
      if (text.trim()) return text
    }
  }
  for (const item of items) {
    if (item?.type === ITEM_VOICE) {
      const voiceText = String((item as { voice_item?: { text?: string } }).voice_item?.text ?? '')
      if (voiceText.trim()) {
        // WeChat supplied its own transcription; keep the origin visible.
        return `[语音转写]\n${voiceText}`
      }
    }
  }
  return ''
}

/** Handle one inbound iLink message. */
export async function handleInbound(node: WechatBridgeNode, payload: InboundEvent): Promise<void> {
  const { message, senderId, contextToken } = payload
  if (!senderId) return

  // ---- allowlist gate: the security boundary ------------------------------
  if (!node.isAllowed(senderId)) {
    node.ctx.logger.info(
      '[dsh-wechat-bridge] ignoring message from non-allowlisted sender %s (never fed to the model)',
      senderId,
    )
    return
  }

  const text = extractText(message)
  if (!text.trim()) {
    node.ctx.logger.info('[dsh-wechat-bridge] ignoring media-only message from %s (M3: image-in-session)', senderId)
    return
  }

  node.peerId = senderId
  node.peerContextToken = contextToken ?? null

  await node.handleText(text)
}

// Re-export for core.ts
export { routeCommand, sendTextToPeer }
