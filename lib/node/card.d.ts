/**
 * Long-image card skeleton: Markdown → styled HTML → Chrome headless
 * screenshot → PNG, sent through the WeChat IMAGE channel.
 *
 * Two-pass rendering keeps the image exactly content-height: pass 1
 * (--dump-dom) measures `document.body.scrollHeight` via a title trick, pass
 * 2 (--screenshot) captures at that height. Chrome is an external system
 * binary (auto-detected; configurable via `chromePath`) — no npm native
 * dependencies.
 *
 * @module dsh-wechat-bridge/node/card
 */
/** Minimal readable card template (plain <pre>, mobile-friendly width). */
export declare function buildCardHtml(markdown: string): string;
/** Estimate content height for the screenshot window (pass-1 measure wins). */
export declare function estimateHeight(contentLength: number): number;
export interface CardRenderResult {
    filePath: string;
}
/**
 * Render markdown to a PNG via Chrome headless (two passes). The returned
 * path is under `dir`. Throws when no Chrome binary is found or the render
 * fails — callers treat card rendering as best-effort.
 */
export declare function renderCardToPng(dir: string, basename: string, markdown: string, chromePath?: string): Promise<CardRenderResult>;
//# sourceMappingURL=card.d.ts.map