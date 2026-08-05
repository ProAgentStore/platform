import { describe, expect, it } from "vitest";
import { resolveBuildsView, type BuildsRepo } from "./builds-view";

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
