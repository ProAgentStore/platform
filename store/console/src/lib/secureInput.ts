import type { SecureInputView } from "./types";

/**
 * How the console describes a secure input (#906, #918) — metadata only; the value never reaches
 * the console in any shape.
 *
 * Two kinds share one store. An OWNER ENTRY waits for the owner to type a value. A MACHINE DEPOSIT
 * was read from a file by one machine's tmux Operator (`tmux_secure_put`) and waits for another
 * machine's Operator to write it out (`tmux_secure_get`) — there is nothing for the owner to type,
 * so it must never render an input box, only where it came from and where it went.
 */
export function isMachineDeposit(r: Pick<SecureInputView, "sourceNode">): boolean {
	return Boolean(r.sourceNode);
}

/** One line under the label: what this request is waiting for, or what became of it. */
export function secureInputStatusLine(r: Pick<SecureInputView, "status" | "sourceNode" | "consumedNode">): string {
	const from = r.sourceNode ? `from ${r.sourceNode}` : "";
	switch (r.status) {
		case "pending":
			return "Waiting for you to enter the value";
		case "ready":
			return r.sourceNode ? `Deposited ${from} — waiting to be retrieved on another machine` : "Entered — waiting for the agent to use it";
		case "consumed":
			if (r.sourceNode) return r.consumedNode ? `Moved ${from} to ${r.consumedNode}` : `Deposited ${from} and retrieved`;
			return r.consumedNode ? `Used on ${r.consumedNode}` : "Used — the value has been deleted";
		case "expired":
			return "Expired unused — the value was deleted";
	}
}
