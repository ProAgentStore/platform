/**
 * Keep an MCP SSE stream from going silent (#1038).
 *
 * `agents/mcp` answers each Streamable HTTP POST with an SSE stream fed from a per-request
 * WebSocket to the session's DO, and writes NOTHING on it until the tool's result arrives. The
 * standalone GET stream is quieter still: it may carry nothing for its whole life. A silent stream
 * is what an idle timeout anywhere between here and the client cuts, and a cut POST stream loses a
 * result the tool may already have produced. So every MCP SSE response gets an SSE comment line
 * (`: ping`) every {@link SSE_PING_MS} while it is open. Comments are ignored by spec-compliant SSE
 * parsers (the MCP SDK's client included); a ping is only written between events, never inside one.
 */

export const SSE_PING_MS = 15_000;
const PING = new TextEncoder().encode(": ping\n\n");

/** True when `chunk` ends an SSE event (a blank line), so a ping after it cannot split one. */
function endsEvent(chunk: Uint8Array, previous: boolean): boolean {
	if (chunk.length === 0) return previous;
	const n = chunk.length;
	return (n >= 2 && chunk[n - 1] === 10 && chunk[n - 2] === 10) || (n >= 4 && chunk[n - 1] === 10 && chunk[n - 2] === 13 && chunk[n - 3] === 10 && chunk[n - 4] === 13);
}

export function withSseKeepAlive(response: Response, intervalMs = SSE_PING_MS): Response {
	if (!response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response;
	const reader = response.body.getReader();
	let timer: ReturnType<typeof setInterval> | undefined;
	let atBoundary = true;
	let open = true;
	const stop = () => {
		open = false;
		if (timer !== undefined) clearInterval(timer);
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			timer = setInterval(() => {
				if (!open || !atBoundary) return;
				try {
					controller.enqueue(PING);
				} catch {
					stop();
				}
			}, intervalMs);
		},
		async pull(controller) {
			try {
				const { value, done } = await reader.read();
				if (done) {
					stop();
					controller.close();
					return;
				}
				controller.enqueue(value);
				atBoundary = endsEvent(value, atBoundary);
			} catch (err) {
				stop();
				controller.error(err);
			}
		},
		// The client went away: stop pinging and let the bridge close its socket to the DO.
		cancel(reason) {
			stop();
			return reader.cancel(reason);
		},
	});
	return new Response(stream, response);
}

/** {@link withSseKeepAlive} on every response of `inner`, whatever its fetch signature. */
// biome-ignore lint/suspicious/noExplicitAny: forwards any handler's own (request, env, ctx) unchanged
export function keepSseAlive<H extends { fetch: (...args: any[]) => Response | Promise<Response> }>(inner: H, intervalMs = SSE_PING_MS): H {
	return {
		...inner,
		async fetch(...args: Parameters<H["fetch"]>) {
			return withSseKeepAlive(await inner.fetch(...args), intervalMs);
		},
	} as H;
}
