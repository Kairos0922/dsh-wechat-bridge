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

import fs from 'node:fs'
import path from 'node:path'
import {
  ITEM_FILE,
  ITEM_IMAGE,
  ITEM_TEXT,
  ITEM_VIDEO,
  ITEM_VOICE,
  type ImageItem,
  type InboundEvent,
  type InboundMessage,
  type MessageItem,
} from '../gateway/types.ts'
import type { WechatBridgeNode } from './core.ts'
import { sendTextToPeer } from './outbound.ts'
import { resolveDshHome } from './presets.ts'
import { debugLog } from '../debug-log.ts'

/** Default media dir (per-bridge, under DSH storages). */
export function defaultMediaDir(): string {
  return path.join(resolveDshHome(), 'storages', 'dsh-wechat-bridge', 'media')
}

/**
 * Port of official `bodyFromItemList` (Tencent/openclaw-weixin inbound.ts,
 * field-for-field): renders the visible text of one message item list,
 * including quoted-message context (`ref_msg`). Quoted media is NOT rendered
 * as text — only the current message's own text is kept (the official path
 * hands quoted media elsewhere).
 */
export function isMediaItem(item: MessageItem | undefined): boolean {
  return !!item && (item.type === ITEM_IMAGE || item.type === ITEM_VIDEO || item.type === ITEM_FILE || item.type === ITEM_VOICE)
}

/** Quoted-message recursion ceiling — a pathological ref chain must never blow the stack. */
export const MAX_REF_DEPTH = 8

export interface ExtractTextOptions {
  /**
   * Whether quoted-message bodies are included. Groups pass false: the quote
   * may originate from a NON-allowlisted room member, and the allowlist gate
   * only covers the current sender — quoted bodies from strangers must never
   * reach the model context (the title, a short summary, is kept).
   */
  includeQuoteBody?: boolean
}

export function bodyFromItemList(itemList?: MessageItem[], opts: ExtractTextOptions = {}, depth = 0): string {
  if (!Array.isArray(itemList) || itemList.length === 0) return ''
  const includeQuoteBody = opts.includeQuoteBody ?? true
  const parts: string[] = []
  for (const item of itemList) {
    if (item?.type === ITEM_TEXT) {
      const text = String(item.text_item?.text ?? '')
      const ref = item.ref_msg
      // 引用的消息是媒体（图片/视频/文件/语音）或超出递归上限时，只保留当前文本。
      if (!ref || depth >= MAX_REF_DEPTH || isMediaItem(ref.message_item)) {
        if (text) parts.push(text)
        continue
      }
      const refParts: string[] = []
      if (ref.title) refParts.push(ref.title)
      if (includeQuoteBody && ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item], opts, depth + 1)
        if (refBody) refParts.push(refBody)
      }
      parts.push(refParts.length === 0 ? text : `[引用: ${refParts.join(' | ')}]\n${text}`)
      continue
    }
    // 语音转写：语音消息带 text 字段时直接使用。
    if (item?.type === ITEM_VOICE) {
      const voiceText = String(item.voice_item?.text ?? '')
      if (voiceText.trim()) parts.push(`[语音转写]\n${voiceText}`)
    }
  }
  // Aggregate ALL text fragments (multi-item messages must not silently lose
  // everything past the first item — the debug log already logs them all).
  return parts.filter(Boolean).join('\n')
}

/** Extract the visible text of an inbound message (text + quoted context + voice transcription). */
export function extractText(message: InboundMessage, opts: ExtractTextOptions = {}): string {
  return bodyFromItemList(message.item_list, opts)
}

/**
 * Download inbound images to the local workspace and hand the paths to the
 * agent (differentiator #2 — image-in-session). Media bytes never leave the
 * machine beyond the CDN download itself. The peer gets a count-only ack.
 */
