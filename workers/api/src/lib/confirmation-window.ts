/** Return known partial outcomes before the MCP transport deadline (#886, #887).
 * The operation keeps running; a confirmation deadline never cancels a machine mutation.
 * `pending` may be async — it can look once more at the state the operation is changing (#922).
 */
export const CONFIRMATION_WINDOW_MS = 15_000;

export async function withinConfirmationWindow<T, P>(operation: Promise<T>, pending: () => P | Promise<P>, keepAlive: (operation: Promise<unknown>) => void): Promise<T | P> {
	keepAlive(operation.catch(() => undefined));
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<P>((resolve) => { timer = setTimeout(() => resolve(pending()), CONFIRMATION_WINDOW_MS); }),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
