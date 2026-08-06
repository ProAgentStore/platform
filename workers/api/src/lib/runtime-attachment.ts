/**
 * Why isn't this agent attached to its runner? (#237)
 *
 * The console showed an unexplained amber dot: the machine reads online (its other agents are
 * connected and heartbeating) while this one agent reports "not attached", with no reason and
 * no remedy. The CLI knows both — it prints the close code and the `--force` hint to its own
 * stdout, which nobody is watching — but none of that reaches the browser.
 *
 * All of it is derivable server-side, so this needs no CLI change and no version skew: the
 * combination of "is there a registered node", "is its heartbeat fresh", and "is a relay socket
 * actually live" already distinguishes every case the user can be in.
 */

export type AttachmentState =
	/** A relay socket is live for this instance on the resolved node. */
	| "attached"
	/** No runtime row at all — `pags up` has never registered this agent. */
	| "never-registered"
	/** Registered, but the machine itself has gone quiet. */
	| "runner-offline"
	/** The machine is alive and heartbeating, yet THIS agent has no socket. */
	| "machine-online-agent-detached";

export interface AttachmentDiagnosis {
	state: AttachmentState;
	/** One sentence the console can show verbatim. */
	message: string;
	/** The single command that fixes it, when one exists. */
	remedy: string | null;
}

/** A heartbeat older than this means the machine is not talking to us any more. The runner
 *  heartbeats every 30s, so ~90s is three misses — the same window the status probe uses. */
export const HEARTBEAT_FRESH_MS = 90_000;

export function diagnoseAttachment(input: {
	hasRuntimeRow: boolean;
	relayConnected: boolean;
	lastSeenAt: string | null | undefined;
	now?: number;
}): AttachmentDiagnosis {
	if (input.relayConnected) {
		return { state: "attached", message: "Connected.", remedy: null };
	}
	if (!input.hasRuntimeRow) {
		return {
			state: "never-registered",
			message: "No runner has registered for this agent yet.",
			remedy: "pags up",
		};
	}
	const seen = input.lastSeenAt ? Date.parse(`${input.lastSeenAt.replace(" ", "T")}Z`) : 0;
	const fresh = seen > 0 && (input.now ?? Date.now()) - seen < HEARTBEAT_FRESH_MS;
	if (!fresh) {
		return {
			state: "runner-offline",
			message: "The runner for this agent isn't running.",
			remedy: "pags up",
		};
	}
	// The interesting case, and the one that produced the unexplained amber dot: the machine is
	// demonstrably alive — it is still heartbeating — but this agent has no socket. On the
	// current relay design that means another runner on the same hostname already holds it and
	// this one was rejected with 4409, which `--force` is exactly the answer to.
	return {
		state: "machine-online-agent-detached",
		message: "The machine is online but this agent isn't attached — another runner on it may already hold this agent.",
		remedy: "pags up --force",
	};
}
