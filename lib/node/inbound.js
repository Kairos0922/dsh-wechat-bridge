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
import fs from 'node:fs';
import path from 'node:path';
import { ITEM_IMAGE, ITEM_TEXT, ITEM_VOICE, } from "../gateway/types.js";
import { routeCommand } from "./commands.js";
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
 * machine beyond the CDN download itself.
 */
async function handleImages(node, message, images, text) {
    const dir = path.join(node.resolved.mediaDir ?? defaultMediaDir(), String(node.activeSessionId ?? 'unbound'));
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
        parts.push(`📷 已接收图片（本地路径）:\n${saved.map((p) => `- ${p}`).join('\n')}`);
    }
    const combined = parts.filter(Boolean).join('\n\n');
    if (!combined.trim())
        return;
    await node.handleText(combined);
}
/** Handle one inbound iLink message. */
export async function handleInbound(node, payload) {
    const { message, senderId, contextToken } = payload;
    if (!senderId)
        return;
    // ---- allowlist gate: the security boundary ------------------------------
    const allowed = node.isAllowed(senderId);
    debugLog({ event: 'gate', from: senderId, allowed });
    if (!allowed) {
        node.ctx.logger.info('[dsh-wechat-bridge] ignoring message from non-allowlisted sender %s (never fed to the model)', senderId);
        return;
    }
    const images = (message.item_list ?? [])
        .filter((item) => item?.type === ITEM_IMAGE)
        .map((item) => item.image_item ?? {});
    const text = extractText(message);
    node.peerId = senderId;
    node.peerContextToken = contextToken ?? null;
    if (images.length > 0) {
        await handleImages(node, message, images, text);
        return;
    }
    if (!text.trim()) {
        node.ctx.logger.info('[dsh-wechat-bridge] ignoring non-text non-image message from %s', senderId);
        return;
    }
    await node.handleText(text);
}
// Re-export for core.ts
export { routeCommand, sendTextToPeer };
//# sourceMappingURL=inbound.js.map