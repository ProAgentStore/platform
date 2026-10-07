import { describe, expect, it } from "vitest";
import { LANES, groupByLane, issueLabel, issueRepos } from "./boardLanes";

const card = (jobKey: string, lane: string | null, extra: Record<string, unknown> = {}) => ({ jobKey, lane, updatedAt: "2026-10-07T00:00:00Z", ...extra });

describe("issue lanes in the console (#895)", () => {
	it("shows every lane the API derives, in the order a reader acts on them", () => {
		expect(LANES.map((l) => l.id)).toEqual(["backlog", "parked", "queued", "running", "waiting_on_human", "failed", "done"]);
	});

	it("orders the backlog by priority label, then the oldest issue — and leaves out a card with no lane", () => {
		const g = groupByLane([
			card("a", "backlog", { priority: 4, githubIssue: { number: 3 } }),
			card("b", "backlog", { priority: 1, githubIssue: { number: 20 } }),
			card("c", "backlog", { priority: 4, githubIssue: { number: 1 } }),
			card("d", "running"),
			card("e", null),
		]);
		expect(g.get("backlog")?.map((c) => c.jobKey)).toEqual(["b", "c", "a"]);
		expect(g.get("running")?.map((c) => c.jobKey)).toEqual(["d"]);
		expect([...g.values()].flat().map((c) => c.jobKey)).not.toContain("e");
	});

	it("offers each repo once for the filter, and names an issue by meaning", () => {
		expect(issueRepos([card("a", "backlog", { githubIssue: { number: 1, repo: "o/web" } }), card("b", "done", { githubIssue: { number: 2, repo: "o/app" } }), card("c", "done", { githubIssue: { number: 3, repo: "o/web" } })])).toEqual(["o/app", "o/web"]);
		expect(issueLabel({ number: 12, title: "Slow startup", repo: "o/app" })).toBe("app#12 Slow startup");
	});
});
