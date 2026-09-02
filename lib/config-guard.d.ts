/**
 * P2-5: strict config validation. schemastery's z.object silently KEEPS
 * unknown keys (no .strict()), so a typo like `markdownmode` would be
 * ignored without any signal. The gateway/node apply paths call this with
 * the schema's own key set — unknown keys fail the mount loudly instead.
 *
 * @module dsh-wechat-bridge/config-guard
 */
/** Fail fast when the config object carries keys the schema never declared. */
export declare function assertNoUnknownKeys(config: Record<string, unknown> | undefined, known: ReadonlySet<string>, label: string): void;
/** Extract the declared key set from a schemastery object schema. */
export declare function schemaKeys(schema: {
    dict?: Record<string, unknown>;
}): ReadonlySet<string>;
/** Reject credentials embedded in a configured HTTP(S) endpoint URL. */
export declare function assertCleanBaseUrl(raw: string | undefined, label: string): void;
//# sourceMappingURL=config-guard.d.ts.map