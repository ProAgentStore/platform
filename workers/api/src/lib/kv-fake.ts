/**
 * KV as it behaves, for tests (#1016, #1084) — moved here from `routes/mcp-audit.test.ts` so the
 * telemetry spool's tests run against the same model rather than a second, looser stub.
 *
 * What the old stubs did not model: keys LEXICOGRAPHIC; `list` caps at 1000 and continues with a
 * cursor; listing metadata and absolute expirations come back with each key; an expired key neither
 * lists nor reads; an expiration under 60s away is refused. The cursor is modelled as "after this
 * key name" — so a key written behind it on a later call is not seen and one deleted ahead of it is
 * simply absent, which is the property paging relies on. `failGets` / `failPuts` inject an outage
 * for the keys a predicate picks.
 */
export function fakeKv(now = Date.now()) {
	const data = new Map<string, { value: string; expiration?: number; metadata?: unknown }>();
	const clock = { now };
	const ops = { get: 0, put: 0, list: 0 };
	let failGet: ((name: string) => boolean) | null = null;
	let failPut: ((name: string) => boolean) | null = null;
	const live = (e: { expiration?: number }) => e.expiration === undefined || e.expiration * 1000 > clock.now;
	const kv = {
		get: async (name: string) => {
			ops.get++;
			if (failGet?.(name)) throw new Error(`KV GET failed: ${name}`);
			const e = data.get(name);
			return e && live(e) ? e.value : null;
		},
		put: async (name: string, value: string, opts: { expiration?: number; expirationTtl?: number; metadata?: unknown } = {}) => {
			ops.put++;
			if (failPut?.(name)) throw new Error(`KV PUT failed: ${name}`);
			const nowS = Math.floor(clock.now / 1000);
			const expiration = opts.expiration ?? (opts.expirationTtl ? nowS + opts.expirationTtl : undefined);
			if (expiration !== undefined && expiration < nowS + 60) throw new Error("KV PUT: expiration must be at least 60s ahead");
			data.set(name, { value, expiration, metadata: opts.metadata });
		},
		delete: async (name: string) => {
			data.delete(name);
		},
		list: async ({ prefix = "", limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string } = {}) => {
			ops.list++;
			if (limit > 1000) throw new Error("KV LIST: limit is at most 1000");
			const after = cursor ? atob(cursor) : null;
			const names = Array.from(data.keys())
				.filter((n) => n.startsWith(prefix) && live(data.get(n) ?? {}) && (after === null || n > after))
				.sort();
			const page = names.slice(0, limit);
			const complete = names.length <= limit;
			return {
				keys: page.map((name) => ({ name, expiration: data.get(name)?.expiration, metadata: data.get(name)?.metadata })),
				list_complete: complete,
				cursor: complete ? undefined : btoa(page[page.length - 1] ?? ""),
				cacheStatus: null,
			};
		},
	} as unknown as KVNamespace;
	return {
		kv,
		data,
		clock,
		ops,
		failGets: (fn: ((name: string) => boolean) | null) => (failGet = fn),
		failPuts: (fn: ((name: string) => boolean) | null) => (failPut = fn),
	};
}
