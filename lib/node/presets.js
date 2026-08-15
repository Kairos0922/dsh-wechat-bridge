/**
 * PresetRegistry — dynamic discovery of the current user's agent presets.
 *
 * Differentiator #1: instead of a single hardcoded `agentPreset` config, the
 * bridge enumerates `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml` at runtime
 * and refreshes on demand. Any preset the user has (life-finance,
 * life-career, life-butler, ...) becomes a WeChat mode automatically.
 *
 * @module dsh-wechat-bridge/node/presets
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function resolveAgentPresetsDir() {
    const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
    return path.join(dshHome, '.agent-presets');
}
/** Scan the agent-presets dir and return preset ids (sorted, dirs with agent.cordis.yml). */
export function discoverPresets(presetsDir = resolveAgentPresetsDir()) {
    let entries = [];
    try {
        entries = fs.readdirSync(presetsDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const result = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const dir = path.join(presetsDir, entry.name);
        if (fs.existsSync(path.join(dir, 'agent.cordis.yml'))) {
            result.push({ id: entry.name, dir });
        }
    }
    result.sort((a, b) => a.id.localeCompare(b.id));
    return result;
}
/** A tiny runtime registry with an in-memory cache. */
export class PresetRegistry {
    cache = null;
    /** List presets, refreshing the cache on each call (cheap dir scan). */
    list() {
        this.cache = discoverPresets();
        return this.cache;
    }
    has(id) {
        return this.list().some((p) => p.id === id);
    }
    /** Resolve the effective mode for a session: explicit id, default, or none. */
    resolveMode(explicit, defaultMode) {
        const presets = this.list();
        if (explicit && presets.some((p) => p.id === explicit))
            return explicit;
        if (defaultMode && presets.some((p) => p.id === defaultMode))
            return defaultMode;
        return undefined;
    }
}
//# sourceMappingURL=presets.js.map