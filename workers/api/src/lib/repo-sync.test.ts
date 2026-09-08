import { beforeEach, describe, expect, it, vi } from "vitest";

const { callRunner } = vi.hoisted(() => ({ callRunner: vi.fn() }));
vi.mock("./runner-client.js", () => ({ callRunner }));

import { describeRepoSync, readRepoSync, REPO_SYNC_TIMEOUT_MS, syncReadNote, verdictFromSync } from "./repo-sync.js";

const FRESH = { checked: true, branch: "main", upstream: "origin/main", localHead: "28057e13abcdef", remoteHead: "6da7c9a1abcdef", fetched: true, fetchedAt: 1, fetchError: null };

describe("verdictFromSync — what the runner saw becomes what the reader is told (#785)", () => {
	it("reads BEHIND as stale, names the counts, both heads and the upstream, and says nothing was pulled", () => {
		// The incident: 6da7c9a1 pushed from another machine; this folder never fetched.
		const v = verdictFromSync({ ...FRESH, ahead: 0, behind: 3 });
		expect(v.state).toBe("behind");
		expect(v.detail).toContain("3 commits BEHIND origin/main");
		expect(v.detail).toContain("local 28057e13");
		expect(v.detail).toContain("origin/main 6da7c9a1");
		expect(v.detail).toContain("NOT on disk here");
	});

	it("is silent when in sync with a fresh fetch — a note on every healthy read is not a signal", () => {
		const v = verdictFromSync({ ...FRESH, ahead: 0, behind: 0 });
		expect(v.state).toBe("in_sync");
		expect(v.detail).toBe("");
		expect(syncReadNote(v)).toBeNull();
		expect(describeRepoSync(v)).toBeNull();
	});

	it("reads AHEAD as unpushed work — the Pilot is told, a reader is not", () => {
		const v = verdictFromSync({ ...FRESH, ahead: 2, behind: 0 });
		expect(v.state).toBe("ahead");
		expect(describeRepoSync(v)).toContain("2 commits ahead");
		// Unpushed local commits do not make a READ stale.
		expect(syncReadNote(v)).toBeNull();
	});

	it("reads both as DIVERGED", () => {
		const v = verdictFromSync({ ...FRESH, ahead: 1, behind: 2 });
		expect(v.state).toBe("diverged");
		expect(v.detail).toContain("DIVERGED");
		expect(v.detail).toContain("1 local commit");
		expect(v.detail).toContain("2 commits behind");
	});

	it("uses singular for one", () => {
		expect(verdictFromSync({ ...FRESH, ahead: 0, behind: 1 }).detail).toContain("1 commit BEHIND");
	});

	it("treats an older runner's {error} as UNVERIFIED, never as in sync", () => {
		// The version marker. A CLI without /coding/sync 404s through the relay.
		const v = verdictFromSync({ error: "Runner /coding/sync → 404: not found" });
		expect(v.state).toBe("unverified");
		expect(v.detail).toContain("could not be checked");
		// No fetch error to name, so the read tools stay quiet — the status quo for an old machine.
		expect(syncReadNote(v)).toBeNull();
	});

	it("keeps the last known counts when the fetch failed, and says the counts are old", () => {
		const v = verdictFromSync({ ...FRESH, fetched: false, fetchError: "could not resolve host github.com", ahead: 0, behind: 1 });
		expect(v.state).toBe("behind");
		expect(v.detail).toContain("the fetch just now failed: could not resolve host github.com");
		expect(v.detail).toContain("last successful fetch");
	});

	it("says a fetch failure OUT LOUD when there are no counts to fall back on", () => {
		// "I could not check" is exactly the fact the incident lacked.
		const v = verdictFromSync({ ...FRESH, fetched: false, fetchError: "Permission denied (publickey)", ahead: null, behind: null });
		expect(v.state).toBe("unverified");
		expect(syncReadNote(v)).toContain("SYNC UNVERIFIED");
		expect(syncReadNote(v)).toContain("Permission denied");
	});

	it("names a missing upstream rather than inventing a comparison", () => {
		const v = verdictFromSync({ ...FRESH, upstream: null, ahead: null, behind: null });
		expect(v.state).toBe("no_upstream");
		expect(v.detail).toContain("no upstream branch");
		expect(syncReadNote(v)).toBeNull();
	});

	it("shortens shas to 8 and tolerates missing ones", () => {
		expect(verdictFromSync({ ...FRESH, ahead: 0, behind: 1 }).localHead).toBe("28057e13");
		expect(verdictFromSync({ ...FRESH, localHead: null, ahead: 0, behind: 1 }).localHead).toBeNull();
	});
});

describe("syncReadNote — the tail a read tool appends", () => {
	it("tells the reader what to do with a stale read, and that nothing was pulled", () => {
		const note = syncReadNote(verdictFromSync({ ...FRESH, ahead: 0, behind: 2 }));
		expect(note).toMatch(/^\(STALE CHECKOUT:/);
		expect(note).toContain("Nothing was pulled automatically");
		expect(note).toContain("git pull");
	});
});

describe("readRepoSync — the one call that reaches a machine", () => {
	beforeEach(() => {
		// Reset, then give the spy a resolved default — the shape every sibling suite uses
		// (repo-local.test.ts). A freshly reset `vi.fn()` with NO implementation that is then
		// pointed at a rejection is reported by vitest 3.2 as an unhandled rejection even when the
		// code under test catches it; with a default in place the same rejection is attributed
		// correctly. Measured, not reasoned: the "never throws" case below fails without this line.
		callRunner.mockReset();
		callRunner.mockResolvedValue({});
	});

	it("sends session, workDir and the configured branch, with the fetch-sized timeout", async () => {
		callRunner.mockResolvedValue({ ...FRESH, ahead: 0, behind: 0 });
		const v = await readRepoSync({} as never, { workDir: "~/work/repo", sessionId: "csess_1", branch: "main" });
		expect(v.state).toBe("in_sync");
		expect(callRunner).toHaveBeenCalledWith({}, "/coding/sync", { sessionId: "csess_1", workDir: "~/work/repo", branch: "main", forceFetch: undefined }, { timeoutMs: REPO_SYNC_TIMEOUT_MS });
	});

	it("never throws — a relay failure is unverified", async () => {
		callRunner.mockRejectedValue(new Error("Runner /coding/sync → 404: not found"));
		const v = await readRepoSync({} as never, { workDir: "~/work/repo" });
		expect(v.state).toBe("unverified");
		expect(v.detail).toContain("404");
	});

	it("does not call the runner with nothing to resolve", async () => {
		const v = await readRepoSync({} as never, {});
		expect(v.state).toBe("unverified");
		expect(callRunner).not.toHaveBeenCalled();
	});
});
