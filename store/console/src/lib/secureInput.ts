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
export function isMachineDeposit(r: Pick<SecureInputView, "sourceNode" | "kind">): boolean {
	// The server's `kind` (#929): a deposit made over a connection with no node name has no
	// `sourceNode`, and reading that absence as "owner entry" offered a password box for it.
	return r.kind ? r.kind === "deposit" : Boolean(r.sourceNode);
}

/** One line under the label: what this request is waiting for, or what became of it. */
export function secureInputStatusLine(r: Pick<SecureInputView, "status" | "sourceNode" | "consumedNode" | "kind">): string {
	const deposit = isMachineDeposit(r);
	const from = r.sourceNode ? `from ${r.sourceNode}` : "from a machine";
	switch (r.status) {
		case "pending":
			return "Waiting for you to enter the value";
		case "ready":
			return deposit ? `Deposited ${from} — waiting to be retrieved on another machine` : "Entered — waiting for the agent to use it";
		case "consumed":
			if (deposit) return r.consumedNode ? `Moved ${from} to ${r.consumedNode}` : `Deposited ${from} and retrieved`;
			return r.consumedNode ? `Used on ${r.consumedNode}` : "Used — the value has been deleted";
		case "expired":
			return "Expired unused — the value was deleted";
	}
}

/**
 * The requests waiting on the OWNER, oldest first — the ones the banner must not let them miss (#934).
 * A machine deposit is excluded: there is nothing to type, so it is not "waiting for you".
 */
export function ownerWaiting(requests: readonly SecureInputView[]): SecureInputView[] {
	return requests
		.filter((r) => r.status === "pending" && !isMachineDeposit(r))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The banner's sentence for one or more waiting requests. Labels only — there is no value yet. */
export function secureInputBannerText(waiting: readonly Pick<SecureInputView, "label">[]): string {
	if (waiting.length === 0) return "";
	const first = `“${waiting[0].label}”`;
	return waiting.length === 1
		? `This agent is waiting for you to enter a value: ${first}.`
		: `This agent is waiting for you to enter ${waiting.length} values, starting with ${first}.`;
}

/**
 * A `sudo` request's command, as the owner reads it before approving (#1131): `sudo -- pmset -a autorestart 1`. Display only — what is approved
 * and run is the argv array, never this string. An argument with a space or a shell character is quoted so the owner can see where it ends.
 */
export function sudoCommandLine(argv: readonly string[]): string {
	const quote = (a: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
	return `sudo -- ${argv.map(quote).join(" ")}`;
}

/** Does this request run a command as root, and so need the owner's approval of it with the value? */
export function needsCommandApproval(r: Pick<SecureInputView, "destinationScope" | "command">): boolean {
	return r.destinationScope === "sudo" && Array.isArray(r.command) && r.command.length > 0;
}

/** May the owner press Submit? A value is needed, and for a sudo request the exact command must be approved too. */
export function canSubmitSecureInput(r: Pick<SecureInputView, "destinationScope" | "command">, state: { value: string; approved: boolean }): boolean {
	return state.value.length > 0 && (!needsCommandApproval(r) || state.approved);
}

/** The body of the submit call: the value, and for a sudo request the argv exactly as it was shown — the server stores nothing unless it matches. */
export function secureInputSubmitBody(r: Pick<SecureInputView, "destinationScope" | "command">, value: string): { value: string; approvedCommand?: string[] } {
	return needsCommandApproval(r) ? { value, approvedCommand: [...(r.command as string[])] } : { value };
}
