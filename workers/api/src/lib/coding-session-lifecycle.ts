// Who owns a coding session, and what to say when there isn't one (#271).
//
// PURE — no D1, no Env, no runner. The two decisions the Pilot and the coding driver make about
// session lifetime live here so they can be tested as rules rather than as workflow side effects.
//
// The bug this closes: delegation was SINGLE-USE. `loop-drivers.ts` required a live session, and
// the Pilot ended the session when its run completed — so every delegated job consumed the session
// it needed and the next one 409'd. Verified three times in one afternoon with the runner online
// throughout. It also meant a supervisor could never supervise without a human first sitting in
// the console opening a session by hand, which is the opposite of what delegation is for.
//
// Two changes, and this module holds the reasoning for both:
//
//   1. OWNERSHIP. A run ends only the session it opened. Ending a session someone else opened is
//      the surprising half — a human who opens a session by hand, presses Run and watches the
//      session disappear has had their thing taken away by a background job. Nothing else in the
//      product closes a resource the user created, and the Pilot had no reason to be the first.
//
//   2. ON-DEMAND OPEN. With ownership alone, delegation would still dead-end on an agent nobody
//      had opened a session for. So the driver opens one itself when a runner is connected — and
//      that session is the run's, by rule (1), so it is cleaned up when the run finishes and the
//      repo is left exactly as it was found.
//
// The refusal message is here too, because getting it wrong cost a real user hours: the old text
// appended "(and run `pags up`)" UNCONDITIONALLY, so a perfectly-behaved agent relayed
// "start your runner" to someone whose runner was connected, heartbeating and serving other work.
// A diagnosis is only useful if it can say "the runner is fine" — see `subordinate-connectivity.ts`.
import type { SubordinateConnectivity } from "./subordinate-connectivity.js";

/**
 * May this run close the session it was driving?
 *
 * The outcome is deliberately NOT an input. A session the run opened is the run's to clean up
 * however it ended — including failure, where leaving it active would strand a claimed, idle
 * engine. A session a human opened is never the run's to close, and a failed run is the worst
 * possible moment to take it away: that is exactly when they want to look at the terminal.
 */
export function shouldEndSessionAfterRun(input: { openedByRun: boolean }): boolean {
	return input.openedByRun === true;
}

/**
 * Why work cannot start on a repo, in words that name the ACTUAL blocker.
 *
 * `connectivity` is the same classification `subordinate_status` shows the supervisor, so the
 * refusal a Lead relays and the status it reads cannot contradict each other — which is how the
 * two halves of this bug compounded in the first place.
 */
export function noSessionMessage(input: {
	repoName: string;
	connectivity: SubordinateConnectivity;
	/** Set when the runner IS connected but `/coding/start` failed (clone error, bad engine command). */
	startError?: string | null;
}): string {
	const { repoName, connectivity } = input;
	if (!connectivity.canWork) {
		// Runner genuinely unreachable — this is the ONE branch allowed to prescribe `pags up`,
		// and it names the machine so the user knows which laptop to go to.
		const remedy = connectivity.remedy ? ` Run \`${connectivity.remedy}\`${connectivity.node ? ` on ${connectivity.node}` : ""}.` : "";
		return `Cannot start work on ${repoName}: ${connectivity.message}${remedy}`;
	}
	// Runner is fine. Say so explicitly — a supervisor that has just been told "no session" will
	// otherwise reach for the runner as the explanation, which is the whole failure mode.
	const detail = input.startError ? ` The runner refused to start it: ${input.startError}` : "";
	return `Could not open a coding session for ${repoName}. The runner is connected${connectivity.node ? ` on ${connectivity.node}` : ""}, so this is not a \`pags up\` problem.${detail}`;
}
