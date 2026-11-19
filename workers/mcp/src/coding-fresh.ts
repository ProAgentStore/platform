/**
 * The two answers `coding_session_fresh` must not get wrong (#1528), held apart from `coding-tools.ts` so the tool's own
 * control flow stays readable.
 *
 * A fresh start is "end this repo's session, then open a NEW conversation". The old session's row closing is not its engine
 * stopping, and a reply that REUSED a session is not a fresh start: both are failures to be reported as such, never as the
 * success the tool's name promises.
 */

export interface EndReply {
	engineStopped?: boolean | null;
	warning?: string;
}

/**
 * The refusal to open a new conversation over an engine that did not confirm it stopped, or null when it may go on.
 * `false` means a runner ANSWERED without confirming — the engine may still be editing the checkout. `null` (no reachable
 * runner to ask) is not refused here; the caller reports it beside the new session instead of hiding it.
 */
export function unconfirmedStopReply(instanceId: string, oldSessionId: string, ended: EndReply): Record<string, unknown> | null {
	if (ended.engineStopped !== false) return null;
	return {
		outcome: "unknown",
		error: `The old session ${oldSessionId} is closed, but its engine did not confirm it stopped, so no new conversation was started.${ended.warning ? ` ${ended.warning}` : ""}`,
		oldSessionId,
		engineStopped: false,
		poll: { tool: "coding_sessions_list", input: { instance_id: instanceId } },
	};
}

/** The failure to report when the open REUSED a session (an older API, or one that outlived the end), or null for a real fresh start. */
export function reusedSessionReply(reply: { reused?: boolean; session?: { id?: string } }): Record<string, unknown> | null {
	if (reply.reused !== true) return null;
	const id = reply.session?.id ?? "(unknown)";
	return {
		error: `coding_session_fresh did NOT start a fresh conversation: the server reused session ${id}, which still holds the old conversation. Nothing was cleared. End it with coding_session_end (confirm engineStopped: true), then call coding_session_fresh again.`,
		reused: true,
		session: reply.session,
	};
}
