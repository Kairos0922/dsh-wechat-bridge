/**
 * Session export artifacts: long answers and full transcripts written as
 * local Markdown files for the WeChat file-attachment channel.
 *
 * @module dsh-wechat-bridge/node/exports
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { WechatBridgeNode } from './core.ts';
/** Where exported files live (under the media dir; retention covers them). */
export declare function exportsDir(node: WechatBridgeNode): string;
/** Write one export artifact and return its path + attachment name. */
export declare function writeExportFile(node: WechatBridgeNode, sessionId: string, content: string, kind: 'answer' | 'transcript'): {
    filePath: string;
    fileName: string;
};
/** Render a full session transcript as readable Markdown. */
export declare function buildTranscript(session: Session): string;
//# sourceMappingURL=exports.d.ts.map