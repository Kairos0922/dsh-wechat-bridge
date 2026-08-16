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
import { resolveDshHome } from "../home.js";
export { resolveDshHome };
/** All mountable modes, in roster order (order asc, then id). Broken skipped. */
export async function listModes(ctx) {
    let presets = [];
    try {
        presets = (await ctx.agentPresets.list());
    }
    catch {
        return [];
    }
    return presets
        .filter((p) => !p.broken)
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
}
/** Resolve the effective mode for a session: explicit id, default, or none. */
export async function resolveMode(ctx, explicit, defaultMode) {
    const modes = await listModes(ctx);
    if (explicit && modes.some((p) => p.id === explicit))
        return explicit;
    if (defaultMode && modes.some((p) => p.id === defaultMode))
        return defaultMode;
    return undefined;
}
//# sourceMappingURL=presets.js.map