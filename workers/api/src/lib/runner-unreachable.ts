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
 * The marker for a runner whose socket is UP but did not answer the relay's ping in time (#846) —
 * a slow or stalled machine, not an absent one. Same serialisation reason as {@link NO_SOCKET_MARKER}.
 */
export const UNRESPONSIVE_MARKER = "connected but not responding";

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
	/**
	 * Whether the command may have reached the runner (#1015). A 503 is "no socket at dispatch" —
	 * nothing was sent. A 504 drop is a socket that went away WITH THE COMMAND IN FLIGHT, which proves
	 * nothing either way. A caller that would re-send on failure must tell these apart, or a lost
	 * response becomes a duplicate instruction. Defaults to `true`, the conservative reading.
	 */
	readonly dispatched: boolean;
	/** The runner route that failed (#1358), when the thrower knows it: what the guard classifies a re-send by. */
	readonly path: string | undefined;
	constructor(message: string, opts: { dispatched?: boolean; path?: string } = {}) {
		super(message);
		this.name = "RunnerUnreachableError";
		this.dispatched = opts.dispatched ?? true;
		this.path = opts.path;
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

// ── Why it failed, as data (#1355) ───────────────────────────────────────────
//
// A runner failure used to be identified by matching its WORDS ("Relay command timed out", "the relay has no live
// socket", "Runner disconnected", …) in half a dozen files, and #1344 fixed four bugs that came from it. The relay
// now answers with a code, `callRunner` puts it in the message as ONE tag a step boundary keeps, and every reader asks
// `runnerErrorCode`. The tag also carries the disposition: `[runner-unreachable:…]` is safe to wait out (the old
// `RunnerUnreachableError` class, now readable from a flattened message too), `[runner-error:…]` is not.

/** Why a runner command failed. */
export type RunnerErrorCode =
	| "NO_SOCKET" // the relay held no socket for this agent at dispatch — nothing was sent
	| "UNRESPONSIVE" // a socket, but the runner answered neither the relay's ping nor (for a read) the command
	| "RELAY_TIMEOUT" // the relay sent the command and no reply came within its timeout
	| "DROPPED" // the socket went away with the command in flight
	| "REPLACED" // the owner's own takeover or a stale-socket eviction ended it on purpose
	| "RELAY_FAILED" // the relay could not send it for another reason (the socket refused the write)
	| "DRAINING" // the runner refused new work while it drains for a safe automatic update — nothing ran
	| "RUNNER_HTTP"; // the runner itself answered with an error status

/** The relay's wire codes (`relay-do.ts` answers with these), as the codes above. */
export const RELAY_WIRE_CODES: Readonly<Record<string, RunnerErrorCode>> = {
	RUNNER_RELAY_NO_SOCKET: "NO_SOCKET",
	RUNNER_RELAY_UNRESPONSIVE: "UNRESPONSIVE",
	RUNNER_RELAY_TIMEOUT: "RELAY_TIMEOUT",
	RUNNER_RELAY_DROPPED: "DROPPED",
	RUNNER_RELAY_REPLACED: "REPLACED",
	RUNNER_RELAY_FAILED: "RELAY_FAILED",
};

/**
 * The tag `callRunner` appends to a message. At the END, so patterns anchored on `Runner /path → status:` still hold.
 *
 * `path` (#1358) rides inside the tag as `@/coding/act`: a Workflow step boundary flattens an error to its message, so a property on
 * the error class does not survive it, and the guard has to decide whether a failed attempt may be sent again from the route.
 */
export function runnerErrorTag(code: RunnerErrorCode, unreachable: boolean, path?: string): string {
	return ` [${unreachable ? "runner-unreachable" : "runner-error"}:${code}${path ? `@${path.split("?")[0]}` : ""}]`;
}

const TAG = /\[(runner-unreachable|runner-error):([A-Z_]+)(?:@([^\]\s]+))?\]/;

/** The message without its tag — for a reader that parses the runner's body out of it. */
export function withoutRunnerErrorTag(msg: string): string {
	return msg.replace(/ ?\[(?:runner-unreachable|runner-error):[A-Z_]+(?:@[^\]\s]+)?\]$/, "");
}

/**
 * The code of a runner failure, from its tag — or, for a message written before tags existed (a run in flight across
 * the deploy), from the words it used to be recognised by. Null when it is not a runner failure this module knows.
 */
