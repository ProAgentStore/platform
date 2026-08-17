// Does a newly-opened coding session CONTINUE the repo's last conversation, or start clean (#408)?
//
// PURE — no D1, no Env, no runner. The rule is here rather than inline at the two open paths
// because "how much history does the engine start with" is a policy decision with a cost on both
// sides, and a scattered conditional is how a policy quietly becomes an accident.
//
// ── What was actually true before this existed
//
// #408 asserts that reaping a session "loses a process, not a memory", because Claude Code persists
// its conversation to `~/.claude` and the runner re-spawns with `--resume`. Half right, and the
// wrong half inverts the decision. The runner's resume store is keyed by OUR `coding_sessions.id`
// (`readState(config.statePath, config.id)` in `coding/headless.ts`), and `--resume` is appended
// only when that lookup returns something. A reap ENDS the row; the next open `createSession`s a
// new one; `readState(statePath, <new id>)` is null; no `--resume`. So the pre-#408 behaviour was:
//
//   • runner restart, SAME session row  → resumes (this is what headless.ts's header describes)
//   • reap, then re-open                → always fresh, silently
//
// `coding-session-sweeper.ts` says so in its own words — "reaping early costs a live CLI context
// that cannot be recovered, because the next session gets a new id and starts cold."
//
// That means the cost #408 worries about (an engine conversation growing for weeks, re-sent every
// turn) did not exist on the auto-open path. The live defect was the opposite one #408's last
// paragraph predicts: the agent "forgot everything" after a reap and nothing said so. So this
// module is not a restriction on an over-generous default — it ADDS resume as a capability, and
// states its boundary in the same breath.
//
// ── The boundary
//
// Two clocks, measuring different things, and it matters that they are not the same number:
//
//   • {@link IDLE_SESSION_MS} (6h) asks "is anyone looking right now?" It is set BELOW one night on
//     purpose, so a session abandoned at the end of the day does not hold a child process on
//     somebody's laptop until morning. Its cost is a resident process.
//   • {@link RESUME_WINDOW_MS} asks "is this still the same piece of work?" Its cost is tokens:
//     every turn re-sends the whole conversation, forever, so a stale resume is paid repeatedly and
//     invisibly. Its benefit is not having to re-explain the task.
//
// FOUR DAYS. The longest legitimate gap inside one piece of work is a long weekend — stop Friday
// evening, pick it up Tuesday morning after a public holiday, ≈3.6 days — and four days clears that
// with margin. It is comfortably short of "I came back to this after a week", by which time the
// branch has moved, the issue has been discussed elsewhere, and the old transcript is a liability
// rather than context. The reap bounds the blast radius either way: at most one stale conversation
// exists per repo, because there is at most one active session per repo.

/** How long a repo's previous engine conversation stays worth continuing. See the header. */
export const RESUME_WINDOW_MS = 4 * 24 * 60 * 60_000;

export type ContinuityMode = "resume" | "fresh";

export interface SessionContinuity {
	mode: ContinuityMode;
	/**
	 * The PREVIOUS `coding_sessions.id` whose engine conversation to continue — the runner's resume
	 * store is keyed by it. Null on `fresh`, so a caller cannot accidentally ask for a resume it
	 * decided against.
	 */
	resumeFrom: string | null;
	/**
	 * Why, phrased so a reply can use it verbatim after "started a fresh conversation — ".
	 * Empty-ish reasons are not allowed: an unexplained fresh start is the bug report #408 predicts.
	 *
	 * It is READ BY THE USER — the console renders it on open (#697) and MCP returns it (#696) — so
	 * it says "conversation", never "session" (#695). The two words describe the same row, but only
	 * one of them is a concept the user has to be taught, and #257/#408 exist to make sure they
	 * never are.
	 */
	reason: string;
}

/** The repo's most recently-active FINISHED session, as far as this decision is concerned. */
export interface PreviousSessionFacts {
	id: string;
	/** The engine it ran. Only Claude has a resume protocol; a raw CLI has no conversation to keep. */
	clientType: string;
	/** `ended` (incl. reaped) or `error`. */
	status: string;
	/** The same `last_activity_at` column the idle reaper measures — ms, or null on a legacy row. */
	lastActivityAt: number | null;
}

/** Round an age to the coarsest unit that still reads as a fact ("3 days", "5 hours"). */
function describeAge(ms: number): string {
	const hours = Math.max(1, Math.round(ms / 3_600_000));
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Resume or start clean, and say which.
 *
 * Order matters: every branch above the age check is a case where resuming is not merely stale but
 * IMPOSSIBLE, and reporting "the previous conversation was 2 hours old" for one of them would be a
 * true sentence attached to a false implication.
 */
export function resolveSessionContinuity(input: {
	/** The engine this open is about to launch. */
	engine: string;
	previous: PreviousSessionFacts | null;
	/**
	 * The caller asked for a clean slate explicitly — the console's **Fresh** button and the MCP
	 * `coding_session_fresh` tool, both of which END the current session and immediately open
	 * another.
	 *
	 * FIRST branch, and it has to be, because without it this policy silently DELETES that feature:
	 * the session those two just ended was active seconds ago, so it is the most resumable thing on
	 * the repo, and "start clean, my CLI state is corrupted" would have handed the corrupted
	 * conversation straight back. #408 names `coding_session_fresh` as evidence that the
	 * resume/fresh distinction is already understood — that tool is the reason the distinction has
	 * to stay expressible after it becomes policy.
	 */
	forceFresh?: boolean;
	now?: number;
}): SessionContinuity {
	const fresh = (reason: string): SessionContinuity => ({ mode: "fresh", resumeFrom: null, reason });
	const { engine, previous } = input;
	const now = input.now ?? Date.now();

	if (input.forceFresh) return fresh("you asked for a clean slate");
	// Claude Code is the only engine driven through a protocol that has a conversation to resume;
	// every other preset is spawned raw and its "history" is whatever scrolled past on stdout.
	if (engine !== "claude") return fresh(`the ${engine || "configured"} engine has no conversation to continue`);
	if (!previous) return fresh("there was no earlier conversation on this repo to continue");
	// Switching engine is switching brains. The stored resume key belongs to the other one.
	if (previous.clientType !== engine) return fresh("the previous conversation on this repo ran a different engine");
	// `error` is the status `ensureActiveSession` writes when the engine never launched — there is
	// no conversation behind that row, only a failed spawn.
	if (previous.status === "error") return fresh("the previous attempt on this repo never got its engine running");
	// A legacy row predating `last_activity_at`. Unknown age is not "recent"; the whole point of the
	// window is that it is measured.
	if (previous.lastActivityAt == null) return fresh("the previous conversation did not record when it was last used");

	// Clock skew between the writer and this reader can make the age negative. Treat that as "just
	// now" rather than as an enormous age — the alternative is a spurious fresh start.
	const age = Math.max(0, now - previous.lastActivityAt);
	if (age > RESUME_WINDOW_MS) return fresh(`the previous conversation on this repo was last touched ${describeAge(age)} ago`);

	return {
		mode: "resume",
		resumeFrom: previous.id,
		reason: `the previous conversation on this repo was last touched ${describeAge(age)} ago`,
	};
}
