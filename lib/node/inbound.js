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
import { ITEM_FILE, ITEM_IMAGE, ITEM_TEXT, ITEM_VIDEO, ITEM_VOICE, } from "../gateway/types.js";
import { mimeFromFilename } from "../gateway/media.js";
import { sendTextToPeer } from "./outbound.js";
import { resolveDshHome } from "./presets.js";
import { debugLog } from "../debug-log.js";
/** Default media dir (per-bridge, under DSH storages). */
export function defaultMediaDir() {
    return path.join(resolveDshHome(), 'storages', 'dsh-wechat-bridge', 'media');
}
/**
 * Port of official `bodyFromItemList` (Tencent/openclaw-weixin inbound.ts,
 * field-for-field): renders the visible text of one message item list,
 * including quoted-message context (`ref_msg`). Quoted media is NOT rendered
 * as text — only the current message's own text is kept (the official path
 * hands quoted media elsewhere).
 */
export function isMediaItem(item) {
    return !!item && (item.type === ITEM_IMAGE || item.type === ITEM_VIDEO || item.type === ITEM_FILE || item.type === ITEM_VOICE);
}
/** Quoted-message recursion ceiling — a pathological ref chain must never blow the stack. */
export const MAX_REF_DEPTH = 8;
export function bodyFromItemList(itemList, opts = {}, depth = 0) {
    if (!Array.isArray(itemList) || itemList.length === 0)
        return '';
    const includeQuoteBody = opts.includeQuoteBody ?? true;
    const parts = [];
    for (const item of itemList) {
        if (item?.type === ITEM_TEXT) {
            const text = String(item.text_item?.text ?? '');
            const ref = item.ref_msg;
            // 引用的消息是媒体（图片/视频/文件/语音）或超出递归上限时，只保留当前文本。
            if (!ref || depth >= MAX_REF_DEPTH || isMediaItem(ref.message_item)) {
                if (text)
                    parts.push(text);
                continue;
            }
            const refParts = [];
            if (ref.title)
                refParts.push(ref.title);
            if (includeQuoteBody && ref.message_item) {
                const refBody = bodyFromItemList([ref.message_item], opts, depth + 1);
                if (refBody)
                    refParts.push(refBody);
            }
            parts.push(refParts.length === 0 ? text : `[引用: ${refParts.join(' | ')}]\n${text}`);
            continue;
        }
        // 语音转写：语音消息带 text 字段时直接使用。
        if (item?.type === ITEM_VOICE) {
            const voiceText = String(item.voice_item?.text ?? '');
            if (voiceText.trim())
                parts.push(`[语音转写]\n${voiceText}`);
        }
    }
    // Aggregate ALL text fragments (multi-item messages must not silently lose
    // everything past the first item — the debug log already logs them all).
    return parts.filter(Boolean).join('\n');
}
/** Extract the visible text of an inbound message (text + quoted context + voice transcription). */
export function extractText(message, opts = {}) {
    return bodyFromItemList(message.item_list, opts);
}
/**
 * Download inbound images to the local workspace and hand the paths to the
 * agent (differentiator #2 — image-in-session). Media bytes never leave the
 * machine beyond the CDN download itself. The peer gets a count-only ack.
 */
