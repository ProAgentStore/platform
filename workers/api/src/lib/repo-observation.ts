/**
 * What a checkout LOOKS LIKE, and the two clauses it is reported in.
 *
 * A leaf on purpose — it imports nothing. Two modules need this vocabulary and they sit on
 * opposite sides of each other: `repo-state.ts` reads the state off a machine (and therefore
 * reaches `coding-store`), and `repo-policies.ts` decides whether a declared invariant holds (and
 * is therefore read BY `coding-store`, which parses the column). Putting the shared shape in
 * either one makes `coding-store → repo-policies → repo-state → coding-store` a static import
 * cycle, which `import-graph.test.ts` refuses.
 *
 * The split also reads correctly: this is what was OBSERVED, `repo-policies.ts` is what is
 * REQUIRED, and keeping the two apart is the reason a policy can be evaluated without a runner in
 * the room.
 */

/** Branches treated as the trunk when a repo has no configured branch of its own. */
const IMPLICIT_TRUNK = ["main", "master"];

export interface RepoWorkingState {
	/** The branch the checkout is on. NULL means unknown — an older runner, or not a git repo. */
	branch: string | null;
	dirty: boolean;
	changedFiles: number;
	/**
	 * The machine ANSWERED that this path is not a git working tree (#548).
	 *
	 * Distinct from every other shape this record takes, and that is the point: `branch: null`
	 * already means "unknown", so before this existed a `git status` that came back
	 * `fatal: not a git repository` was indistinguishable from a runner that did not reply, and
	 * both were reported to the Pilot as nothing at all. One value for two facts, and the more
	 * actionable of the two was the one being thrown away.
	 *
	 * Only ever set from a definite refusal by git itself. Absent means "no such answer was
	 * received" — never "it is a repository".
	 */
	notAGitRepo?: boolean;
}

/** The state a definite "this is not a working tree" answer produces. */
export function notAGitRepoState(): RepoWorkingState {
	return { branch: null, dirty: false, changedFiles: 0, notAGitRepo: true };
}

/**
 * The two clauses a repo's state is reported in, one invariant each.
 *
 * The wording is #276's and is deliberate — fact plus consequence, never a refusal, because both
 * conditions are frequently INTENDED and "clean this up first" is how an agent talks itself into
 * running `git checkout .`. They are separate functions because a standing policy (#322) claims
 * ONE invariant and needs one clause, while `describeRepoState` composes both for the supervisor
 * note. One definition of each: two copies of "it will NOT be discarded" would drift.
 *
 * Null means the clause does not apply — including when the branch is unknown, which is never
 * reported as off-trunk: a runner too old to send the status header says nothing about where the
 * checkout is, and a confident wrong answer is worse than none.
 */
export function offTrunkClause(state: RepoWorkingState, configuredBranch?: string | null): string | null {
	const configured = (configuredBranch || "").trim() || null;
	const offTrunk = state.branch ? (configured ? state.branch !== configured : !IMPLICIT_TRUNK.includes(state.branch)) : false;
	if (!offTrunk) return null;
	return `on branch \`${state.branch}\`${configured ? ` rather than its configured \`${configured}\`` : " rather than the trunk"} — a new goal will run on that branch unless you say otherwise`;
}

/**
 * The clause that outranks the other two (#548).
 *
 * When git has said the path is not a working tree there is no branch to be off and no diff to
 * preserve, so composing this with the others would produce a sentence about a repository that
 * does not exist. It is also the only clause here that IS a problem rather than a condition worth
 * weighing — but it still states fact-and-consequence rather than an instruction, for the same
 * reason the others do: the recipient decides.
 */
export function notAGitRepoClause(state: RepoWorkingState): string | null {
	if (!state.notAGitRepo) return null;
	return "not a git working tree at all — the folder is there but has no `.git`, so every git command in it fails; nothing can be pulled, committed or branched until it is a clone";
}

export function dirtyClause(state: RepoWorkingState): string | null {
	if (!state.dirty) return null;
	return `${state.changedFiles} uncommitted file${state.changedFiles === 1 ? "" : "s"} left in the working tree by earlier work — it will NOT be discarded, and it may be a change somebody still wants`;
}
