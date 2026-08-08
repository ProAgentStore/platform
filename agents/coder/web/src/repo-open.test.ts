import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoOpenAction, shouldAutoOpenSoloSession } from "./repo-open";

const src = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");

/**
 * Source with comments removed — the same helper repos-list.test.ts uses, for the same reason:
 * several assertions below forbid a token, and the comment explaining WHY necessarily contains it.
 */
const code = (f: string) =>
	src(f)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");

describe("repoOpenAction — one verb, and the two rules most likely to be tidied away (#408)", () => {
	it("says the same thing whether or not a session already exists", () => {
		// The point of the change. Two labels meant the user was reading a cache's state off a
		// button and choosing a verb accordingly; a session is a thing the platform reaps after six
		// idle hours and re-opens on demand.
		const withSession = repoOpenAction({ hasActiveSession: true, opening: false, runnerOnline: true });
		const without = repoOpenAction({ hasActiveSession: false, opening: false, runnerOnline: true });
		expect(withSession.label).toBe("Open");
		expect(without.label).toBe("Open");
	});

	it("stays clickable when the runner looks offline", () => {
		// #241, and it is a trap because disabling looks like a courtesy. Connectivity is only ever
		// learned from a live session's capture, so with no session and no way to start one,
		// "your machine isn't connected" can never be disproved — including while `pags up` is
		// demonstrably running. The diagnosis goes in the title, beside the action.
		const a = repoOpenAction({ hasActiveSession: false, opening: false, runnerOnline: false });
		expect(a.disabled).toBe(false);
		expect(a.title).toMatch(/pags up/);
	});

	it("shows the opening state instead of nothing", () => {
		// A spawn plus a `--resume` takes seconds. Silence reads as a hang (#378).
		const a = repoOpenAction({ hasActiveSession: false, opening: true, runnerOnline: true });
		expect(a.disabled).toBe(true);
		expect(a.label).not.toBe("Open");
	});
});

describe("shouldAutoOpenSoloSession", () => {
	const base = { hasRepo: true, hasActiveSession: false, runnerOnline: true as boolean | null, alreadyTried: false, opening: false };

	it("opens the one-repo surface's session without being asked", () => {
		expect(shouldAutoOpenSoloSession(base)).toBe(true);
	});

	it("never auto-opens with the runner offline OR unknown", () => {
		// #408 is explicit that nothing may be auto-opened with the runner offline, and `null` is
		// "not observed yet" — reading it as permission would spawn against a machine nothing has
		// confirmed is there. The user's own click is still allowed; see repoOpenAction.
		expect(shouldAutoOpenSoloSession({ ...base, runnerOnline: false })).toBe(false);
		expect(shouldAutoOpenSoloSession({ ...base, runnerOnline: null })).toBe(false);
	});

	it("tries at most once, and never over an existing session or an open in flight", () => {
		// Without the latch a failed open is retried on every render — an engine that cannot start
		// would be re-attempted forever on somebody's laptop.
		expect(shouldAutoOpenSoloSession({ ...base, alreadyTried: true })).toBe(false);
		expect(shouldAutoOpenSoloSession({ ...base, opening: true })).toBe(false);
		expect(shouldAutoOpenSoloSession({ ...base, hasActiveSession: true })).toBe(false);
		expect(shouldAutoOpenSoloSession({ ...base, hasRepo: false })).toBe(false);
	});
});

describe("the console no longer asks the user to start a session (#408)", () => {
	// Source assertions, in this package's established style (see repos-list.test.ts): the
	// affordances are conditional JSX, and what matters is that the wiring EXISTS end-to-end.
	const tab = src("CodingTab.tsx");
	const list = src("ReposList.tsx");

	it("the repo row has ONE action, routed through the shared decision", () => {
		expect(list).toContain("repoOpenAction({");
		expect(list).toContain("openRepo(r.id)");
		// The two-button fork is gone — no "Start" verb survives in the row.
		expect(list).not.toContain(">Start<");
	});

	it("no caller re-derives active-session-or-start for itself", () => {
		// Four call sites wrote out `active ? openTerminal(active) : startSession(id)`. One of them
		// drifting is how "Work on this" and the repo switcher would start behaving differently
		// from the repo row.
		// Word-boundary: `restartSession` legitimately contains the same letters.
		expect(code("CodingTab.tsx")).not.toMatch(/\bstartSession\b/);
		expect(tab).toContain("const openRepoSession = async (repoId: string) =>");
	});

	it("the opening state is threaded to the row, not just held", () => {
		expect(tab).toContain("openingRepoId={openingRepoId}");
		expect(tab).toContain("setOpeningRepoId(repoId)");
	});

	it("a failed open is shown inline rather than in an alert", () => {
		// An alert is modal, unselectable and gone on dismiss, and this text is the server's runner
		// diagnosis — the thing #271/#407 worked to phrase precisely.
		expect(tab).toContain("setOpenError(");
		const open = tab.slice(tab.indexOf("const openRepoSession"), tab.indexOf("soloAutoOpenRef"));
		expect(open).not.toContain("alert(");
	});

	it("the one-repo surface auto-opens through the gate rather than inline conditions", () => {
		expect(tab).toContain("shouldAutoOpenSoloSession({");
		expect(tab).toContain("soloAutoOpenRef.current || autoOpenedRef.current");
	});

	it("the repo list no longer counts sessions at the user", () => {
		// "N active sessions" is the tab telling the user about a concept #408 removes from the
		// primary flow. The per-repo status line is what a user actually needs.
		expect(list).not.toContain("active session{");
	});
});
