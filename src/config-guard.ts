/**
 * P2-5: strict config validation. schemastery's z.object silently KEEPS
 * unknown keys (no .strict()), so a typo like `markdownmode` would be
 * ignored without any signal. The gateway/node apply paths call this with
 * the schema's own key set — unknown keys fail the mount loudly instead.
 *
 * @module dsh-wechat-bridge/config-guard
 */

/** Fail fast when the config object carries keys the schema never declared. */
export function assertNoUnknownKeys(
  config: Record<string, unknown> | undefined,
  known: ReadonlySet<string>,
  label: string,
): void {
  if (!config) return
  const unknown = Object.keys(config).filter((k) => !known.has(k))
  if (unknown.length === 0) return
  throw new Error(
    `[dsh-wechat-bridge] ${label}: unknown config key(s): ${unknown.join(', ')}` +
      ` — known keys: ${[...known].sort().join(', ')}`,
  )
}

/** Extract the declared key set from a schemastery object schema. */
export function schemaKeys(schema: { dict?: Record<string, unknown> }): ReadonlySet<string> {
  return new Set(Object.keys(schema.dict ?? {}))
}

/** Reject credentials embedded in a configured HTTP(S) endpoint URL. */
export function assertCleanBaseUrl(raw: string | undefined, label: string): void {
  if (!raw) return
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`[dsh-wechat-bridge] ${label}: must be a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[dsh-wechat-bridge] ${label}: only http(s) URLs are allowed`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`[dsh-wechat-bridge] ${label}: credential-bearing URLs are forbidden; use the credentials service`)
  }
  for (const key of parsed.searchParams.keys()) {
    if (/token|secret|password|passwd|api[-_]?key|authorization|auth|signature|sig/i.test(key)) {
      throw new Error(`[dsh-wechat-bridge] ${label}: credential-like query parameters are forbidden`)
    }
  }
}
