/**
 * #1671 — triage must not queue finished work again, must not count admission outcomes as failed coding runs, and must read the
 * issue's CURRENT context before calling it vague. Real schema; GitHub and notifications are the only fakes.
 *
 * The HeartFull incident this answers: 50 consecutive queue entries for #814 (delivered, open only for real-event acceptance), each
 * refused `already_done` at drain time with no run; #804 classed "missing acceptance" despite an Acceptance section; and a bot
 * comment claiming two coding runs failed that the run history does not show.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { setCoderBrain } from "./coder-brain.js";
import { recordDrainRefusal, recordRunForIssue } from "./issue-attempt-hooks.js";
import { issueQuarantine } from "./issue-attempts.js";
import { markRunPreflightBlocked } from "./repo-admission-blocker.js";
import { type PoTriageDeps, runPoTriage } from "./po-triage-wake.js";
import { classifyPoIssue, clarifyingCommentsText, DETAIL_MARKER, type PoIssue } from "./po-triage.js";
import type { Env } from "../types.js";

const REPO = "acme/app";
const READY_BODY = "The login page crashes when the email field is empty, which blocks new users from signing up at all.\n\n## Scope\nOnly the login form.\n\n## Area\n`src/login.ts`\n\n## Acceptance criteria\n- It shows a validation message.";
let d1: RealSchemaD1;
let env: Env;

const issue = (number: number, over: Partial<PoIssue> = {}): PoIssue => ({ number, title: `Issue ${number}`, body: READY_BODY, labels: [], ...over });
const NOW = new Date("2026-11-19T08:27:00Z");

function github(issues: PoIssue[], comments: Record<number, { body: string }[]> = {}) {
	const posted: Array<{ n: number; body: string }> = [];
	const deps: PoTriageDeps = {
		listOpenIssues: async () => ({ issues, complete: true, unreadable: false }),
		listComments: async (_r, n) => [...(comments[n] ?? []), ...posted.filter((p) => p.n === n).map((p) => ({ body: p.body }))],
		postComment: async (_r, n, body) => {
			posted.push({ n, body });
			return true;
		},
		notify: async () => undefined,
		startQueued: async () => undefined,
	};
	return { deps, posted };
}

const queuedRows = () => d1.sqlite.prepare("SELECT objective, status FROM instance_objective_queue WHERE instance_id = 'coder'").all() as Array<{ objective: string; status: string }>;
const wake = (deps: PoTriageDeps, dryRun = false, when = NOW) => runPoTriage(env, { instance_id: "coder", user_id: "u1" }, { dryRun }, when, deps);
const items = async (r: Awaited<ReturnType<typeof wake>>) => {
	if (r.skipped) throw new Error("skipped");
	const row = d1.sqlite.prepare("SELECT report FROM po_triage_reports WHERE id = ?").get(r.reportId) as { report: string };
	return (JSON.parse(row.report) as { items: Array<{ number: number; category: string; action: string; reason: string }> }).items;
};

/** A ticket for the issue, and one run that ended with `stop`, finished `ago` ms before NOW. */
function seedRun(runId: string, n: number, over: { status?: string; stop?: string; ago?: number; preflight?: boolean; queueEntry?: string } = {}) {
	const ticket = `t-${n}`;
	if (!d1.sqlite.prepare("SELECT 1 FROM tickets WHERE id = ?").get(ticket)) {
		d1.exec(`INSERT INTO tickets (id, instance_id, user_id, job_key, title, created_by, repo_id, issue_number) VALUES ('${ticket}', 'coder', 'u1', 'issue:repo-1#${n}', 'T', 'human', 'repo-1', ${n})`);
	}
	const finished = NOW.getTime() - (over.ago ?? 3_600_000);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id, ticket_id, queue_entry_id, preflight_blocked)
	         VALUES ('${runId}', 'u1', 'coder', 'Work issue #${n} in ${REPO}', '${over.status ?? "completed"}', '${over.stop ?? "done"}', 5, ${finished - 60_000}, ${finished}, 's-${runId}', '${ticket}', ${over.queueEntry ? `'${over.queueEntry}'` : "NULL"}, ${over.preflight ? 1 : "NULL"})`);
}

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('repo-1', 'coder', 'u1', 'app', '${REPO}')`);
	env = { DB: d1.DB, AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) } } as unknown as Env;
	await setCoderBrain(env, "coder", "u1", { enabled: true, poEnabled: true });
});
afterEach(() => d1.close());

