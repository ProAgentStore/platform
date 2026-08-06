import { describe, expect, it } from "vitest";
import { classifyCommand, classifySegment, commandFromToolInput, redactCommand, splitSegments } from "./engine-acts.js";

describe("classifySegment — the acts a supervisor must not miss", () => {
	it("names a PR merge, which is the act that opened #294", () => {
		// Run 73ffc073 merged its own PRs to `main` and the supervisor view said "done". If this
		// rule regresses, that run becomes invisible again — the whole issue.
		expect(classifySegment("gh pr merge 42 --squash --delete-branch")).toMatchObject({
			kind: "pr.merge",
			target: "#42",
			irreversible: true,
		});
	});

	it("finds the PR number when it comes AFTER the flags", () => {
		// `gh pr merge --squash 42` is equally valid on the command line. Matching only the
		// number-first shape would record the merge with no subject, so a supervisor would be told
		// something was merged but not what.
		expect(classifySegment("gh pr merge --squash 42")?.target).toBe("#42");
	});

	it("takes the PR number out of a full URL", () => {
		expect(classifySegment("gh pr merge https://github.com/o/r/pull/7 --admin")?.target).toBe("#7");
	});

	it("records an OPENED pull request as reversible, a MERGED one as not", () => {
		// The distinction drives how loudly each is surfaced. Flattening them would either bury the
		// merge among routine PR opens or scream about every draft PR until the signal is ignored.
		expect(classifySegment("gh pr create --fill")).toMatchObject({ kind: "pr.open", irreversible: false });
		expect(classifySegment("gh pr merge --auto")).toMatchObject({ kind: "pr.merge", irreversible: true });
	});

	it("reports a force-push as a force-push, not as an ordinary push", () => {
		// Rules are ordered by consequence. If `git push` matched first, rewriting published history
		// would be filed under the same heading as pushing a feature branch.
		for (const cmd of ["git push --force origin main", "git push -f origin fix", "git push --force-with-lease"]) {
			expect(classifySegment(cmd)).toMatchObject({ kind: "push.force", irreversible: true });
		}
	});

	it("separates a push to the trunk from a push to a feature branch", () => {
		expect(classifySegment("git push origin main")).toMatchObject({ kind: "push.trunk", irreversible: true });
		expect(classifySegment("git push -u origin fix/94-thing")).toMatchObject({ kind: "push", irreversible: false });
	});

	it("does not read `main` inside a branch NAME as a push to the trunk", () => {
		// `\bmain\b` matches inside `feature/main-fix`, which would flag an ordinary feature push as
		// an irreversible trunk push — a false alarm that teaches a supervisor to ignore the field.
		expect(classifySegment("git push origin feature/main-fix")).toMatchObject({ kind: "push", irreversible: false });
	});

	it("catches both spellings of deleting a remote branch", () => {
		expect(classifySegment("git push origin --delete stale")).toMatchObject({ kind: "branch.delete" });
		expect(classifySegment("git push origin :stale")).toMatchObject({ kind: "branch.delete" });
	});

	it("catches the destructive local git commands", () => {
		expect(classifySegment("git branch -D wip")).toMatchObject({ kind: "branch.delete" });
		expect(classifySegment("git branch --delete wip")).toMatchObject({ kind: "branch.delete" });
		expect(classifySegment("git reset --hard HEAD~3")).toMatchObject({ kind: "reset.hard" });
		expect(classifySegment("git clean -fd")).toMatchObject({ kind: "clean" });
	});

	it("records publishes and deploys — consequences that leave the machine", () => {
		expect(classifySegment("npm publish --access public")).toMatchObject({ kind: "package.publish" });
		expect(classifySegment("pnpm publish")).toMatchObject({ kind: "package.publish" });
		expect(classifySegment("npx wrangler deploy")).toMatchObject({ kind: "deploy" });
		expect(classifySegment("wrangler pages deploy dist")).toMatchObject({ kind: "deploy" });
		expect(classifySegment("gh release create v1.2.0")).toMatchObject({ kind: "release.publish" });
	});

	it("records a recursive/forced rm but NOT ordinary single-file housekeeping", () => {
		// The record is only useful while it stays dense. Logging every `rm scratch.txt` an engine
		// runs would bury the merges under noise and the field would stop being read.
		expect(classifySegment("rm -rf node_modules")).toMatchObject({ kind: "file.delete", irreversible: true });
		expect(classifySegment("rm scratch.txt")).toBeNull();
	});

	it("classifies ordinary work as nothing at all", () => {
		for (const cmd of ["git status", "pnpm test", "git commit -m 'wip'", "ls -la", "git diff --stat"]) {
			expect(classifySegment(cmd)).toBeNull();
		}
	});
});