function writeInboundMedia(dir, file, data) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(temp, data, { mode: 0o600 });
        fs.chmodSync(temp, 0o600);
        fs.renameSync(temp, file);
    }
    finally {
        try {
            fs.unlinkSync(temp);
        }
        catch { }
    }
}
function assertVideoBytes(data) {
    if (data.length < 12 || data.subarray(4, 8).toString('ascii') !== 'ftyp') {
        throw new Error('video payload is not an ISO BMFF/MP4 object');
    }
}
async function handleImages(node, peerId, message, images, text, dispatch = true) {
    const sessionId = node.activeSession(peerId)?.id ?? 'unbound';
    const dir = path.join(node.resolved.mediaDir ?? defaultMediaDir(), String(sessionId));
    const saved = [];
    for (let i = 0; i < images.length; i++) {
        try {
            const { data, ext } = await node.ctx.wechat.downloadImage(images[i]);
            const file = path.join(dir, `wechat-${message.message_id ?? Date.now()}-${i}.${ext}`);
            writeInboundMedia(dir, file, data);
            saved.push(file);
        }
        catch (err) {
            node.ctx.logger.warn('[dsh-wechat-bridge] image download failed: %s', String(err));
        }
    }
    if (!dispatch)
        return saved;
    const parts = [text.trim()];
    if (saved.length > 0)
        parts.push(`📷 用户发来 ${saved.length} 张图片（本地路径）:\n${saved.map((p) => `- ${p}`).join('\n')}`);
    const combined = parts.filter(Boolean).join('\n\n');
    if (saved.length > 0)
        void sendTextToPeer(node, peerId, `✅ 已收到 ${saved.length} 张图片，交给会话处理中…`, { kind: 'system' });
    if (combined.trim())
        await node.handleText(peerId, combined);
    return saved;
}
/** Strip path separators / traversal from a WeChat-provided file name. */
function sanitizeFileName(raw, fallback) {
    const base = (raw ?? '').split(/[/\\]/).pop()?.trim() ?? '';
    if (!base || base === '.' || base === '..')
        return fallback;
    return base.slice(0, 120);
}
/**
 * P1-1: download inbound file/video attachments to the media dir and hand
 * the paths to the agent (same policy as images: local bytes only, count ack
 * to the peer). Port of the official downloadMediaFromItem FILE/VIDEO
 * branches (media-download.ts:100-146), minus SILK voice (transcription-only).
 */
