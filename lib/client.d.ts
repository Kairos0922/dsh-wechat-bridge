/**
 * Web settings panel for dsh-wechat-bridge (differentiator #3):
 * gateway status, QR pairing, allowlist overview and mode list — all in the
 * DSH Web settings UI. No CLI QR juggling.
 *
 * Talks to the host half over same-origin endpoints
 * (`/api/dsh-wechat-bridge/status`, `/api/dsh-wechat-bridge/pair`).
 *
 * @module dsh-wechat-bridge/client
 */
import type { Context } from '@deepseek-ai/cordis';
declare module '@deepseek-ai/cordis' {
    interface Context {
        slots: {
            inject(name: string, registrant: () => unknown): void;
            register(opts: Record<string, unknown>, component: unknown): unknown;
        };
        locale: {
            register(ns: string, dict: Record<string, Record<string, string>>): () => void;
            bind(ns: string): (key: string) => string;
        };
    }
}
export declare const inject: readonly ["slots", "locale"];
export declare function apply(ctx: Context): void;
//# sourceMappingURL=client.d.ts.map