describe("completed work is not queued again (#1671)", () => {
	it("a delivered issue that stays open for acceptance is excluded on EVERY wake — nothing is queued, nothing fails at the drain", async () => {
		seedRun("run-814", 814, { ago: 20 * 3_600_000 }); // finished yesterday; the issue is open "solely for real-event acceptance"
		const { deps } = github([issue(814), issue(900)]);
		for (let i = 0; i < 5; i++) {
			const r = await wake(deps, false, new Date(NOW.getTime() + i * 3_600_000));
			const it814 = (await items(r)).find((x) => x.number === 814);
			expect(it814).toMatchObject({ category: "ready", action: "excluded" });
			expect(it814?.reason).toMatch(/already done/);
			expect(it814?.reason).toContain("run-814");
		}
		const rows = queuedRows();
		expect(rows.some((q) => q.objective.includes("#814"))).toBe(false); // 0 entries across 5 wakes, not 50 failed rows
		expect(rows.filter((q) => q.objective.includes("#900"))).toHaveLength(1); // other work is untouched and queued once
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_objective_queue WHERE status = 'failed'").get()).toEqual({ n: 0 });
	});

	it("the dry run reports the exclusion too, and counts it", async () => {
		seedRun("run-814", 814);
		const { deps } = github([issue(814)]);
		const r = await wake(deps, true);
		expect(r).toMatchObject({ skipped: false, counts: { wouldQueue: 0, excluded: 1 } });
		expect(await items(r)).toEqual([expect.objectContaining({ number: 814, action: "excluded" })]);
		expect(queuedRows()).toEqual([]);
	});

	it("a closed issue, and one that a run is working right now, are not queued", async () => {
		d1.exec(`INSERT INTO tickets (id, instance_id, user_id, job_key, title, created_by, repo_id, issue_number, issue_cache) VALUES ('t-30', 'coder', 'u1', 'issue:repo-1#30', 'T', 'human', 'repo-1', 30, '{"number":30,"repo":"acme/app","title":"x","state":"closed","url":"https://github.com/acme/app/issues/30"}')`);
		seedRun("run-40", 40, { status: "running", stop: "" });
		d1.exec("UPDATE agent_loop_runs SET stop_reason = NULL, finished_at = NULL WHERE run_id = 'run-40'");
		const { deps } = github([issue(30), issue(40)]);
		const got = await items(await wake(deps));
		expect(got.map((x) => [x.number, x.action])).toEqual([[30, "excluded"], [40, "excluded"]]);
		expect(got[0].reason).toMatch(/issue closed/);
		expect(got[1].reason).toMatch(/duplicate/);
		expect(queuedRows()).toEqual([]);
	});

	it("an issue the owner labelled needs-human is left alone, and an issue already queued is not queued twice", async () => {
		const { deps } = github([issue(5, { labels: ["needs-human"] }), issue(6)]);
		await wake(deps);
		const again = await items(await wake(deps, false, new Date(NOW.getTime() + 3_600_000)));
		expect(again.map((x) => [x.number, x.action])).toEqual([[5, "none"], [6, "already_queued"]]);
		expect(queuedRows().filter((q) => q.status === "pending")).toHaveLength(1);
	});

	it("a repeated admission refusal is held off by a cooldown — not retried every wake, and not counted as a failed run", async () => {
		const entry = { id: "objq-1", instanceId: "coder", userId: "u1", repoId: "repo-1", objective: `Work issue #7 in ${REPO}: Issue 7.`, metadata: null };
		await recordDrainRefusal(env, entry, null, undefined, "no coding CLI on this machine", NOW.getTime() - 60_000);
		const { deps } = github([issue(7)]);
		const r = await wake(deps);
		const it7 = (await items(r)).find((x) => x.number === 7);
		expect(it7).toMatchObject({ action: "excluded" });
		expect(it7?.reason).toContain("no coding CLI on this machine");
		expect(queuedRows()).toEqual([]);
		expect(await issueQuarantine(env, "u1", REPO, 7)).toBeNull(); // an admission outcome never quarantines
		// …and the cooldown lapses by itself: the issue is eligible again once it has passed.
		const later = await wake(deps, false, new Date(NOW.getTime() + 7 * 3_600_000));
		expect((await items(later)).find((x) => x.number === 7), JSON.stringify(await items(later))).toMatchObject({ action: "queued" });
	});
});

