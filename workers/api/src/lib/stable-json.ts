/**
 * Deterministic JSON: keys sorted at every level, so a value serialises identically regardless
 * of the order its fields happened to be built in.
 *
 * Shared because two independent "is this the same thing twice?" checks need it and they must
 * not drift: the pump's delivery idempotency key (`connection-deliveries.ts`) and the agent
 * loop's cross-round tool dedup (`agent-think.ts`). Plain `JSON.stringify` is key-order
 * dependent, which makes it silently wrong for identity — `{"key":"a","value":"b"}` and
 * `{"value":"b","key":"a"}` are the same call and hash differently.
 *
 * `undefined` properties are dropped rather than serialised, matching JSON.stringify's own
 * behaviour, so an explicitly-undefined field and an absent one compare equal.
 */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