describe("splitSegments — a real engine writes compound command lines", () => {
	it("splits on every operator that starts a new command", () => {
		expect(splitSegments("cd repo && git push -u origin fix; gh pr create --fill | cat")).toEqual([
			"cd repo",
			"git push -u origin fix",
			"gh pr create --fill",
			"cat",
		]);
	});
});

describe("classifyCommand — one line, every act on it", () => {
	it("records BOTH acts on a chained push-and-merge, with distinct ids", () => {
		// The live shape of the failure: an engine does the whole thing on one line. Classifying only
		// the first (or the last) segment would record the push and lose the merge.
		const acts = classifyCommand("tu_1", "git push -u origin fix && gh pr create --fill && gh pr merge 9 --squash");
		expect(acts.map((a) => a.kind)).toEqual(["push", "pr.open", "pr.merge"]);
		expect(new Set(acts.map((a) => a.id)).size).toBe(3); // a shared id would be silently deduped away
	});

	it("carries the WHOLE command as evidence on every act, not just the matching segment", () => {
		// A supervisor reading "force-pushed" needs to see what else was on that line.
		const acts = classifyCommand("tu_2", "cd /repo && git push --force origin main");
		expect(acts).toHaveLength(1);
		expect(acts[0].command).toBe("cd /repo && git push --force origin main");
	});

	it("starts every act with an UNKNOWN outcome", () => {
		// The outcome is only known once the tool_result arrives. Defaulting to success would put a
		// merge in the audit trail that a branch-protection rule actually refused.
		expect(classifyCommand("tu_3", "gh pr merge 1")[0].ok).toBeNull();
	});

	it("returns nothing for a command that does nothing consequential", () => {
		expect(classifyCommand("tu_4", "pnpm typecheck && pnpm test")).toEqual([]);
	});
});

describe("redactCommand — this record travels into D1 and a model prompt", () => {
	it("removes a token assigned inline before a push", () => {
		expect(redactCommand("GH_TOKEN=ghp_abcdefghijklmnopqrstuvwx git push origin main")).toBe(
			"GH_TOKEN=*** git push origin main",
		);
	});

	it("removes credentials embedded in a clone/push URL", () => {
		expect(redactCommand("git push https://x-access-token:ghs_secretsecret1234@github.com/o/r main")).toContain(
			"https://***@github.com/o/r main",
		);
	});

	it("removes a bare token that is not assigned to anything", () => {
		// The engine sometimes passes one as a flag value (`gh auth login --with-token ghp_…`), where
		// the KEY=VALUE rule does not apply.
		expect(redactCommand("gh auth login --with-token ghp_abcdefghijklmnopqrst")).toBe("gh auth login --with-token ghp_***");
		expect(redactCommand("curl -H 'x: sk-abcdefghijklmnopqrstuv' https://api")).toContain("sk-***");
	});

	it("caps the stored command so a heredoc cannot turn one act into a log dump", () => {
		expect(redactCommand(`git commit -m "${"x".repeat(2000)}"`).length).toBeLessThanOrEqual(400);
	});
});

describe("commandFromToolInput — keyed on the input SHAPE, not the tool's name", () => {
	it("reads the command from any tool that takes one", () => {
		// Claude Code calls it `Bash`, but a session launched with a custom tool set can present the
		// same shell capability under a different name. Matching the name would record nothing there.
		expect(commandFromToolInput({ command: "gh pr merge 3" })).toBe("gh pr merge 3");
	});

	it("ignores a tool that takes no command", () => {
		expect(commandFromToolInput({ file_path: "/a/b.ts", content: "x" })).toBeNull();
		expect(commandFromToolInput(null)).toBeNull();
		expect(commandFromToolInput({ command: "   " })).toBeNull();
	});
});
