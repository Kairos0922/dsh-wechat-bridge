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
export interface PresetInfo {
    id: string;
    dir: string;
}
export declare function resolveAgentPresetsDir(): string;
/** Scan the agent-presets dir and return preset ids (sorted, dirs with agent.cordis.yml). */
export declare function discoverPresets(presetsDir?: string): PresetInfo[];
/** A tiny runtime registry with an in-memory cache. */
export declare class PresetRegistry {
    private cache;
    /** List presets, refreshing the cache on each call (cheap dir scan). */
    list(): PresetInfo[];
    has(id: string): boolean;
    /** Resolve the effective mode for a session: explicit id, default, or none. */
    resolveMode(explicit?: string, defaultMode?: string): string | undefined;
}
//# sourceMappingURL=presets.d.ts.map