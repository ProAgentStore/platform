// "Gone for now" vs "broken" — the classification, as a LEAF (#341).
//
// Deliberately its own module and deliberately importing nothing. `runner-client.ts` has to be
// able to RAISE this, and `runner-availability.ts` — which decides what to do about it — reads
// connectivity through `instance-connectivity.ts`, which imports `runner-client.ts`. Putting the
// error class next to the policy would close that triangle, and `import-graph.test.ts` forbids a
// static cycle even when it is type-only. Same shape, and same reason, as `connectors/types.ts`.
//
// What lives here is only the JUDGEMENT a thrower can make from a relay response. The remedy —
// which command actually fixes it — needs `diagnoseAttachment`, and is a level up.

/**
 * The marker `callRunner` puts in the message so the classification survives serialisation
 * across a Cloudflare Workflow step boundary: the engine hands the receiving side a message,
 * not a prototype. Load-bearing — the class check alone would silently stop matching.
 */
export const NO_SOCKET_MARKER = "the relay has no live socket";

/**
 * RelayDO reasons that mean the socket went away WHILE a command was in flight — the shape a
 * mid-run drop actually takes, and the one a 503 (no socket at dispatch) misses.
 *
 * "Relay command timed out" is deliberately NOT here. That is a runner still connected and not
 * answering — a wedged engine, not an absent machine — and waiting ten minutes for a machine
 * that is present would turn a fast honest failure into a slow one.
 */
const DROPPED_REASONS = ["Runner disconnected", "Runner WebSocket error"];

/** A runner-side failure that WILL heal on its own if given time. */
export class RunnerUnreachableError extends Error {
	/** The field #339 asks for: the thrower knows, so no catch site has to guess from wording. */
	readonly retryable = true;
	readonly runnerUnreachable = true;
	constructor(message: string) {
		super(message);
		this.name = "RunnerUnreachableError";
	}
}

/** The runner was waited for and did not come back. Terminal, and says so honestly. */
export class RunnerGoneError extends Error {
	readonly retryable = false;
	readonly runnerGone = true;
	constructor(message: string) {
		super(message);
		this.name = "RunnerGoneError";
	}
}

export function isRunnerUnreachable(e: unknown): boolean {
	if (e instanceof RunnerUnreachableError) return true;
	const err = e as { runnerUnreachable?: unknown; message?: unknown } | null;
	if (err?.runnerUnreachable === true) return true;
	const msg = typeof err?.message === "string" ? err.message : "";
	return msg.includes(NO_SOCKET_MARKER) || DROPPED_REASONS.some((r) => msg.includes(r));
}

export function isRunnerGone(e: unknown): boolean {
	return e instanceof RunnerGoneError || (e as { runnerGone?: unknown } | null)?.runnerGone === true;
}

/** Classify a relay response. Exported so `runner-client.ts` and its tests agree on one rule. */
export function relayFailureIsDisconnect(status: number, body: string): boolean {
	if (status === 503) return true;
	return status === 504 && DROPPED_REASONS.some((r) => body.includes(r));
}
