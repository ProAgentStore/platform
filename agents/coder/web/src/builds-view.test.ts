import { describe, expect, it } from "vitest";
import { resolveBuildsView, buildState, isBuildInFlight, anyBuildInFlight, type BuildsRepo } from "./builds-view";

describe("buildState", () => {
	it("maps the GitHub Actions status/conclusion pair", () => {
		expect(buildState({ status: "in_progress" })).toBe("running");
		expect(buildState({ status: "queued" })).toBe("pending");
		expect(buildState({ status: "completed", conclusion: "success" })).toBe("success");
		expect(buildState({ status: "completed", conclusion: "failure" })).toBe("failed");
		expect(buildState({ status: "completed", conclusion: "cancelled" })).toBe("failed");
		expect(buildState({ status: "completed", conclusion: "timed_out" })).toBe("failed");
	});

	it("is unknown for a missing run or an unrecognised conclusion", () => {
		expect(buildState(null)).toBe("unknown");
		expect(buildState(undefined)).toBe("unknown");
		expect(buildState({})).toBe("unknown");
		expect(buildState({ status: "completed", conclusion: "neutral" })).toBe("unknown");
		expect(buildState({ status: "completed", conclusion: null })).toBe("unknown");
	});
});

describe("isBuildInFlight", () => {
	it("is in flight only while queued or in progress", () => {
		expect(isBuildInFlight("running")).toBe(true);
		expect(isBuildInFlight("pending")).toBe(true);
		expect(isBuildInFlight("success")).toBe(false);
		expect(isBuildInFlight("failed")).toBe(false);
		// A repo with no runs, or with GitHub unavailable, must not pin the panel at full rate.
		expect(isBuildInFlight("unknown")).toBe(false);
	});
});

describe("anyBuildInFlight", () => {
	it("is true when any run is still going", () => {
		expect(anyBuildInFlight([{ status: "completed", conclusion: "success" }, { status: "queued" }])).toBe(true);
	});

	it("is false for a settled history — it cannot change until someone pushes", () => {
		expect(anyBuildInFlight([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }])).toBe(false);
	});

	it("is false for an empty list or a list of missing runs", () => {
		expect(anyBuildInFlight([])).toBe(false);
		expect(anyBuildInFlight([null, undefined])).toBe(false);
	});
});

const repo = (id: string, over: Partial<BuildsRepo> = {}): BuildsRepo =>
	({ repoId: id, repoName: `owner/${id}`, available: true, ...over });

describe("resolveBuildsView — one repo is not a list", () => {
	it("goes straight to history for a single repo", () => {
		// The complaint this answers: a Repo Coder owns ONE repo, so 'latest run per repo' spent a
		// whole panel on one line and hid the question you actually have — when did this start
		// failing. With one repo the choice a list exists to offer is already made.
		expect(resolveBuildsView([repo("r1")], null)).toEqual({
			mode: "history", repoId: "r1", repoName: "owner/r1", canGoBack: false,
		});
	});

	it("offers no way back from a single repo — there is no list behind it", () => {
		// A back arrow that returns to a list of one is a dead control.
		const v = resolveBuildsView([repo("r1")], null);
		expect(v.mode === "history" && v.canGoBack).toBe(false);
	});

	it("ignores a stale selection when the agent is down to one repo", () => {
		// Deleting a repo while its history is open must not strand the view.
		expect(resolveBuildsView([repo("r1")], "gone")).toMatchObject({ mode: "history", repoId: "r1" });
	});
});

describe("resolveBuildsView — several repos keep the overview", () => {
	it("lists until a repo is chosen", () => {
		expect(resolveBuildsView([repo("r1"), repo("r2")], null)).toEqual({ mode: "list" });
	});

	it("opens the chosen repo's history, WITH a way back", () => {
		expect(resolveBuildsView([repo("r1"), repo("r2")], "r2")).toEqual({
			mode: "history", repoId: "r2", repoName: "owner/r2", canGoBack: true,
		});
	});

	it("falls back to the list when the open repo disappears", () => {
		// Removed while its history was open — rendering history for something gone would poll a
		// 404 forever behind a panel that never updates.
		expect(resolveBuildsView([repo("r1"), repo("r3")], "r2")).toEqual({ mode: "list" });
	});

	it("shows the list, not an empty history, when there are no repos at all", () => {
		expect(resolveBuildsView([], null)).toEqual({ mode: "list" });
		expect(resolveBuildsView([], "r1")).toEqual({ mode: "list" });
	});
});

describe("resolveBuildsView — the title is resolved, so both views agree", () => {
	it("uses the GitHub coordinate, not the add-time nickname", () => {
		// The drill-down header used the raw name while the list row used the resolved one, so the
		// same repo was called `fws/platform` in one place and `freewebstore-online/platform` in the
		// other. Resolving inside the view function means there is only one answer.
		const v = resolveBuildsView([{ repoId: "r1", repoName: "fws/platform", githubRepo: "freewebstore-online/platform", available: true }], null);
		expect(v.mode === "history" && v.repoName).toBe("freewebstore-online/platform");
	});

	it("keeps the folder name for a local-only repo", () => {
		const v = resolveBuildsView([{ repoId: "r1", repoName: "my-notes", available: true }], null);
		expect(v.mode === "history" && v.repoName).toBe("my-notes");
	});

	it("resolves the drill-down title the same way", () => {
		const v = resolveBuildsView([
			{ repoId: "r1", repoName: "a/b", githubRepo: "owner/one", available: true },
			{ repoId: "r2", repoName: "c/d", githubRepo: "owner/two", available: true },
		], "r2");
		expect(v.mode === "history" && v.repoName).toBe("owner/two");
	});
});

