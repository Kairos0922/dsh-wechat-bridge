/**
 * Preset/mode discovery — backed by the DSH `agentPresets` service.
 *
 * Differentiator #1: `/modes` lists EVERY agent preset the deployment knows
 * (authored + shipped), each annotated with the Chinese display name and
 * description published in its `preset.yml`. Discovery goes through the
 * service's `list()` — one capability, owned once: the bridge never re-scans
 * directories or re-parses metadata.
 *
 * @module dsh-wechat-bridge/node/presets
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '../home.ts'

export { resolveDshHome }

/** What a mode entry needs from the roster (structural — no package dep). */
export interface ModeInfo {
  id: string
  name?: string
  description?: string
  order?: number
  broken?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Agent preset registry — presets are composed via setup, not meta alone. */
    agentPresets: {
      list(): Promise<Array<{ id: string; name?: string; description?: string; order?: number; broken?: string }>>
      mount(agentCtx: Context, presetId: string): Promise<unknown>
    }
  }
}

/** All mountable modes, in roster order (order asc, then id). Broken skipped. */
export async function listModes(ctx: Context): Promise<ModeInfo[]> {
  let presets: ModeInfo[] = []
  try {
    presets = (await ctx.agentPresets.list()) as ModeInfo[]
  } catch {
    return []
  }
  return presets
    .filter((p) => !p.broken)
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
}

/** Resolve the effective mode for a session: explicit id, default, or none. */
export async function resolveMode(
  ctx: Context,
  explicit?: string,
  defaultMode?: string,
): Promise<string | undefined> {
  const modes = await listModes(ctx)
  if (explicit && modes.some((p) => p.id === explicit)) return explicit
  if (defaultMode && modes.some((p) => p.id === defaultMode)) return defaultMode
  return undefined
}
