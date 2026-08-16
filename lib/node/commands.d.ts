/**
 * WeChat command vocabulary, registry-driven.
 *
 * One registry is the single source of truth for every command: `/help`
 * renders from it (nothing can fall out of date), unknown commands fall back
 * to it. Numbered choice menus (mode/model/workspace) are registered with the
 * node so bare-number replies resolve against the open menu — no more typing
 * than a tap on mobile.
 *
 * @module dsh-wechat-bridge/node/commands
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { WechatBridgeNode } from './core.ts';
import { type ModeInfo } from './presets.ts';
/** Sessions ordered most-recent-first. */
export declare function listSessions(node: WechatBridgeNode): Session[];
/** Parse `/new` arguments: an optional mode (matching a discovered preset). */
export declare function parseNewArgs(node: WechatBridgeNode, rest: string[]): Promise<{
    mode?: string;
    prompt: string;
}>;
export interface CommandSpec {
    id: string;
    /** One line for `/help`. */
    summary: string;
    usage: string;
    /** Detail block for `/help <cmd>`. */
    detail: string;
    run(node: WechatBridgeNode, peerId: string, args: string[]): Promise<void>;
}
/**
 * Compact `/modes` rendering: one line per mode (name + id + short
 * annotation). The per-mode `/new <id>` lines were dropped — WeChat copies
 * whole bubbles, so they never enabled selective copying; the numbered-reply
 * menu is the primary path and `/new <id>` stays documented in `/help`.
 */
export declare function renderModesList(modes: ModeInfo[], defaultMode?: string, menuTimeoutSec?: number): string;
export declare const COMMANDS: CommandSpec[];
export declare function helpText(commandId?: string): string;
export type RouteResult = 'handled' | 'forward' | 'not-command';
/** Try to route one command. `forward` means: hand the unescaped text to the agent. */
export declare function routeCommand(node: WechatBridgeNode, peerId: string, text: string): Promise<RouteResult>;
//# sourceMappingURL=commands.d.ts.map