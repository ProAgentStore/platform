import { describe, expect, it } from "vitest";
import { describeRepoState, parseGitShortStatus, saysNotAGitRepo } from "./repo-state.js";
import { notAGitRepoState } from "./repo-observation.js";

describe("parseGitShortStatus (#276)", () => {
	it("reads the branch out of the `--branch` header and counts the changed files", () => {
		// The failure this prevents: reporting a dirty tree with no branch. Live, FWS sat on
		// `fix/36-assistant-bubble-order` after a run pushed a PR, and the next goal would have run
		// there silently — "dirty: true" alone would not have caught it.
		const s = parseGitShortStatus("## fix/36-assistant-bubble-order...origin/fix/36 [ahead 1]\n M src/a.ts\n?? new.txt\n");
		expect(s.branch).toBe("fix/36-assistant-bubble-order");
		expect(s.dirty).toBe(true);
		expect(s.changedFiles).toBe(2);
	});

	it("reads a branch with no upstream", () => {
		// `git status -sb` omits the `...upstream` half on a branch that was never pushed. Slicing
		// unconditionally at `...` would return an empty branch and report "unknown".
		expect(parseGitShortStatus("## main\n").branch).toBe("main");
	});

	it("does not mistake the ahead/behind suffix for part of the branch name", () => {
		// `main [ahead 2]` as a branch name would never equal `main`, so every up-to-date repo
		// would be reported as parked on a feature branch.
		expect(parseGitShortStatus("## main...origin/main [ahead 2, behind 1]\n").branch).toBe("main");
	});

	it("names a detached HEAD as detached rather than as a branch called HEAD", () => {
		// A supervisor comparing "HEAD" against "main" would describe a detached checkout as a
		// feature branch and tell the human to merge it.
		expect(parseGitShortStatus("## HEAD (no branch)\n").branch).toBe("HEAD (detached)");
	});

	it("reads the branch of a repo with no commits yet", () => {
		expect(parseGitShortStatus("## No commits yet on main\n").branch).toBe("main");
	});

	it("reports a clean tree as clean, not as unknown", () => {
		const s = parseGitShortStatus("## main...origin/main\n");
		expect(s.dirty).toBe(false);
		expect(s.changedFiles).toBe(0);
		expect(s.branch).toBe("main");
	});

	it("returns branch null when the runner is too old to send the header", () => {
		// A pre-#276 runner runs `git status --short` with no `--branch`. Unknown must stay unknown:
		// guessing `main` would be a fact a supervisor acts on.
		const s = parseGitShortStatus(" M src/a.ts\n");
		expect(s.branch).toBeNull();
		expect(s.dirty).toBe(true);
	});
});

describe("describeRepoState (#276)", () => {
	it("says nothing when the repo is clean and on the trunk", () => {
		// An always-present note stops being read. Null is the healthy case.
		expect(describeRepoState({ branch: "main", dirty: false, changedFiles: 0 })).toBeNull();
		expect(describeRepoState({ branch: "master", dirty: false, changedFiles: 0 })).toBeNull();
	});

	it("flags a feature branch when no branch is configured", () => {
		// Local-path repos carry an empty `branch` column, which is exactly the FWS case in #276 —
		// requiring a configured branch before flagging would have missed the reported bug.
		const note = describeRepoState({ branch: "fix/36", dirty: false, changedFiles: 0 });
		expect(note).toContain("fix/36");
		expect(note).toContain("run on that branch");
	});

	it("compares against the repo's configured branch when it has one", () => {
		expect(describeRepoState({ branch: "main", dirty: false, changedFiles: 0 }, { configuredBranch: "develop" })).toContain("develop");
		expect(describeRepoState({ branch: "develop", dirty: false, changedFiles: 0 }, { configuredBranch: "develop" })).toBeNull();
	});

	it("states that uncommitted work will NOT be discarded", () => {
		// The whole point of the reporting half. Wording that reads as "clean this up first" is how
		// an agent talks itself into `git checkout .` over a fix somebody still wants.
		const note = describeRepoState({ branch: "main", dirty: true, changedFiles: 1 });
		expect(note).toContain("1 uncommitted file");
		expect(note).toContain("NOT be discarded");
	});

	it("reports both facts when the repo is off-trunk AND dirty", () => {
		const note = describeRepoState({ branch: "fix/36", dirty: true, changedFiles: 3 });
		expect(note).toContain("fix/36");
		expect(note).toContain("3 uncommitted files");
	});

	it("says nothing about a branch it does not know", () => {
		// An old runner reports dirty with no branch. Emitting "not on the trunk" from a null
		// branch would invent the exact fact the null exists to withhold.
		const note = describeRepoState({ branch: null, dirty: true, changedFiles: 2 });
		expect(note).toContain("2 uncommitted files");
		expect(note).not.toContain("trunk");
	});
});

describe("`git said no` is a different fact from `the runner said nothing` (#548)", () => {
	it("saysNotAGitRepo matches the runner's own refusal", () => {
		// `runRepoGit` throws `InspectError("not a git repo")` when `.git` is absent, which the
		// relay returns as a 400 and `callRunner` raises as `Runner /coding/git → 400: {...}`.
		expect(saysNotAGitRepo('Runner /coding/git → 400: {"error":"not a git repo"}')).toBe(true);
		expect(saysNotAGitRepo(new Error("not a git repo"))).toBe(true);
	});

	it("saysNotAGitRepo matches git's own wording, for a present-but-broken .git", () => {
		expect(saysNotAGitRepo("fatal: not a git repository (or any of the parent directories): .git")).toBe(true);
	});

	it("saysNotAGitRepo does NOT match a disconnect, which is genuinely unknown", () => {
		// The whole distinction. A machine that could not answer says nothing about the path on it,
		// and reporting "not a repository" from a dropped socket is the #440 mistake in a new place.
		expect(saysNotAGitRepo("No runner connected — the relay has no live socket for this agent.")).toBe(false);
		expect(saysNotAGitRepo("Runner disconnected")).toBe(false);
		expect(saysNotAGitRepo(undefined)).toBe(false);
		expect(saysNotAGitRepo(null)).toBe(false);
	});

	it("describeRepoState carries the verdict into the sentence the Pilot is given", () => {
		// The channel already existed and was already injected (`stateNote`, workflows/
		// coding-session.ts) — `readRepoWorkingState` returning null for BOTH facts is what left it
		// empty. In the reported incident this sentence would have replaced fifteen minutes of
		// "stuck not resolved in time".
		const note = describeRepoState(notAGitRepoState());
		expect(note).toContain("no `.git`");
		expect(note).toMatch(/git working tree/);
	});

	it("the not-a-repo clause REPLACES the other two rather than composing with them", () => {
		// A path with no `.git` has no branch to be off and no diff to protect, so composing would
		// describe a repository that is not there.
		const note = describeRepoState(notAGitRepoState(), { configuredBranch: "main" });
		expect(note).not.toMatch(/uncommitted/);
		expect(note).not.toMatch(/rather than its configured/);
	});
});
