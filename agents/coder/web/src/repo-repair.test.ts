/**
 * When the console offers to repair a checkout, and what it says (#67).
 *
 * The ticket is a duplicate-cleanup epic, and three separate audits on it cancelled duplicate
 * instances only for a new one to appear within hours. The mechanism behind one of them is fully
 * evidenced: a Repo Coder was created against a path with one extra segment, and 3m40s later a
 * SECOND instance was subscribed against the same repository instead of the path being corrected.
 * So the assertions below are mostly about the two things that make a re-subscribe feel like the
 * fix — a verdict with no remedy attached, and a remedy whose cost nobody stated.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_REPAIR_ACTION, REPO_REPAIR_FALLBACK, repoRepairNotice } from "./repo-repair.js";

const BROKEN = {
	cloneStatus: "needs_attention",
	workdir: "/Users/x/dev/stores/pas/platform/apps/chess-academy",
	cloneError:
		"The configured checkout `/Users/x/dev/stores/pas/platform/apps/chess-academy` does not exist on the connected machine — it may have been moved, renamed or deleted.",
};

describe("when a repair is offered at all", () => {
	it("fires on the one status that is a VERDICT", () => {
		const n = repoRepairNotice(BROKEN);
		expect(n).not.toBeNull();
		expect(n?.action).toBe(REPO_REPAIR_ACTION);
	});

	it("stays silent for every status that is a STAGE, not a verdict", () => {
		// `cloning` and `unknown` mean "nobody has looked yet". Offering to repair a path the
		// platform has not examined would be the console crying wolf on its own slowness, and a
		// banner that cries wolf is one an owner learns to scroll past — including the time it is
		// right. `error` is a failed CLONE, whose remedy is not this field.
		for (const cloneStatus of ["ready", "cloning", "unknown", "missing_url", "error", "", undefined]) {
			expect(repoRepairNotice({ ...BROKEN, cloneStatus }), String(cloneStatus)).toBeNull();
		}
	});

	it("stays silent for a repo it was handed nothing about", () => {
		expect(repoRepairNotice(null)).toBeNull();
		expect(repoRepairNotice(undefined)).toBeNull();
		expect(repoRepairNotice({})).toBeNull();
	});
});

describe("what it says", () => {
	it("quotes the SERVER's sentence — the one that names the path and the condition", () => {
		// The same sentence the agent is handed to relay, so the console and the chat cannot
		// describe one directory two ways.
		expect(repoRepairNotice(BROKEN)?.sentence).toBe(BROKEN.cloneError);
	});

	it("falls back to a vaguer sentence than any real verdict, rather than guessing a cause", () => {
		for (const cloneError of ["", "   ", undefined]) {
			expect(repoRepairNotice({ ...BROKEN, cloneError })?.sentence).toBe(REPO_REPAIR_FALLBACK);
		}
		// Deliberately does not name a cause. A client with a status and no reason knows the path
		// failed and nothing about why, and inventing "it was moved" would be the platform
		// speculating in its own voice.
		expect(REPO_REPAIR_FALLBACK).not.toMatch(/moved|renamed|deleted|does not exist/i);
	});

	it("states what repairing keeps AND what starting over costs", () => {
		// The whole point. The owner in the incident did not weigh an edit against a new instance —
		// the screen offered only the second. `coding_sessions` and `coding_timeline` hang off the
		// repo row, so this is a fact about the schema, not encouragement.
		const detail = repoRepairNotice(BROKEN)?.detail ?? "";
		expect(detail).toMatch(/sessions and history/i);
		expect(detail).toMatch(/again/i);
	});
});

describe("the action is only offered where it can work", () => {
	it("offers the folder edit when there is a folder to edit", () => {
		expect(repoRepairNotice(BROKEN)?.action).toBe(REPO_REPAIR_ACTION);
	});

	it("offers no action for a row with no folder, but still reports the verdict", () => {
		// Should be unreachable — `needs_attention` is documented as a verdict about a LOCAL path
		// (coding-types.ts) — but this runs on JSON from a server the console does not ship with,
		// and "Fix the folder" on a repo that has none is a button that cannot do anything.
		for (const workdir of ["", "   ", undefined]) {
			const n = repoRepairNotice({ ...BROKEN, workdir });
			expect(n?.action, String(workdir)).toBeNull();
			expect(n?.sentence).toBe(BROKEN.cloneError);
		}
	});
});

/**
 * The wiring, asserted on the source for the same reason ./repos-list.test.ts is: these are
 * conditional JSX and a prop thread, and what matters is that the control EXISTS end to end.
 */
describe("both repo surfaces report it, through one component", () => {
	const read = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");

	it("the shared notice opens the sheet rather than naming it", () => {
		// The prose it replaces — "Point it at the real checkout (⚙ Repo settings)" — is a sign
		// pointing at a button, the shape #411 removed from the empty state one file over.
		const notice = read("RepoUnusableNotice.tsx");
		expect(notice).toContain("repoRepairNotice(repo)");
		expect(notice).toContain("onClick={onFix}");
		expect(notice).toContain("{notice.action}");
	});

	it("the MULTI-repo list renders it, and no longer hand-rolls the banner", () => {
		const list = read("ReposList.tsx");
		expect(list).toContain("<RepoUnusableNotice repo={r}");
		expect(list).toContain("setSettingsRepoId(r.id)");
		// The old inline copy is gone — two banners for one fact is how they drift.
		expect(list).not.toContain("Point it at the real checkout");
	});

	it("the SINGLE-repo surface renders it too — it reported nothing at all before", () => {
		// The surface `coder-repo` actually uses, and the one the incident happened on. An unusable
		// checkout showed here as the two truncated words "Path unusable" in a header caption,
		// beside an Open button that would fail.
		const tab = read("CodingTab.tsx");
		const solo = tab.slice(tab.indexOf("if (singleRepo && repos.length <= 1)"), tab.indexOf("// ── Session open"));
		expect(solo).toContain("<RepoUnusableNotice repo={solo}");
		expect(solo).toContain("setSettingsRepoId(solo.id)");
	});
});