async function handleImages(
  node: WechatBridgeNode,
  peerId: string,
  message: InboundMessage,
  images: ImageItem[],
  text: string,
): Promise<void> {
  const sessionId = node.activeSession(peerId)?.id ?? 'unbound'
  const dir = path.join(node.resolved.mediaDir ?? defaultMediaDir(), String(sessionId))
  fs.mkdirSync(dir, { recursive: true })
  const saved: string[] = []
  for (let i = 0; i < images.length; i++) {
    try {
      const { data, ext } = await node.ctx.wechat.downloadImage(images[i]!)
      const file = path.join(dir, `wechat-${message.message_id ?? Date.now()}-${i}.${ext}`)
      fs.writeFileSync(file, data)
      saved.push(file)
    } catch (err) {
      node.ctx.logger.warn('[dsh-wechat-bridge] image download failed: %s', String(err))
    }
  }
  const parts = [text.trim()]
  if (saved.length > 0) {
    parts.push(`📷 用户发来 ${saved.length} 张图片（本地路径）:\n${saved.map((p) => `- ${p}`).join('\n')}`)
  }
  const combined = parts.filter(Boolean).join('\n\n')
  if (saved.length > 0) {
    void sendTextToPeer(node, peerId, `✅ 已收到 ${saved.length} 张图片，交给会话处理中…`, { kind: 'system' })
  }
  if (!combined.trim()) return
  await node.handleText(peerId, combined)
}

/** Whether a message belongs to a group chat (MVP: not supported, ignored). */
export function isGroupMessage(message: InboundMessage): boolean {
  const roomId = String(message.room_id ?? message.chat_room_id ?? message.group_id ?? '').trim()
  return Boolean(roomId)
}

/** Handle one inbound iLink message. */
export async function handleInbound(node: WechatBridgeNode, payload: InboundEvent): Promise<void> {
  const { message, senderId, contextToken, runId } = payload
  if (!senderId) return

  // ---- allowlist gate: the security boundary ------------------------------
  // 1:1 = global allowFrom. Groups = room-level two-tier gate: the room must
  // be listed in allowGroups AND the sender must be in that room's allowFrom.
  const groupId = String(message.group_id ?? message.room_id ?? message.chat_room_id ?? '').trim()
  let peerKey = senderId
  let target = senderId
  if (groupId) {
    const entry = node.resolved.allowGroups.find((group) => group.roomId === groupId)
    debugLog({ event: 'gate', from: senderId, group: groupId, allowed: Boolean(entry) })
    if (!entry) {
      node.ctx.logger.info('[dsh-wechat-bridge] ignoring group message from %s: room %s not allowlisted', senderId, groupId)
      return
    }
    if (!entry.allowFrom.includes(senderId)) {
      node.ctx.logger.info('[dsh-wechat-bridge] ignoring group message from %s: sender not allowlisted for room %s', senderId, groupId)
      return
    }
    peerKey = `group:${groupId}`
    target = groupId
  } else {
    const allowed = await node.isAllowed(senderId)
    debugLog({ event: 'gate', from: senderId, allowed })
    if (!allowed) {
      node.ctx.logger.info(
        '[dsh-wechat-bridge] ignoring message from non-allowlisted sender %s (never fed to the model)',
        senderId,
      )
      // Optional transparency: tell trusted users a stranger tried to reach
      // the bot (off by default — can be noisy under spam). Rate-limited in
      // core so a spamming stranger cannot starve the shared outbox budget.
      node.notifyRejectedPeers(senderId)
      return
    }
  }

  const images = (message.item_list ?? [])
    .filter((item) => item?.type === ITEM_IMAGE)
    .map((item) => item.image_item ?? {})
  // Group quotes may carry a non-allowlisted member's text — strip the body.
  const text = extractText(message, { includeQuoteBody: !groupId })

  node.setPeerTarget(peerKey, target)
  node.setPeerContextToken(peerKey, contextToken ?? null)
  node.setPeerRunId(peerKey, runId ?? null)

  // Channel-recovery hooks: a new inbound message proves the user is at the
  // phone and the token is fresh — re-push approval prompts and MUST-DELIVER
  // messages (final answers / error / stop notices) whose first delivery
  // failed (审批必达 + 关键结果必达: core.retryApprovalPrompt /
  // core.retryCriticalMessages).
  node.retryApprovalPrompt(peerKey)
  node.retryCriticalMessages(peerKey)

  if (images.length > 0) {
    await handleImages(node, peerKey, message, images, text)
    return
  }
  if (!text.trim()) {
    node.ctx.logger.info('[dsh-wechat-bridge] ignoring non-text non-image message from %s', senderId)
    return
  }

  await node.handleText(peerKey, text)
}
