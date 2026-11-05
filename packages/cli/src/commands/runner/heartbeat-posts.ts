/** Bound heartbeat delivery (#1545): one hung request/body must not starve the other agents or the next cycle. */
export const HEARTBEAT_POST_TIMEOUT_MS = 10_000;
const HEARTBEAT_CONCURRENCY = 4;

export async function heartbeatPosts(ids: readonly string[], post: (id: string, signal: AbortSignal) => Promise<void>): Promise<string | null> {
	let next = 0;
	let failure: string | null = null;
	const worker = async () => {
		while (next < ids.length) {
			const id = ids[next++];
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					post(id, controller.signal),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							const error = new Error(`Heartbeat ${id.slice(0, 8)} did not finish within ${HEARTBEAT_POST_TIMEOUT_MS / 1000}s`);
							controller.abort(error);
							reject(error);
						}, HEARTBEAT_POST_TIMEOUT_MS);
						timer.unref?.();
					}),
				]);
			} catch (error) {
				failure ??= error instanceof Error ? error.message : String(error);
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(ids.length, HEARTBEAT_CONCURRENCY) }, worker));
	return failure;
}

/** Serialize machine-wide side effects and reject late replies/abandoned queued work across heartbeat cycles. */
export function heartbeatAcceptance<T>(accept: (value: T, signal: AbortSignal) => Promise<void>) {
	let queue = Promise.resolve();
	let latest = 0;
	return (value: T, sequence: number, signal: AbortSignal): Promise<void> => {
		const applying = queue.then(async () => {
			signal.throwIfAborted();
			if (sequence <= latest) return;
			latest = sequence;
			await accept(value, signal);
		});
		queue = applying.catch(() => undefined);
		return applying;
	};
}