async function handleMediaFiles(node, peerId, message, entries, text, extraPaths = []) {
    const sessionId = node.activeSession(peerId)?.id ?? 'unbound';
    const dir = path.join(node.resolved.mediaDir ?? defaultMediaDir(), String(sessionId));
    const saved = [...extraPaths];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        try {
            const data = await node.ctx.wechat.downloadMediaObject(entry.media);
            if (entry.kind === 'video')
                assertVideoBytes(data);
            const stamp = message.message_id ?? Date.now();
            let fileName;
            if (entry.kind === 'file') {
                fileName = sanitizeFileName(entry.fileName, `file-${stamp}-${i}.bin`);
            }
            else {
                // Videos are mp4 on this channel (protocol.md §4); keep a safe name.
                fileName = `video-${stamp}-${i}.mp4`;
            }
            const file = path.join(dir, `wechat-${stamp}-${i}-${fileName}`);
            writeInboundMedia(dir, file, data);
            saved.push(file);
            debugLog({ event: 'inbound-media-saved', kind: entry.kind, msgId: message.message_id ?? null, file: path.basename(file), bytes: data.length, mime: mimeFromFilename(fileName) });
        }
        catch (err) {
            node.ctx.logger.warn('[dsh-wechat-bridge] %s download failed: %s', entry.kind, String(err));
        }
    }
    const parts = [text.trim()];
    if (saved.length > 0) {
        const lines = saved.map((p) => `- ${p}`).join('\n');
        const icon = entries.some((e) => e.kind === 'video') ? '🎬' : '📎';
        parts.push(`${icon} 用户发来 ${saved.length} 个文件/视频（本地路径）:\n${lines}`);
    }
    const combined = parts.filter(Boolean).join('\n\n');
    if (saved.length > 0) {
        void sendTextToPeer(node, peerId, `✅ 已收到 ${saved.length} 个文件/视频，交给会话处理中…`, { kind: 'system' });
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
    // P1-6: bridge-level pause — logged, seen-dedup NOT touched (the message is
    // deliberately dropped before the gate; un-pausing must not replay it).
    if (node.isPaused()) {
        debugLog({ event: 'gate', from: senderId, paused: true });
        node.ctx.logger.info('[dsh-wechat-bridge] paused: dropping inbound from %s', senderId);
        return;
    }
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
            // Optional transparency: tell trusted users a stranger tried to reach
            // the bot (off by default — can be noisy under spam). Rate-limited in
            // core so a spamming stranger cannot starve the shared outbox budget.
            node.notifyRejectedPeers(senderId);
            return;
        }
    }
    const images = (message.item_list ?? [])
        .filter((item) => item?.type === ITEM_IMAGE)
        .map((item) => item.image_item ?? {});
    // P1-1: file/video items with a downloadable CDN reference.
    const fileEntries = (message.item_list ?? [])
        .filter((item) => item?.type === ITEM_FILE && (item.file_item?.media?.encrypt_query_param || item.file_item?.media?.full_url))
        .map((item) => ({ media: item.file_item.media, kind: 'file', fileName: item.file_item.file_name }));
    const videoEntries = (message.item_list ?? [])
        .filter((item) => item?.type === ITEM_VIDEO && (item.video_item?.media?.encrypt_query_param || item.video_item?.media?.full_url))
        .map((item) => ({ media: item.video_item.media, kind: 'video' }));
    // Group quotes may carry a non-allowlisted member's text — strip the body.
    const text = extractText(message, { includeQuoteBody: !groupId });
    // P1-1: a voice message with NO transcription field must not be silently
    // dropped (the sender believes the bot heard them) — surface it as a
    // non-text part the agent can acknowledge.
    const voiceWithoutText = (message.item_list ?? []).some((item) => item?.type === ITEM_VOICE && !String(item.voice_item?.text ?? '').trim());
    node.setPeerTarget(peerKey, target);
    node.setPeerContextToken(peerKey, contextToken ?? null);
    node.setPeerRunId(peerKey, runId ?? null);
    // The server grants a fresh send-window budget per user inbound message
    // (protocol.md §5: ~10 sends then `prepare failed` until the next inbound).
    // Re-open the accounting so the reply has its full budget.
    node.outbox.resetWindow(peerKey);
    // Channel-recovery hooks: a new inbound message proves the user is at the
    // phone and the token is fresh — re-push approval prompts and MUST-DELIVER
    // messages (final answers / error / stop notices) whose first delivery
    // failed (审批必达 + 关键结果必达: core.retryApprovalPrompt /
    // core.retryCriticalMessages).
    node.retryApprovalPrompt(peerKey);
    node.retryCriticalMessages(peerKey);
    if (images.length > 0 && (fileEntries.length > 0 || videoEntries.length > 0)) {
        // Mixed media must become one agent turn. Download both sets first, then
        // attach every local path and the original text once in stable order.
        const imagePaths = await handleImages(node, peerKey, message, images, '', false);
        await handleMediaFiles(node, peerKey, message, [...fileEntries, ...videoEntries], text, imagePaths);
        return;
    }
    if (images.length > 0) {
        await handleImages(node, peerKey, message, images, text);
        return;
    }
    if (fileEntries.length > 0 || videoEntries.length > 0) {
        await handleMediaFiles(node, peerKey, message, [...fileEntries, ...videoEntries], text);
        return;
    }
    const uncertainNotice = node.takeUncertainNotice(peerKey);
    const effectiveText = voiceWithoutText
        ? `${uncertainNotice ? `${uncertainNotice}\n` : ''}${text.trim()}${text.trim() ? '\n' : ''}[语音消息：微信未提供转写文本，无法读取内容]`.trim()
        : `${uncertainNotice ? `${uncertainNotice}\n` : ''}${text}`;
    if (!effectiveText.trim()) {
        node.ctx.logger.info('[dsh-wechat-bridge] ignoring non-text non-media message from %s', senderId);
        return;
    }
    if (voiceWithoutText) {
        void sendTextToPeer(node, peerKey, '🎙 收到语音，但微信未提供转写文本，无法读取其内容；请改用文字或图片。', { kind: 'system' });
    }
    await node.handleText(peerKey, effectiveText);
}
//# sourceMappingURL=inbound.js.map