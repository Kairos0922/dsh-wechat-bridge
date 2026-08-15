/**
 * WeChat command vocabulary: /modes /new /use /sessions /stop /status
 * /yes /no /help.
 *
 * Differentiator #1 lives here: `/modes` lists the agent presets discovered
 * at runtime (never hardcoded), and `/new [mode] <prompt>` creates the
 * session with that preset. `/yes`/`/no` and bare `1`/`2` resolve pending
 * approvals (see `approvals.ts`).
 *
 * @module dsh-wechat-bridge/node/commands
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { WechatBridgeNode } from './core.ts';
/** Sessions ordered most-recent-first. */
export declare function listSessions(node: WechatBridgeNode): Session[];
/**
 * Parse `/new` arguments: an optional mode (matching a discovered preset)
 * followed by the initial prompt.
 */
export declare function parseNewArgs(node: WechatBridgeNode, rest: string[]): {
    mode?: string;
    prompt: string;
};
/** Try to route one command. Returns true when the text was a command. */
export declare function routeCommand(node: WechatBridgeNode, text: string): Promise<boolean>;
//# sourceMappingURL=commands.d.ts.map