/**
 * Pure helpers for the test-cycle-executions tool: response slimming and
 * component tallying. No I/O — unit-testable without an API key.
 */

/**
 * Recursively drop dead weight from an API response: `null`/`undefined` values,
 * empty objects (`priority: {}`, `status: {}`), and empty arrays. Lossless for
 * informational content; cuts execution-list payloads dramatically.
 */
export function stripEmptyDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripEmptyDeep(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      const cleaned = stripEmptyDeep(v);
      if (typeof cleaned === "object" && cleaned !== null && Object.keys(cleaned).length === 0) continue;
      out[k] = cleaned;
    }
    return out as unknown as T;
  }
  return value;
}

/** Extract component names from an execution/test-case record. Handles `[{name}]` and `["name"]`. */
export function componentNames(item: unknown): string[] {
  const comps = (item as { components?: unknown })?.components;
  if (!Array.isArray(comps)) return [];
  return comps
    .map((c) => (typeof c === "string" ? c : (c as { name?: unknown })?.name))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

/**
 * Tally execution records by component name. Records with no components are
 * counted under "(none)"; a record with N components contributes to N buckets.
 * Returns buckets sorted by count descending, then name.
 */
export function tallyByComponent(items: unknown[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const names = componentNames(item);
    const keys = names.length ? names : ["(none)"];
    for (const name of keys) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
}
