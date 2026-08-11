/**
 * The one line `runner connect` prints for the TUI to read, instead of the TUI guessing (#497).
 *
 * `pags up` spawns `runner connect` as a child and derives the three-light pane by string-matching
 * its prose. That inference was wrong in every direction at once:
 *
 *   - `up.ts` matched `"Another machine"`, a string nothing in the repo ever printed — so a relay
 *     conflict, the one failure with a one-command remedy, lit no branch at all.
 *   - `"WebSocket relay"` and `"CONNECTED"` — both parts of the RELAY banner — set the
 *     REGISTRATION light green, so a machine that registered nothing still showed a tick.
 *   - `"fetch failed"` from a failed HEARTBEAT set the registration light red, and the line that
 *     announces the heartbeat's recovery matched nothing, so the ✗ was a latch: no line the runner
 *     could ever emit afterwards could clear it.
 *
 * The owner's screenshot ("Secure link connected · ProAgentStore not registered") is producible by
 * two unrelated faults and the pane cannot say which — the defect being that indistinguishability.
 * So the child now STATES its product-level facts and the parent parses them. Prose stays prose,
 * free to be reworded by the next commit without silently re-breaking the lights.
 */

export type RegistrationState = "ok" | "partial" | "fail";
export type HeartbeatState = "ok" | "fail";

export interface RunnerStatus {
	registration?: RegistrationState;
	heartbeat?: HeartbeatState;
	/** "3/3" — how many of this machine's agents hold a runtime registration. */
	agents?: string;
	/** Free text, last: everything after `reason=` belongs to it, spaces included. */
	reason?: string;
}

/** The prefix that makes the line unmistakable in a mixed stdout stream. */
export const STATUS_PREFIX = "PAGS-STATUS";

export function formatStatusLine(status: RunnerStatus): string {
	const parts: string[] = [];
	if (status.registration) parts.push(`registration=${status.registration}`);
	if (status.heartbeat) parts.push(`heartbeat=${status.heartbeat}`);
	if (status.agents) parts.push(`agents=${status.agents}`);
	// Last, and unquoted: a reason is a human sentence with spaces in it, and the parser takes
	// everything after `reason=` verbatim rather than pretending the words are more fields.
	if (status.reason) parts.push(`reason=${status.reason.replace(/\s+/g, " ").trim().slice(0, 200)}`);
	return `${STATUS_PREFIX} ${parts.join(" ")}`;
}

/** Parse one line. Returns null for anything that is not a status line — most of stdout. */
export function parseStatusLine(line: string): RunnerStatus | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith(`${STATUS_PREFIX} `)) return null;
	const body = trimmed.slice(STATUS_PREFIX.length + 1);
	const status: RunnerStatus = {};
	const reasonAt = body.indexOf("reason=");
	const head = reasonAt >= 0 ? body.slice(0, reasonAt) : body;
	if (reasonAt >= 0) {
		const reason = body.slice(reasonAt + "reason=".length).trim();
		if (reason) status.reason = reason;
	}
	for (const token of head.split(/\s+/).filter(Boolean)) {
		const [key, value] = token.split("=", 2);
		if (key === "registration" && (value === "ok" || value === "partial" || value === "fail")) status.registration = value;
		else if (key === "heartbeat" && (value === "ok" || value === "fail")) status.heartbeat = value;
		else if (key === "agents" && value) status.agents = value;
	}
	return status;
}
