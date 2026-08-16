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
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const execFileAsync = promisify(execFile);
const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
];
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
/** Minimal readable card template (plain <pre>, mobile-friendly width). */
export function buildCardHtml(markdown) {
    const body = escapeHtml(markdown);
    return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<style>
  body { margin: 0; padding: 18px 20px; background: #ffffff; color: #1f2328;
         font: 16px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
         white-space: pre-wrap; word-break: break-word; }
  .meta { color: #8b949e; font-size: 12px; margin-bottom: 12px; }
</style>
<script>window.addEventListener('load', () => { document.title = String(document.body.scrollHeight) })</script>
</head>
<body><div class="meta">dsh-wechat-bridge · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</div>${body}</body></html>`;
}
/** Estimate content height for the screenshot window (pass-1 measure wins). */
export function estimateHeight(contentLength) {
    return Math.min(8000, Math.max(600, 160 + Math.ceil(contentLength / 22) * 28));
}
/**
 * Render markdown to a PNG via Chrome headless (two passes). The returned
 * path is under `dir`. Throws when no Chrome binary is found or the render
 * fails — callers treat card rendering as best-effort.
 */
export async function renderCardToPng(dir, basename, markdown, chromePath) {
    const chrome = chromePath?.trim() || CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
    if (!chrome)
        throw new Error('no Chrome binary found (set chromePath in the plugin config)');
    fs.mkdirSync(dir, { recursive: true });
    const htmlPath = path.join(dir, `${basename}.html`);
    const pngPath = path.join(dir, `${basename}.png`);
    const userData = path.join(dir, `.chrome-profile-${basename}`);
    fs.writeFileSync(htmlPath, buildCardHtml(markdown), 'utf-8');
    const baseArgs = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--user-data-dir=${userData}`];
    const url = pathToFileURL(htmlPath).toString();
    // Pass 1: measure content height via the injected document.title.
    let height = estimateHeight(markdown.length);
    try {
        const { stdout } = await execFileAsync(chrome, [...baseArgs, '--dump-dom', url], { timeout: 15_000 });
        const match = /<title>(\d+)<\/title>/.exec(stdout);
        if (match && Number(match[1]) > 0) {
            height = Math.min(8000, Number(match[1]) + 4); // cap aligned with estimateHeight (DPR=2 safety)
        }
    }
    catch {
        // fall back to the estimate
    }
    // Pass 2: screenshot at the measured height.
    try {
        await execFileAsync(chrome, [...baseArgs, `--window-size=500,${height}`, '--force-device-scale-factor=2', '--default-background-color=FFFFFFFF', `--screenshot=${pngPath}`, url], { timeout: 30_000 });
    }
    finally {
        try {
            fs.rmSync(userData, { recursive: true, force: true });
            fs.rmSync(htmlPath, { force: true });
        }
        catch {
            // cleanup is best-effort
        }
    }
    if (!fs.existsSync(pngPath))
        throw new Error('Chrome screenshot did not produce a file');
    return { filePath: pngPath };
}
//# sourceMappingURL=card.js.map