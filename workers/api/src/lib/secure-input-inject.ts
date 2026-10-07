/**
 * Deliver a ready secure input into a tmux pane — and say whether it got there (#966).
 *
 * Before this, `secure_input_inject` called a route that returned the PLAINTEXT to the MCP worker,
 * which dropped it and answered `success: true`. Nothing was ever typed; the one-shot value was spent;
 * the owner fell back to pasting a gcloud code into chat — the leak the feature exists to prevent.
 *
 * Now the platform types it itself, over the same runner path `tmux_send_message` uses (`/tmux/send`,
 * text then Enter), and VERIFIES it: the value must appear on the pane once more than it did before
 * the typing. A value that did not land is cleared from the line (C-u), never submitted, and RESTORED
 * — as `tmux_secure_get` restores one whose file write failed — so the owner does not re-enter it.
 *
 * The value never leaves this module: the pane that comes back from the runner shows it, so the pane
 * is read here for verification and returned NOWHERE — not in the result, a log, or a trace.
 */
import type { Env } from "../types.js";
import { callRunner, getBoundRunnerConn } from "./runner-client.js";
import { consumeSecureInput, getSecureInputStatus, restoreConsumedSecureInput } from "./secure-input.js";

export interface SecureInjectResult {
	/** The value is verifiably on the target pane's prompt line. */
	delivered: boolean;
	/** Why not, in words an operator can act on — never containing the value. Absent when delivered. */
	reason?: string;
	/** Enter was pressed after the value landed. */
	submitted: boolean;
	/** Whether the one-shot value was spent. Never true when `delivered` is false. */
	consumedValue: boolean;
	/** The tmux session it was typed into (or would have been). */
	target: string | null;
	/** The request's status after this call. */
	status: string;
	/** The value's character count, as `secure_input_status` reports it. */
	length?: number;
}

/** How many times `needle` occurs in `hay`, line wraps ignored — a long code wraps across pane rows. */
export function occurrences(hay: string, needle: string): number {
	const flat = hay.replace(/\n/g, "");
	if (!needle) return 0;
	let n = 0;
	for (let i = flat.indexOf(needle); i !== -1; i = flat.indexOf(needle, i + needle.length)) n++;
	return n;
}

type SendResult = { pane?: string; paneBefore?: string; changed?: boolean };

export async function injectSecureInputToTmux(
	env: Env,
	input: { instanceId: string; userId: string; requestId: string; target?: string | null; submit: boolean },
): Promise<SecureInjectResult | null> {
	const status = await getSecureInputStatus(env, input.requestId, input.instanceId, input.userId);
	if (!status) return null;
	const target = (input.target ?? "").trim() || status.target || null;
	const base = { submitted: false, target, length: status.length };
	const refuse = (reason: string): SecureInjectResult => ({ ...base, delivered: false, reason, consumedValue: false, status: status.status });

	if (status.status !== "ready") return refuse(`The request is ${status.status}, not ready — ${status.status === "pending" ? "the owner has not entered the value yet" : "there is no value to inject"}.`);
	if (status.destinationScope !== "tmux") return refuse(`This request is for ${status.destinationScope}, and inject delivers to tmux only. For a file, use tmux_secure_get with this request id as the handle.`);
	if (!target) return refuse("Name the tmux session to type into: `target` (see tmux_list_sessions). Nothing was consumed.");
	if (status.empty) return refuse("The submitted value is empty — ask the owner to enter it again.");

	const conn = await getBoundRunnerConn(env, input.instanceId, input.userId).catch(() => null);
	if (!conn) return refuse("No runner is connected for this agent — run `pags up` on the machine with the tmux session. Nothing was consumed.");

	// Spent only now, after every check that could be made without it.
	const value = await consumeSecureInput(env, input.requestId, input.instanceId, input.userId, { consumedNode: conn.runnerNode ?? null });
	if (value == null) return refuse("The value could not be claimed — it was used or expired a moment ago. Check secure_input_status.");

	const restore = async (reason: string): Promise<SecureInjectResult> => {
		const restored = await restoreConsumedSecureInput(env, input.requestId, input.userId, value).catch(() => false);
		return {
			...base,
			delivered: false,
			reason: `${reason} ${restored ? "The value was NOT consumed — it is still ready; fix the target and inject again." : "The value could not be restored; ask the owner to enter it again."}`,
			consumedValue: !restored,
			status: restored ? "ready" : "consumed",
		};
	};

	const needle = value.trim();
	let typed: SendResult;
	try {
		typed = await callRunner<SendResult>(conn, "/tmux/send", { session: target, text: value });
	} catch (e) {
		// A runner error names the session or the endpoint, never the text it was sent.
		return restore(`Typing into "${target}" failed: ${e instanceof Error ? e.message.replace(/^Runner \/tmux\/send → \d+: /, "") : String(e)}.`);
	}
	if (occurrences(typed.pane ?? "", needle) <= occurrences(typed.paneBefore ?? "", needle)) {
		// Whatever reached the line is cleared, so a retry cannot double it — and nothing is submitted.
		await callRunner(conn, "/tmux/send", { session: target, keys: ["C-u"] }).catch(() => undefined);
		return restore(
			`The value did not appear on "${target}"'s prompt line after typing — the session may not be at an input prompt, or the prompt hides what is typed (a password prompt cannot be verified this way).`,
		);
	}

	let submitted = false;
	if (input.submit) {
		try {
			await callRunner<SendResult>(conn, "/tmux/send", { session: target, keys: ["Enter"] });
			submitted = true;
		} catch {
			return { ...base, delivered: true, submitted: false, consumedValue: true, status: "consumed", reason: `The value is on "${target}"'s prompt line, but pressing Enter failed — press it with tmux_send_keys.` };
		}
	}
	return { ...base, delivered: true, submitted, consumedValue: true, status: "consumed" };
}
