/** Map with at most `cap` (1–20) calls in flight; results keep the input order. Used by the
 *  paginate/fan_out steps and the Terminals relay probes. */
export async function mapWithConcurrency<T, R>(items: T[], cap: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const limit = Math.max(1, Math.min(cap || 1, 20));
	const results: R[] = new Array(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}
