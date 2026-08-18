/**
 * What actually stops this instance's Engine writing to the wrong repository (#679, absorbing #676).
 *
 * ── Why this is a module and not two lines in the route
 *
 * `coding_diagnostics` used to answer with one constant:
 *
 *     enforcement: writeScope.length ? "acts-observed-halt" : "none"
 *
 * with the note *"A write naming a repository outside this list halts the run and is recorded. The
 * first such write still LANDS — the engine uses this machine's own git and gh credentials, which
 * are not scoped."* That sentence was true, and it is the sentence #679 exists to make false.
 *
 * It is now partly false and partly still true, and WHICH depends on facts only the owner's
 * machine has: whether its runner is new enough to carry the `gh` guard, whether `gh` is even
 * installed there, whether the platform named a scope for that session. So the answer is
 * DERIVED from what the machine reported, per session — never from what the cloud sent. A cloud
 * that reported its own intent would tell every owner running a CLI older than the guard that
 * their writes are gated when nothing is gating them, which is a worse failure than the gap.
 *
 * ── The vocabulary, and what each value promises
 *
 *  - `none` — no GitHub coordinates registered, so there is nothing to compare a write against.
 *  - `acts-observed-halt` — the pre-#679 state: a wrong-repo write is DETECTED from the act stream
 *    and halts the run, after it has landed.
 *  - `gh-guard-partial+acts-observed-halt` — some live sessions carry the `gh` refusal, some do not.
 *  - `gh-guard+acts-observed-halt` — every live session carries it.
 *
 * Even the strongest value is not "cannot happen", and the note says so. The guard is a `PATH`
 * shim: an absolute `/opt/homebrew/bin/gh` skips it, `git push` is not gated at all because the
 * remotes are SSH and there is no credential to withhold, and `gh api graphql` is not classified.
 * Those gaps arrive from the runner rather than being restated here, so the two cannot drift.
 */

/** What one live session's machine said about its guard. Shape vendored from the runner (#679). */
export interface TrackedGhGuard {
	installed?: boolean;
	scope?: string[];
	reason?: string;
	gaps?: string[];
}

export type WriteEnforcement = "none" | "acts-observed-halt" | "gh-guard-partial+acts-observed-halt" | "gh-guard+acts-observed-halt";

export interface WriteEnforcementReport {
	enforcement: WriteEnforcement;
	enforcementNote: string;
	/** How many live sessions confirmed a guard, out of how many the runner is tracking. */
	ghGuard: { sessionsGuarded: number; sessionsTracked: number; gaps: string[]; reasons: string[] };
}

/** The reason a session has no guard, in words an owner can act on. */
const REASONS: Record<string, string> = {
	"no-scope": "the platform sent no repository scope for that session (its repo has no GitHub coordinates)",
	"gh-not-found": "`gh` is not installed on that machine, so there was nothing to guard",
	"install-failed": "the runner could not write its guard to ~/.config/proagentstore",
	unreported: "that machine's runner predates the guard — update with `npm i -g @proagentstore/cli`",
};

export function writeEnforcementReport(writeScope: string[], tracked: Array<{ ghGuard?: TrackedGhGuard }>): WriteEnforcementReport {
	const sessionsTracked = tracked.length;
	const guarded = tracked.filter((t) => t.ghGuard?.installed === true);
	// `unreported` is its own reason, not a missing one: a runner published before #679 answers
	// `/coding/diagnostics` without the field at all, and that is the single most likely state on
	// the day this ships.
	const reasons = [...new Set(tracked.filter((t) => t.ghGuard?.installed !== true).map((t) => REASONS[t.ghGuard?.reason ?? "unreported"] ?? "unknown"))];
	const gaps = tracked.find((t) => t.ghGuard?.gaps?.length)?.ghGuard?.gaps ?? [];
	const ghGuard = { sessionsGuarded: guarded.length, sessionsTracked, gaps: [...gaps], reasons };

	if (writeScope.length === 0) {
		return { enforcement: "none", enforcementNote: "No GitHub repository is registered for this instance, so write scope is not checked.", ghGuard };
	}
	if (guarded.length === 0) {
		return {
			enforcement: "acts-observed-halt",
			// The original sentence, unchanged, because on these sessions it is still exactly true.
			enforcementNote:
				"A write naming a repository outside this list halts the run and is recorded. The first such write still LANDS — the engine uses this machine's own git and gh credentials, which are not scoped." +
				(sessionsTracked > 0 ? ` No live session is carrying the gh guard: ${reasons.join("; ")}.` : ""),
			ghGuard,
		};
	}
	const scope = guarded.length === sessionsTracked;
	return {
		enforcement: scope ? "gh-guard+acts-observed-halt" : "gh-guard-partial+acts-observed-halt",
		enforcementNote:
			`A \`gh\` write naming a repository outside its own session's scope is REFUSED before it runs, on ${guarded.length} of ${sessionsTracked} live session(s)` +
			(scope ? "" : ` — the rest are unguarded because ${reasons.join("; ")}`) +
			". A write that gets past that is still detected from the act stream and halts the run, after it has landed. What the guard does not stop: " +
			(gaps.length ? gaps.join(" ") : "(the machine reported no gap list)"),
		ghGuard,
	};
}
