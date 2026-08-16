/**
 * WeChat-bound Markdown rendering policy.
 *
 * The iLink bot channel renders Markdown in the WeChat client: headings
 * (h1–h4), bold, lists, tables, code fences, inline code, horizontal rules
 * and blockquotes all render. What does NOT render well varies by client
 * version — the official channel strips CJK italic, h5/h6 and inline images.
 *
 * Three policies:
 * - `passthrough` (default): send model Markdown as-is; only inline images
 *   `![alt](url)` become tappable plain URLs (no way to render them inline).
 * - `filter`: run the official streaming filter (see below), keeping exactly
 *   what the official channel ships — the conservative cross-client choice.
 * - `plain`: strip every marker; for clients that render nothing.
 *
 * `StreamingMarkdownFilter` is a behavior-preserving port of
 * `src/messaging/markdown-filter.ts` from Tencent/openclaw-weixin (MIT,
 * Copyright (C) 2026 Tencent) — ported field-for-field; its official test
 * vectors are mirrored in test/markdown.test.ts. See LICENSE.
 *
 * @module dsh-wechat-bridge/node/markdown
 */
export type MarkdownMode = 'passthrough' | 'filter' | 'plain';
export declare class StreamingMarkdownFilter {
    private buf;
    private fence;
    private sol;
    private inl;
    feed(delta: string): string;
    flush(): string;
    private pump;
    /** Inside a code fence: pass content and markers through verbatim. */
    private pumpFence;
    /** At start of line: detect and consume line-start patterns, then transition to body. */
    private pumpSOL;
    /** Scan line body for inline pattern triggers; output safe chars eagerly. */
    private pumpBody;
    /** Accumulate inline content until closing marker is found. */
    private pumpInline;
    private static containsCJK;
}
/** Apply the WeChat rendering policy to one assistant text. */
export declare function renderForWechat(content: string, mode: MarkdownMode): string;
//# sourceMappingURL=markdown.d.ts.map