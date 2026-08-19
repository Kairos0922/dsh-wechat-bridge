/**
 * Session export artifacts: long answers and full transcripts written as
 * local Markdown files for the WeChat file-attachment channel.
 *
 * @module dsh-wechat-bridge/node/exports
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultMediaDir } from "./inbound.js";
/** Where exported files live (under the media dir; retention covers them). */
export function exportsDir(node) {
    return path.join(node.resolved.mediaDir ?? defaultMediaDir(), 'exports');
}
function safeName(value) {
    return value.replace(/[^\w.-]+/g, '-').slice(0, 24);
}
/** Write one export artifact and return its path + attachment name. */
export function writeExportFile(node, sessionId, content, kind) {
    const dir = exportsDir(node);
    fs.mkdirSync(dir, { recursive: true });
    // Random suffix: two exports in the same millisecond must not overwrite
    // each other; tmp+rename keeps a crash from leaving a half-written file
    // that would later be uploaded as the attachment.
    const fileName = `ds-${kind}-${safeName(String(sessionId))}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.md`;
    const filePath = path.join(dir, fileName);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return { filePath, fileName };
}
/** Render a full session transcript as readable Markdown. */
export function buildTranscript(session) {
    const lines = [`# 会话 ${session.id}`, ''];
    for (const event of session.events) {
        if (event.type === 'user/message') {
            const text = event.data.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join('\n')
                .trim();
            if (text)
                lines.push(`## 👤 用户\n\n${text}\n`);
        }
        else if (event.type === 'assistant/message') {
            const text = event.data.message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join('\n')
                .trim();
            if (text)
                lines.push(`## 🤖 助手\n\n${text}\n`);
        }
        else if (event.type === 'tool/call') {
            lines.push(`- 🛠 ${event.data.name}`);
        }
    }
    return lines.join('\n').trim() || `# 会话 ${session.id}\n\n(空会话)`;
}
//# sourceMappingURL=exports.js.map