export function runnerErrorCode(e: unknown): RunnerErrorCode | null {
	const msg = typeof (e as { message?: unknown } | null)?.message === "string" ? ((e as { message: string }).message) : typeof e === "string" ? e : "";
	const tagged = TAG.exec(msg);
	if (tagged) return tagged[2] as RunnerErrorCode;
	if (msg.includes(DRAINING_MARKER) || msg.includes("draining for an automatic update")) return "DRAINING"; // the runner's words, then callRunner's
	if (msg.includes(UNRESPONSIVE_MARKER)) return "UNRESPONSIVE";
	if (msg.includes(NO_SOCKET_MARKER)) return "NO_SOCKET";
	if (DROPPED_REASONS.some((r) => msg.includes(r))) return "DROPPED";
	if (msg.includes("Relay command timed out")) return "RELAY_TIMEOUT";
	return null;
}

/** The runner route a failure names (#1358), from its class or its tag; undefined for a failure that predates the tag or does not know. */
export function runnerErrorPath(e: unknown): string | undefined {
	const own = (e as { path?: unknown } | null)?.path;
	if (typeof own === "string" && own) return own;
	const msg = typeof (e as { message?: unknown } | null)?.message === "string" ? (e as { message: string }).message : typeof e === "string" ? e : "";
	return TAG.exec(msg)?.[3];
}

/** Codes that prove nothing was sent: the relay held no socket, or the runner refused the command before it ran. */
const NOT_DISPATCHED: ReadonlySet<RunnerErrorCode> = new Set(["NO_SOCKET", "UNRESPONSIVE", "DRAINING"]);

/**
 * Might the command have reached the runner (#1358)? A 503 from the relay or a draining runner proves it did not; a timeout, a
 * dropped socket or a runner's own error proves nothing either way. Read from the class when it is still one, else from the code
 * in the tag; a failure it cannot read is treated as dispatched, because the wrong guess the other way is a duplicate.
 */
export function runnerErrorDispatched(e: unknown): boolean {
	const own = (e as { dispatched?: unknown } | null)?.dispatched;
	if (typeof own === "boolean") return own;
	const code = runnerErrorCode(e);
	return code ? !NOT_DISPATCHED.has(code) : true;
}

export function isRunnerUnreachable(e: unknown): boolean {
	if (e instanceof RunnerUnreachableError) return true;
	const err = e as { runnerUnreachable?: unknown; message?: unknown } | null;
	if (err?.runnerUnreachable === true) return true;
	const msg = typeof err?.message === "string" ? err.message : "";
	const tagged = TAG.exec(msg);
	if (tagged) return tagged[1] === "runner-unreachable";
	// Untagged (written before #1355): the words it used to be recognised by. UNRESPONSIVE_MARKER alone counts too (#1341).
	return msg.includes(NO_SOCKET_MARKER) || msg.includes(UNRESPONSIVE_MARKER) || DROPPED_REASONS.some((r) => msg.includes(r));
}

/**
 * A disconnect whose socket is still there but silent (#913). The instant status read cannot be
 * trusted right after one: the failed dispatch's own ping is milliseconds old, which that read
 * counts as connected — so a wait that asks it first ends at once on a machine still not answering.
 */
export function isRunnerUnresponsive(e: unknown): boolean {
	if (!isRunnerUnreachable(e)) return false;
	const code = runnerErrorCode(e);
	return code === "UNRESPONSIVE" || code === "RELAY_TIMEOUT" || code === "DRAINING";
}

export function isRunnerGone(e: unknown): boolean {
	return e instanceof RunnerGoneError || (e as { runnerGone?: unknown } | null)?.runnerGone === true;
}

/**
 * Classify a relay response. Exported so `runner-client.ts` and its tests agree on one rule.
 *
 * A 503 is a disconnect only when the RELAY says so (#1344) — its no-socket or unresponsive answer. The relay passes a
 * runner's own status through, so "any 503" also caught the runner's 503 while it drains for an update, and reported a
 * connected runner as having no socket.
 */
export function relayFailureIsDisconnect(status: number, body: string): boolean {
	const code = relayWireCode(body);
	if (code) return code === "NO_SOCKET" || code === "UNRESPONSIVE" || code === "DROPPED";
	// A relay that predates its codes (a deploy in progress): the words it answered with.
	if (status === 503) return /"No runner connected"/.test(body);
	return status === 504 && DROPPED_REASONS.some((r) => body.includes(r));
}

/** The relay's own code in a response body, or null — a runner's body (`origin: "runner"`) never carries one. */
export function relayWireCode(body: string): RunnerErrorCode | null {
	const m = /"code"\s*:\s*"(RUNNER_RELAY_[A-Z_]+)"/.exec(body);
	return m ? (RELAY_WIRE_CODES[m[1]] ?? null) : null;
}

/** The runner refusing new work while it drains for a safe automatic update (packages/cli relay) — refused before anything ran. */
export const DRAINING_MARKER = "draining for a safe automatic update";
