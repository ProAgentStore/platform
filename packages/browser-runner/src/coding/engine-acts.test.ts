import { describe, expect, it } from "vitest";
import {
	classifyCommand,
	classifySegment,
	commandFromToolInput,
	type EngineActRecord,
	fillTargetFromResult,
	redactCommand,
	resultText,
	splitSegments,
	toolCallOk,
	toolResultMark,
} from "./engine-acts.js";

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

describe("fillTargetFromResult — the number is in the command's OWN answer (#417)", () => {
	const at = "2026-08-08T00:00:00.000Z";
	const act = (kind: EngineActRecord["kind"], target: string | null, command = "gh pr create --fill"): EngineActRecord => ({
		id: "tu_1:0",
		kind,
		command,
		target,
		irreversible: kind === "pr.merge",
		ok: null,
		at,
	});

	it("takes the PR number out of the tool_result for `gh pr create --fill`", () => {
		// The whole ticket: the common form of the command names no number, so the Pulls panel (#401)
		// rendered an agent-opened PR unattributed. The URL is in that same tool_use_id's result.
		const [filled] = fillTargetFromResult([act("pr.open", null)], "https://github.com/o/r/pull/123\n");
		expect(filled.target).toBe("#123");
	});

	it("leaves the target NULL when the output names no pull request", () => {
		// Exact-or-absent is preserved, not weakened: nothing here invents a number, it only reads one
		// the command itself printed.
		const [same] = fillTargetFromResult([act("pr.open", null)], "creating pull request for fix into main…\n");
		expect(same.target).toBeNull();
	});

	it("never overwrites a target the COMMAND LINE already stated", () => {
		// `gh pr merge 42` is the exact signal; a URL further down the output (a linked PR, a log line)
		// must not be able to displace it.
		const [same] = fillTargetFromResult(
			[act("pr.merge", "#42", "gh pr merge 42 --squash")],
			"merging…\nsee also https://github.com/o/r/pull/999\n",
		);
		expect(same.target).toBe("#42");
	});

	it("attributes the 'already exists' failure to the PR it names — a decision, not an oversight", () => {
		// `gh pr create` on a branch that already has a PR fails with that PR's URL. Attributing to it
		// is a JUDGEMENT and it was taken deliberately: it IS the pull request for this branch and the
		// agent did just act on it, and dropping a real signal to avoid a case where the answer is
		// still true costs more than it saves. The act keeps `ok: false`, so the record stays honest
		// that the command failed — the badge says who acted, not that the command succeeded.
		const [filled] = fillTargetFromResult(
			[{ ...act("pr.open", null), ok: false }],
			"a pull request for branch fix/417 into branch main already exists:\nhttps://github.com/o/r/pull/77",
		);
		expect(filled).toMatchObject({ kind: "pr.open", target: "#77", ok: false });
	});

	it("touches NO other act kind, however loudly the output mentions a PR", () => {
		// The scan is restricted to acts already classified `pr.open`/`pr.merge`. A push whose output
		// helpfully prints "create a pull request: …/pull/5" must record the push, not the PR — a
		// confident wrong number is the one failure this module exists to avoid.
		const acts = [act("push", null, "git push -u origin fix"), act("deploy", null, "wrangler deploy")];
		const out = fillTargetFromResult(acts, "remote: Create a pull request: https://github.com/o/r/pull/5");
		expect(out.map((a) => a.target)).toEqual([null, null]);
		expect(out).toEqual(acts); // untouched, not merely equal-looking
	});

	it("fills every unnumbered PR act on the same compound command, and only those", () => {
		const acts = classifyCommand("tu_9", "git push -u origin fix && gh pr create --fill");
		const out = fillTargetFromResult(acts, "branch fix set up\nhttps://github.com/o/r/pull/8");
		expect(out.map((a) => [a.kind, a.target])).toEqual([
			["push", "origin fix"],
			["pr.open", "#8"],
		]);
	});

	it("takes the FIRST pull URL when the output names several", () => {
		const [filled] = fillTargetFromResult(
			[act("pr.open", null)],
			"https://github.com/o/r/pull/11\nrelated: https://github.com/o/r/pull/12",
		);
		expect(filled.target).toBe("#11");
	});
});

describe("resultText — the RAW result, because the display line is truncated", () => {
	it("reads a URL that sits past the 240 characters the transcript keeps", () => {
		// `toolResult()` caps the display line at 240 chars for the pane. Scanning that instead would
		// lose the URL on any verbose result, which is most real `git push && gh pr create` lines.
		const noisy = `${"warning: something\n".repeat(40)}https://github.com/o/r/pull/321`;
		expect(noisy.length).toBeGreaterThan(240);
		expect(fillTargetFromResult([{ id: "a", kind: "pr.open", command: "gh pr create --fill", target: null, irreversible: false, ok: null, at: "t" }], noisy)[0].target).toBe("#321");
	});

	it("flattens the array-of-blocks shape stream-json also uses", () => {
		expect(resultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
		expect(resultText("plain")).toBe("plain");
		expect(resultText(undefined)).toBe("");
		expect(resultText([{ type: "image" }])).toBe("");
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

describe("toolCallOk / toolResultMark — the outcome the transcript used to drop (#597)", () => {
	it("reads the protocol's own flag: absent is success, true is failure", () => {
		// `is_error` is the only outcome a `tool_result` states, and the protocol omits it on
		// success. This is the same reading `settleAct` publishes as a consequential act's `ok`, and
		// it is one function now precisely so the two cannot drift apart.
		expect(toolCallOk({})).toBe(true);
		expect(toolCallOk({ is_error: false })).toBe(true);
		expect(toolCallOk({ is_error: true })).toBe(false);
		// Not truthiness: a non-boolean is not a failure claim.
		expect(toolCallOk({ is_error: "yes" })).toBe(true);
	});

	it("marks the line so the cloud can tell a failed call from an unobserved one", () => {
		// The marker goes against the arrow (`↳✓`), never after the space, because a runner
		// predating it always wrote a space there — that offset is what lets an old row read as
		// unknown instead of as a pass, whatever its output text begins with.
		expect(toolResultMark({ is_error: true })).toBe("✗");
		expect(toolResultMark({})).toBe("✓");
	});
});
