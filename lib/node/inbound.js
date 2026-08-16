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
import fs from 'node:fs';
import path from 'node:path';
import { ITEM_IMAGE, ITEM_TEXT, ITEM_VOICE, } from "../gateway/types.js";
import { sendTextToPeer } from "./outbound.js";
import { resolveDshHome } from "./presets.js";
import { debugLog } from "../debug-log.js";
/** Default media dir (per-bridge, under DSH storages). */
export function defaultMediaDir() {
    return path.join(resolveDshHome(), 'storages', 'dsh-wechat-bridge', 'media');
}
/** Extract the visible text of an inbound message (text + voice transcription). */
export function extractText(message) {
    const items = Array.isArray(message.item_list) ? message.item_list : [];
    for (const item of items) {
        if (item?.type === ITEM_TEXT) {
            const text = String(item.text_item?.text ?? '');
            if (text.trim())
                return text;
        }
    }
    for (const item of items) {
        if (item?.type === ITEM_VOICE) {
            const voiceText = String(item.voice_item?.text ?? '');
            if (voiceText.trim()) {
                // WeChat supplied its own transcription; keep the origin visible.
                return `[语音转写]\n${voiceText}`;
            }
        }
    }
    return '';
}
/**
 * Download inbound images to the local workspace and hand the paths to the
 * agent (differentiator #2 — image-in-session). Media bytes never leave the
 * machine beyond the CDN download itself. The peer gets a count-only ack.
 */
async function handleImages(node, peerId, message, images, text) {
    const sessionId = node.activeSession(peerId)?.id ?? 'unbound';
    const dir = path.join(node.resolved.mediaDir ?? defaultMediaDir(), String(sessionId));
    fs.mkdirSync(dir, { recursive: true });
    const saved = [];
    for (let i = 0; i < images.length; i++) {
        try {
            const { data, ext } = await node.ctx.wechat.downloadImage(images[i]);
            const file = path.join(dir, `wechat-${message.message_id ?? Date.now()}-${i}.${ext}`);
            fs.writeFileSync(file, data);
            saved.push(file);
        }
        catch (err) {
            node.ctx.logger.warn('[dsh-wechat-bridge] image download failed: %s', String(err));
        }
    }
    const parts = [text.trim()];
    if (saved.length > 0) {
        parts.push(`📷 用户发来 ${saved.length} 张图片（本地路径）:\n${saved.map((p) => `- ${p}`).join('\n')}`);
    }
    const combined = parts.filter(Boolean).join('\n\n');
    if (saved.length > 0) {
        void sendTextToPeer(node, peerId, `✅ 已收到 ${saved.length} 张图片，交给会话处理中…`, { kind: 'system' });
    }
    if (!combined.trim())
        return;
    await node.handleText(peerId, combined);
}
/** Whether a message belongs to a group chat (MVP: not supported, ignored). */
export function isGroupMessage(message) {
    const roomId = String(message.room_id ?? message.chat_room_id ?? message.group_id ?? '').trim();
    return Boolean(roomId);
}
/** Handle one inbound iLink message. */
export async function handleInbound(node, payload) {
    const { message, senderId, contextToken, runId } = payload;
    if (!senderId)
        return;
    // ---- allowlist gate: the security boundary ------------------------------
    // 1:1 = global allowFrom. Groups = room-level two-tier gate: the room must
    // be listed in allowGroups AND the sender must be in that room's allowFrom.
    const groupId = String(message.group_id ?? message.room_id ?? message.chat_room_id ?? '').trim();
    let peerKey = senderId;
    let target = senderId;
    if (groupId) {
        const entry = node.resolved.allowGroups.find((group) => group.roomId === groupId);
        debugLog({ event: 'gate', from: senderId, group: groupId, allowed: Boolean(entry) });
        if (!entry) {
            node.ctx.logger.info('[dsh-wechat-bridge] ignoring group message from %s: room %s not allowlisted', senderId, groupId);
            return;
        }
        if (!entry.allowFrom.includes(senderId)) {
            node.ctx.logger.info('[dsh-wechat-bridge] ignoring group message from %s: sender not allowlisted for room %s', senderId, groupId);
            return;
        }
        peerKey = `group:${groupId}`;
        target = groupId;
    }
    else {
        const allowed = await node.isAllowed(senderId);
        debugLog({ event: 'gate', from: senderId, allowed });
        if (!allowed) {
            node.ctx.logger.info('[dsh-wechat-bridge] ignoring message from non-allowlisted sender %s (never fed to the model)', senderId);
            return;
        }
    }
    const images = (message.item_list ?? [])
        .filter((item) => item?.type === ITEM_IMAGE)
        .map((item) => item.image_item ?? {});
    const text = extractText(message);
    node.setPeerTarget(peerKey, target);
    node.setPeerContextToken(peerKey, contextToken ?? null);
    node.setPeerRunId(peerKey, runId ?? null);
    if (images.length > 0) {
        await handleImages(node, peerKey, message, images, text);
        return;
    }
    if (!text.trim()) {
        node.ctx.logger.info('[dsh-wechat-bridge] ignoring non-text non-image message from %s', senderId);
        return;
    }
    await node.handleText(peerKey, text);
}
//# sourceMappingURL=inbound.js.map