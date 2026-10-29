/**
 * #1407 — auto-pickup must never idle while an unblocked open issue exists. The three scenarios the
 * issue lists verbatim, plus the wiring that closes or flags an `already_done` issue that is still
 * open instead of logging past it forever.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickNextIssue, rankEligible, runAutoPickup, setAutoPickup, type AutoPickupDeps, type PickCandidate } from "./auto-pickup.js";
import { AUTO_PICKUP_DEFAULTS } from "./auto-pickup.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { IssueSummary } from "./github-issues.js";
import type { Env } from "../types.js";

const issue = (number: number, labels: string[] = []): IssueSummary => ({ number, title: `issue ${number}`, state: "open", labels, assignees: [], comments: 0, updatedAt: "", url: `u/${number}` });
const cand = (i: IssueSummary, over: Partial<PickCandidate> = {}): PickCandidate => ({ repo: "acme/app", repoId: "r1", issue: i, boardPosition: null, failures: 0, inFlight: false, ...over });

describe("the three listed scenarios (#1407)", () => {
	it("an unlabelled-only backlog picks something — unlabelled is never ineligible", () => {
		const verdict = pickNextIssue([cand(issue(5)), cand(issue(2)), cand(issue(9))], AUTO_PICKUP_DEFAULTS);
		expect(verdict.pick?.issue.number).toBe(2); // no signal on any of them: oldest (lowest number) wins
	});

	it("a labelled backlog where every labelled issue is excluded falls through to the unlabelled one", () => {
		const candidates = [cand(issue(1, ["needs-human"])), cand(issue(2, ["question"])), cand(issue(3))];
		const verdict = pickNextIssue(candidates, AUTO_PICKUP_DEFAULTS);
		expect(verdict.pick?.issue.number).toBe(3);
		// And ranking alone (before exclusion) would NOT have reordered it ahead of a priority-labelled one were there a real candidate:
		expect(rankEligible(candidates, AUTO_PICKUP_DEFAULTS).map((c) => c.issue.number)).toEqual([3]);
	});

	it("only excluded-label issues in the backlog gives none_eligible, naming the count", () => {
		const verdict = pickNextIssue([cand(issue(1, ["needs-human"])), cand(issue(2, ["wontfix"])), cand(issue(3, ["blocked"]))], AUTO_PICKUP_DEFAULTS);
		expect(verdict).toMatchObject({ pick: null, reason: "none of the 3 open issue(s) qualifies" });
	});
});

describe("falling through a start-guard refusal to the next candidate, never stopping at the first (#1407)", () => {
	let d1: RealSchemaD1;
	let env: Env;
	let open: IssueSummary[];

	function doneRun(n: number, finishedAt: number) {
		d1.exec(`INSERT OR IGNORE INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('s-${n}', 'coder', 'r1', 'u1')`);
		d1.exec(`INSERT OR IGNORE INTO tickets (id, instance_id, user_id, job_key, title, created_by, repo_id, issue_number) VALUES ('t-${n}', 'coder', 'u1', 'issue:r1#${n}', 'T', 'human', 'r1', ${n})`);
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id, ticket_id)
		  VALUES ('done-${n}', 'u1', 'coder', 'Implement GitHub issue #${n}', 'completed', 'done', 10, 1, ${finishedAt}, 's-${n}', 't-${n}')`);
	}
	function deps(over: Partial<AutoPickupDeps> = {}): AutoPickupDeps {
		return { listOpenIssues: async () => ({ issues: open, unreadable: false }), postComment: async () => true, notify: async () => undefined, startQueued: async () => ({ drained: true, started: true }), ...over };
	}
	const logRows = (outcome: string) => d1.sqlite.prepare("SELECT * FROM auto_pickup_log WHERE outcome = ?1").all(outcome) as Array<Record<string, unknown>>;

	beforeEach(async () => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'coder', 'u1', 'app', 'acme/app')`);
		env = { DB: d1.DB } as unknown as Env;
		open = [];
		await setAutoPickup(env, "coder", "u1", { enabled: true });
	});
	afterEach(() => d1.close());

	it("a still-open already_done issue is closed when the handler says CI is green, and the next candidate still starts", async () => {
		open = [issue(3), issue(8)];
		doneRun(3, Date.now() - 1000);
		let closedArgs: unknown;
		const r = await runAutoPickup(env, "coder", "u1", deps({ handleAlreadyDone: async (_e, input) => { closedArgs = input; return { action: "closed", runId: input.runId, sha: "a".repeat(40) }; } }));
		expect(r).toMatchObject({ started: true, issue: 8 });
		expect(closedArgs).toMatchObject({ githubRepo: "acme/app", issue: 3 });
		expect(logRows("closed_done")).toHaveLength(1);
		expect(String(logRows("closed_done")[0].detail)).toContain("done-3");
	});

	it("a still-open already_done issue that cannot be closed is flagged, recorded, and the cycle still falls through", async () => {
		open = [issue(3)];
		doneRun(3, Date.now() - 1000);
		const r = await runAutoPickup(env, "coder", "u1", deps({ handleAlreadyDone: async () => ({ action: "flagged", reason: "CI failed on the commit it delivered" }) }));
		expect(r).toMatchObject({ started: false });
		expect(logRows("flagged_review")).toHaveLength(1);
		expect(String(logRows("flagged_review")[0].detail)).toContain("CI failed");
		expect(logRows("none_eligible")).toHaveLength(1); // still falls through to the end — the wake reports what it found, not an error
	});

	it("a handler reporting skipped (already closed by a human, or the write itself failed) writes nothing extra", async () => {
		open = [issue(3)];
		doneRun(3, Date.now() - 1000);
		await runAutoPickup(env, "coder", "u1", deps({ handleAlreadyDone: async () => ({ action: "skipped", reason: "already closed on GitHub" }) }));
		expect(logRows("closed_done")).toEqual([]);
		expect(logRows("flagged_review")).toEqual([]);
	});

	it("the handler is never called for a refusal that is not already_done", async () => {
		open = [issue(3, ["needs-human"])]; // excluded outright — never reaches the start guard at all
		let called = false;
		await runAutoPickup(env, "coder", "u1", deps({ handleAlreadyDone: async () => { called = true; return { action: "skipped", reason: "x" }; } }));
		expect(called).toBe(false);
	});
});
