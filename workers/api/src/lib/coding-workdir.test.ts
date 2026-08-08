/**
 * The mapping from "what the machine saw" to "what the owner is told" (#405).
 *
 * Pure, so the two failure modes that matter can both be pinned without a runner:
 *
 *   - a real defect must NOT be reported as unverified (that is the bug — an unusable path
 *     wearing the word `ready`);
 *   - an unreachable or OLD machine must NOT be reported as a defect (that would condemn every
 *     healthy repo on it the first time the API shipped ahead of the CLI).
 */
import { describe, expect, it } from "vitest";
import { cloneStatusForVerdict, isWorkdirBroken, verdictFromCheck } from "./coding-workdir.js";

const ok = { checked: true, path: "/home/u/dev/thing", exists: true, isDirectory: true, entryCount: 42, insideWorkTree: true, gitChecked: true };

describe("verdictFromCheck — a definite verdict", () => {
	it("passes a real checkout", () => {
		const v = verdictFromCheck("~/dev/thing", ok);
		expect(v.state).toBe("ok");
		expect(v.detail).toBe("");
		expect(isWorkdirBroken(v)).toBe(false);
		expect(cloneStatusForVerdict(v)).toBe("ready");
	});

	// This is the measured case in #405: the directory existed, held nothing, and was `ready`.
	it("names the path and the condition for an EMPTY directory", () => {
		const v = verdictFromCheck("~/dev/pas/platform/apps/chess-academy", { ...ok, entryCount: 0 });
		expect(v.state).toBe("empty");
		expect(v.detail).toContain("/home/u/dev/thing");
		expect(v.detail).toMatch(/empty/i);
		expect(isWorkdirBroken(v)).toBe(true);
		expect(cloneStatusForVerdict(v)).toBe("needs_attention");
	});

	it("distinguishes a path that is GONE from one that is merely empty", () => {
		const v = verdictFromCheck("~/dev/moved", { checked: true, path: "/home/u/dev/moved", exists: false });
		expect(v.state).toBe("missing");
		expect(v.detail).toContain("/home/u/dev/moved");
		expect(v.detail).toMatch(/moved, renamed or deleted/);
	});

	it("reports a file as a file, not as an empty folder", () => {
		expect(verdictFromCheck("~/notes.md", { checked: true, path: "/home/u/notes.md", exists: true, isDirectory: false }).state).toBe("not_a_directory");
	});

	it("reports a folder full of files that is not a checkout", () => {
		const v = verdictFromCheck("~/dev/scratch", { ...ok, insideWorkTree: false });
		expect(v.state).toBe("not_a_git_repo");
		expect(v.detail).toMatch(/not inside a git working tree/);
	});

	// A subdirectory of a monorepo checkout has no `.git` of its own. The runner answers with
	// `git rev-parse`, not an existence test, and this pins that the mapping trusts it.
	it("passes a subdirectory of a work tree (no `.git` of its own)", () => {
		expect(verdictFromCheck("~/dev/monorepo/apps/thing", { ...ok, path: "/home/u/dev/monorepo/apps/thing" }).state).toBe("ok");
	});

	// A machine without git answers "not a work tree" for every path on it. Condemning repos on
	// that would be a lie about the checkout told because of a missing binary.
	it("does not call a folder 'not a git repo' when git could not run at all", () => {
		expect(verdictFromCheck("~/dev/thing", { ...ok, insideWorkTree: false, gitChecked: false }).state).toBe("ok");
	});
});

describe("verdictFromCheck — no verdict is not a bad verdict", () => {
	// An older CLI 404s /coding/repo-check, and the relay hands the cloud `{error:"Not found"}`.
	it("reads an older runner's 404 as unverified, never as broken", () => {
		const v = verdictFromCheck("~/dev/thing", { error: "Not found" });
		expect(v.state).toBe("unverified");
		expect(isWorkdirBroken(v)).toBe(false);
		// Null: the caller decides. The list leaves the stored status alone; add-repo writes
		// `unknown`, because `ready` may only be said about a path someone looked at.
		expect(cloneStatusForVerdict(v)).toBeNull();
	});

	it("reads a timeout, a garbage body and a null the same way", () => {
		for (const raw of [{ error: "Relay command timed out" }, "nonsense", null, undefined, {}]) {
			expect(verdictFromCheck("~/dev/thing", raw).state).toBe("unverified");
		}
	});

	it("keeps the configured path in the message when the runner never resolved one", () => {
		expect(verdictFromCheck("~/dev/thing", { error: "boom" }).path).toBe("~/dev/thing");
	});
});