describe("failed-run accounting is truthful and traceable (#1671)", () => {
	const unsuccessful = (runId: string, n: number) => {
		seedRun(runId, n, { status: "failed", stop: "failed" });
		return recordRunForIssue(env, runId, "failed", NOW.getTime());
	};
	const attemptRows = (n: number) => d1.sqlite.prepare("SELECT kind, run_id FROM issue_attempts WHERE issue_number = ? ORDER BY id").all(n) as Array<{ kind: string; run_id: string | null }>;

	it("real failed executions are recorded against their actual run ids", async () => {
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('repo-x', 'coder', 'u1', 'x', 'acme/x')`);
		await unsuccessful("run-a", 836);
		await unsuccessful("run-b", 836);
		expect(attemptRows(836)).toEqual([{ kind: "run_unsuccessful", run_id: "run-a" }, { kind: "run_unsuccessful", run_id: "run-b" }]);
	});

	it("a run stopped at the pre-flight is kept on the record but is not a failed implementation attempt", async () => {
		seedRun("run-pre", 836, { status: "failed", stop: "failed" });
		await markRunPreflightBlocked(env, "run-pre");
		await recordRunForIssue(env, "run-pre", "failed", NOW.getTime());
		expect(attemptRows(836)).toEqual([]); // not counted…
		expect(d1.sqlite.prepare("SELECT status, stop_reason, preflight_blocked FROM agent_loop_runs WHERE run_id = 'run-pre'").get()).toEqual({ status: "failed", stop_reason: "failed", preflight_blocked: 1 }); // …and not erased
	});

	it("five admission failures plus four real failures do not quarantine; the fifth real one does — history intact either way", async () => {
		for (let n = 1; n <= 5; n++) await recordDrainRefusal(env, { id: `q${n}`, instanceId: "coder", userId: "u1", repoId: "repo-1", objective: `Work issue #12 in ${REPO}: t`, metadata: null }, null, undefined, "x");
		for (let n = 1; n <= 4; n++) await unsuccessful(`run-${n}`, 12);
		expect(await issueQuarantine(env, "u1", REPO, 12)).toBeNull();
		await unsuccessful("run-5", 12);
		expect(await issueQuarantine(env, "u1", REPO, 12)).toMatchObject({ attemptCount: 5 });
		expect(attemptRows(12)).toHaveLength(10); // every row is still there
	});
});

