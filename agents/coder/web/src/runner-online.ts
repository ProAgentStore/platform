/**
 * Is the user's machine connected? (#241)
 *
 * The Coding tab used to learn this ONLY as a side effect of polling a live session's `/capture`:
 * both writers of the flag required a session to already exist. So once the runner dropped mid-
 * session and the session ended, `false` was frozen — nothing could ever set it back, because
 * that needed a session, and the control that starts one had been REPLACED by the offline notice.
 * The tab told you to run `pags up` while you were running it, with no way forward.
 *
 * Two signals, one answer:
 *
 * - `relay` — `GET /v1/instances/:id/runtime/status` → `relay.connected`. Authoritative, and what
 *   the header dot and Settings already read. Polled on a timer that does NOT depend on a session
 *   existing, so it is the only thing that can CLEAR a stale offline state.
 * - `capture` — `runnerConnected` from a session capture. Faster and session-specific (it knows
 *   the command actually failed to reach the machine), but it is only meaningful while the
 *   session that produced it is alive.
 *
 * The rule: a capture's verdict may never outlive its sessions. Once the active set empties, the
 * relay answer is the whole truth — which is what makes the offline state recoverable without a
 * remount.
 */
export interface RunnerSignals {
	/** Last `relay.connected` from /runtime/status; null before the first answer. */
	relay: boolean | null;
	/** Last `runnerConnected` seen on a session capture; null if none seen. */
	capture: boolean | null;
	/** Does the instance currently have at least one active session? */
	hasActiveSessions: boolean;
}

export function resolveRunnerOnline({ relay, capture, hasActiveSessions }: RunnerSignals): boolean | null {
	// A live session that cannot reach the machine is offline even if the relay socket looks up —
	// the user's next action would fail, and saying "online" there is the disagreement that made
	// the header dot and the tab body contradict each other in the other direction.
	if (hasActiveSessions && capture === false) return false;
	if (relay !== null) return relay;
	// Before the first status answer, a capture is better than nothing; with neither, "unknown"
	// (null) — which renders as neither online nor a warning.
	return hasActiveSessions ? capture : null;
}

/** The `/runtime/status` fields a presence reader uses. */
export interface RuntimeStatusAnswer {
	relay?: { connected?: boolean; runnerNode?: string | null } | null;
	/** The probe threw, but the runner was seen recently — "nothing changed", not "offline" (#933). */
	transient?: boolean;
}

/**
 * Is this answer a probe BLIP rather than a reading? (#933)
 *
 * When the relay probe throws and the runner was seen within the recent window, the route answers
 * `{runtime: {status: "online"}, transient: true}` with NO `relay` (workers/api/src/routes/
 * instances.ts) — deliberately: it has no fresh socket reading, and inventing `relay.connected` there
 * would assert something nobody observed. Every reader treated the missing `relay` as "offline", so
 * one slow probe on a loaded machine (#913, #924) flipped the header dot for a poll cycle while the
 * runner worked — the contradictory signal #922 removed from the MCP tools.
 */
export function isTransientStatus(d: RuntimeStatusAnswer | null | undefined): boolean {
	return d?.transient === true && !d.relay;
}

/**
 * The relay verdict after an answer: the answer's own when it carries one, else the previous one —
 * which is `null` ("not known yet") before the first real reading, never a fabricated `false`.
 */
export function relayVerdict(prev: boolean | null, d: RuntimeStatusAnswer): boolean | null {
	return isTransientStatus(d) ? prev : d.relay?.connected === true;
}