describe("missing detail is judged on the issue's current context (#1671)", () => {
	const ctx = { openIssues: new Set<number>(), openListComplete: true };
	const NO_ACCEPTANCE = "The login page crashes when the email field is empty, which blocks new users from signing up at all.\n\n## Scope\nOnly the login form.\n\n## Area\n`src/login.ts`";

	it("an Acceptance section counts, whatever its heading is worded", () => {
		for (const heading of ["## Acceptance", "## Acceptance criteria", "**Acceptance:**", "### Acceptance tests", "Definition of done", "## Expected behavior", "Done when:"]) {
			const c = classifyPoIssue(issue(804, { body: `${NO_ACCEPTANCE}\n\n${heading}\n- it works` }), ctx);
			expect(c.category, heading).toBe("ready");
		}
	});

	it("an issue with no acceptance statement is still needs_detail, and so is a passing mention of the word", () => {
		expect(classifyPoIssue(issue(1, { body: NO_ACCEPTANCE }), ctx)).toMatchObject({ category: "needs_detail", missing: [expect.stringContaining("acceptance criteria")] });
		expect(classifyPoIssue(issue(1, { body: `${NO_ACCEPTANCE}\n\nThere is no acceptance yet; please advise.` }), ctx).category).toBe("needs_detail");
	});

	it("criteria stated in a comment count — the body alone is not the whole issue", async () => {
		const { deps, posted } = github([issue(21, { body: NO_ACCEPTANCE })], { 21: [{ body: "Maintainer:\n\n## Acceptance\n1. The form shows an error.\n2. No request is sent." }] });
		const r = await wake(deps);
		expect((await items(r))[0]).toMatchObject({ category: "ready", action: "queued" });
		expect(posted).toEqual([]); // no "missing detail" comment on an issue that has its detail
	});

	it("our own needs-detail comment cannot satisfy its own check", async () => {
		const own = { body: `**Product-owner triage:** it needs:\n\n- acceptance criteria (how we know it is done)\n<!-- ${DETAIL_MARKER}:abc -->` };
		expect(clarifyingCommentsText([own, { body: "real" }])).toBe("real");
		const { deps } = github([issue(22, { body: NO_ACCEPTANCE })], { 22: [own] });
		expect((await items(await wake(deps)))[0]).toMatchObject({ category: "needs_detail" });
	});

	it("changed issue context changes the verdict: an issue that was vague becomes ready when a comment supplies the detail, and comments once only while vague", async () => {
		const comments: Record<number, { body: string }[]> = {};
		const { deps, posted } = github([issue(23, { body: NO_ACCEPTANCE })], comments);
		expect((await items(await wake(deps)))[0]).toMatchObject({ category: "needs_detail", action: "commented" });
		expect((await items(await wake(deps, false, new Date(NOW.getTime() + 3_600_000))))[0]).toMatchObject({ category: "needs_detail", action: "already_commented" });
		expect(posted).toHaveLength(1);
		comments[23] = [{ body: "## Acceptance\n- shows an error" }];
		expect((await items(await wake(deps, false, new Date(NOW.getTime() + 7_200_000))))[0]).toMatchObject({ category: "ready", action: "queued" });
		expect(posted).toHaveLength(1);
	});
});

describe("auto-pickup honours the same cooldown (#1671)", () => {
	it("does not pick an issue whose queued objective the drain just refused", async () => {
		const { runAutoPickup, setAutoPickup } = await import("./auto-pickup.js");
		await setAutoPickup(env, "coder", "u1", { enabled: true }).catch(() => undefined);
		const entry = { id: "objq-9", instanceId: "coder", userId: "u1", repoId: "repo-1", objective: `Work issue #9 in ${REPO}: Issue 9.`, metadata: null };
		await recordDrainRefusal(env, entry, null, undefined, "no coding CLI on this machine", NOW.getTime() - 60_000);
		const issues = [{ number: 9, title: "Issue 9", labels: [], body: READY_BODY, state: "open", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", url: "u", summary: "" }];
		const r = await runAutoPickup(env, "coder", "u1", { listOpenIssues: async () => ({ issues: issues as never, incomplete: false, unreadable: false }), notify: async () => undefined, startQueued: async () => ({ drained: false }) as never }, NOW.getTime());
		expect(r.started).toBe(false);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_objective_queue").get()).toEqual({ n: 0 });
		expect(d1.sqlite.prepare("SELECT detail FROM auto_pickup_log WHERE outcome = 'passed_over'").all()).toEqual([{ detail: expect.stringContaining("admission_cooldown") }]);
	});
});
