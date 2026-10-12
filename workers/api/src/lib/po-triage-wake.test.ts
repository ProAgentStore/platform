/**
 * The product-owner wake (#1027) on the real schema. GitHub and notifications are the only fakes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { PO_TRIAGE_ACTION, poTriageDefaultMinute, readCoderBrain, setCoderBrain } from "./coder-brain.js";
import { normalizeSchedule } from "./cron-schedule.js";
import { type PoTriageDeps, runPoTriage } from "./po-triage-wake.js";
import type { PoIssue } from "./po-triage.js";
import { runDueTriggers } from "./triggers.js";
import type { Env } from "../types.js";

const REPO = "acme/app";
/** States the problem, acceptance criteria, scope and area (same shape as po-triage.test.ts). */
const READY_BODY = "The login page crashes when the email field is empty, which blocks new users from signing up at all.\n\n## Scope\nOnly the login form.\n\n## Area\n`src/login.ts`\n\n## Acceptance criteria\n- [ ] an empty email shows an inline error";
let d1: RealSchemaD1;
let env: Env;

/** The issue's fixture: needs-human, blocked by an open issue, missing acceptance criteria, ready. */
const FIXTURE: PoIssue[] = [
	{ number: 1, title: "Pick the pricing", body: READY_BODY, labels: ["needs-human"] },
	{ number: 2, title: "After pricing", body: `${READY_BODY}\n\nBlocked by #1`, labels: [] },
	{ number: 3, title: "Make it better", body: "Make it better.", labels: [] },
	{ number: 4, title: "Login crash", body: READY_BODY, labels: [] },
];

function github() {
	const comments = new Map<number, { body: string }[]>();
	const log = { listed: 0, posted: [] as number[], notified: [] as string[], started: [] as string[] };
	const deps: PoTriageDeps = {
		listOpenIssues: async () => {
			log.listed++;
			return { issues: FIXTURE, complete: true, unreadable: false };
		},
		listComments: async (_repo, n) => comments.get(n) ?? [],
		postComment: async (_repo, n, body) => {
			log.posted.push(n);
			comments.set(n, [...(comments.get(n) ?? []), { body }]);
			return true;
		},
		notify: async (_title, body) => {
			log.notified.push(body);
		},
		startQueued: async (repoId) => {
			log.started.push(repoId);
		},
	};
	return { deps, log };
}

const queued = () => d1.sqlite.prepare("SELECT objective FROM instance_objective_queue WHERE instance_id = 'coder' AND status = 'pending'").all() as { objective: string }[];
const reports = () => d1.sqlite.prepare("SELECT status, dry_run, digest, report FROM po_triage_reports WHERE instance_id = 'coder' ORDER BY created_at, rowid").all() as Array<{ status: string; dry_run: number; digest: string | null; report: string }>;
const at = (iso: string) => new Date(iso);

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	d1.exec(`UPDATE agent_instances SET config = '{"displayName":"Tennis Clubs"}' WHERE id = 'coder'`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('repo-1', 'coder', 'u1', 'app', '${REPO}')`);
	// executeTriggerAction takes the instance's DO stub up front; this action never uses it.
	env = { DB: d1.DB, AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) } } as unknown as Env;
	await setCoderBrain(env, "coder", "u1", { enabled: true, poEnabled: true });
});
afterEach(() => d1.close());

describe("off is off (#1027)", () => {
	it("with the brain or its PO layer off, a wake reads nothing and writes no report", async () => {
		const { deps, log } = github();
		await setCoderBrain(env, "coder", "u1", { enabled: false });
		expect(await runPoTriage(env, { instance_id: "coder", user_id: "u1" }, { dryRun: false }, at("2026-10-12T01:17:00Z"), deps)).toMatchObject({ skipped: true });
		expect(log.listed).toBe(0);
		expect(reports()).toHaveLength(0);
		expect(await readCoderBrain(env, "coder", "u1")).toEqual({ enabled: false, poEnabled: false });
	});
});

describe("a live wake over the four-issue fixture (#1027)", () => {
	it("queues only the ready one, notes the blocked one, comments once on the vague one, leaves the needs-human one alone", async () => {
		const { deps, log } = github();
		const r = await runPoTriage(env, { instance_id: "coder", user_id: "u1" }, { dryRun: false }, at("2026-10-12T01:17:00Z"), deps);
		expect(r).toMatchObject({ skipped: false, counts: { queued: 1, waiting: 1, blocked: 1, needsDetail: 1, commented: 1, ready: 1 } });
		expect(queued().map((q) => q.objective)).toEqual([expect.stringMatching(/^Work issue #4 in acme\/app: Login crash\./)]);
		expect(log.posted).toEqual([3]);
		expect(log.started).toEqual(["repo-1"]);
		const [row] = reports();
		const items = JSON.parse(row.report).items as Array<{ number: number; category: string; action: string; reason: string }>;
		expect(items.map((i) => [i.number, i.category, i.action])).toEqual([
			[1, "waiting_on_human", "none"],
			[2, "blocked", "none"],
			[3, "needs_detail", "commented"],
			[4, "ready", "queued"],
		]);
		expect(items[1].reason).toBe("Waits on #1, still open.");
		// The digest matches the report.
		expect(row.digest).toBe("Tennis Clubs: queued 1, 1 waiting on you, 1 blocked, 1 needs detail");
		expect(log.notified).toEqual([row.digest]);
	});

	it("running the wake again queues nothing new, posts no duplicate comment, and sends no digest", async () => {
		const { deps, log } = github();
		await runPoTriage(env, { instance_id: "coder", user_id: "u1" }, { dryRun: false }, at("2026-10-12T01:17:00Z"), deps);
		const again = await runPoTriage(env, { instance_id: "coder", user_id: "u1" }, { dryRun: false }, at("2026-10-12T02:17:00Z"), deps);
		expect(again).toMatchObject({ skipped: false, counts: { queued: 0, alreadyQueued: 1, commented: 0 }, digest: null });
		expect(queued()).toHaveLength(1);
		expect(log.posted).toEqual([3]);
		expect(log.notified).toHaveLength(1);
		expect(reports()).toHaveLength(2); // a report for every wake, digest or not
	});

	it("a changed vague issue gets one new comment; an unchanged one never does", async () => {
		const { deps, log } = github();
		await runPoTriage(env, { instance_id: "coder", user_id: "u1" }, { dryRun: false }, at("2026-10-12T01:17:00Z"), deps);
		FIXTURE[2] = { ...FIXTURE[2], body: "Make it better, faster." };
		try {
			await runPoTriage(env, { instance_id: "coder", user_id: "u1" }, { dryRun: false }, at("2026-10-12T02:17:00Z"), deps);
		} finally {
			FIXTURE[2] = { ...FIXTURE[2], body: "Make it better." };
		}
		expect(log.posted).toEqual([3, 3]);
	});
});

describe("windows and slots (#1027)", () => {
	it("two windows firing in the same minute produce one wake", async () => {
		const { deps, log } = github();
		const first = await runPoTriage(env, { id: "t-morning", instance_id: "coder", user_id: "u1" }, { dryRun: true }, at("2026-10-12T01:17:10Z"), deps);
		const second = await runPoTriage(env, { id: "t-evening", instance_id: "coder", user_id: "u1" }, { dryRun: true }, at("2026-10-12T01:17:50Z"), deps);
		expect(first.skipped).toBe(false);
		expect(second).toMatchObject({ skipped: true, reason: expect.stringMatching(/already woke this instance this minute/) });
		expect(log.listed).toBe(1);
		expect(reports()).toHaveLength(1);
	});

	it("through the real trigger sweep: two due triggers in one minute, one report, the other a recorded skip", async () => {
		for (const id of ["t-a", "t-b"]) {
			d1.exec(
				`INSERT INTO agent_triggers (id, user_id, agent_id, instance_id, name, type, action, enabled, schedule, config, next_run_at)
				 VALUES ('${id}', 'u1', 'agent-1', 'coder', '${id}', 'cron', '${PO_TRIAGE_ACTION}', 1, '17 * * * *', '{"dryRun":true}', '2026-10-12T01:17:00.000Z')`,
			);
		}
		const swept = await runDueTriggers(env, at("2026-10-12T01:17:30Z"));
		expect(swept.dispatched).toBeGreaterThanOrEqual(2);
		expect(reports()).toHaveLength(1);
		const events = d1.sqlite.prepare("SELECT status, message FROM agent_trigger_events WHERE trigger_id IN ('t-a','t-b') AND status != 'running'").all() as Array<{ status: string; message: string }>;
		expect(events.some((e) => /triage skipped — Another product-owner window/.test(e.message))).toBe(true);
	});
});

describe("dry run (#1027 rollout step 1)", () => {
	it("reports and digests, but writes nothing to GitHub and queues nothing", async () => {
		const { deps, log } = github();
		const r = await runPoTriage(env, { instance_id: "coder", user_id: "u1" }, {}, at("2026-10-12T01:17:00Z"), deps);
		expect(r).toMatchObject({ dryRun: true, counts: { queued: 0, wouldQueue: 1, commented: 0 } });
		expect(queued()).toHaveLength(0);
		expect(log.posted).toEqual([]);
		expect(log.started).toEqual([]);
		const items = JSON.parse(reports()[0].report).items as Array<{ number: number; action: string }>;
		expect(items.find((i) => i.number === 3)?.action).toBe("would_comment");
		expect(items.find((i) => i.number === 4)?.action).toBe("would_queue");
		expect(log.notified).toEqual(["Tennis Clubs: would queue 1, 1 waiting on you, 1 blocked, 1 needs detail (dry run)"]);
	});
});

describe("gates: nothing new is queued (#1027)", () => {
	const wake = async () => {
		const { deps } = github();
		return runPoTriage(env, { instance_id: "coder", user_id: "u1" }, { dryRun: false }, at("2026-10-12T01:17:00Z"), deps);
	};
	const held = async () => JSON.parse(reports()[0].report).items.find((i: { number: number }) => i.number === 4).action as string;

	it("for a paused instance — refused outright: no GitHub read, no comment, no queue, no report (#1028)", async () => {
		d1.exec("UPDATE agent_instances SET status = 'paused' WHERE id = 'coder'");
		const { deps, log } = github();
		const r = await runPoTriage(env, { instance_id: "coder", user_id: "u1" }, { dryRun: false }, at("2026-10-12T01:17:00Z"), deps);
		expect(r).toMatchObject({ skipped: true, reason: "The instance is paused, so product-owner triage does not run." });
		expect(log.listed).toBe(0);
		expect(log.posted).toEqual([]);
		expect(queued()).toHaveLength(0);
		expect(reports()).toHaveLength(0);
	});

	it("even when the trigger is dispatched by hand, a paused coder is refused before anything is read (#1028)", async () => {
		d1.exec("UPDATE agent_instances SET status = 'paused' WHERE id = 'coder'");
		const { deps, log } = github();
		// Dry-run too: a paused instance does not even report.
		expect(await runPoTriage(env, { instance_id: "coder", user_id: "u1" }, {}, at("2026-10-12T01:17:00Z"), deps)).toMatchObject({ skipped: true });
		expect(log.listed).toBe(0);
		d1.exec("UPDATE agent_instances SET status = 'active' WHERE id = 'coder'");
		expect(await runPoTriage(env, { instance_id: "coder", user_id: "u1" }, {}, at("2026-10-12T01:18:00Z"), deps)).toMatchObject({ skipped: false });
		expect(log.listed).toBe(1);
	});

	it("for an account over its daily budget", async () => {
		d1.exec("INSERT INTO account_budget_limits (user_id, token_ceiling) VALUES ('u1', 10)");
		d1.exec("INSERT INTO ai_usage (user_id, provider, model, kind, input_tokens, output_tokens) VALUES ('u1', 'anthropic', 'm', 'coding', 50, 50)");
		expect((await wake()) as { gate: string }).toMatchObject({ gate: expect.stringMatching(/budget/) });
		expect(queued()).toHaveLength(0);
	});

	it("for a repo whose coder is already running", async () => {
		d1.exec("INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('run-1', 'u1', 'coder', 'Work issue #99', 'running', 5, 1)");
		await wake();
		expect(queued()).toHaveLength(0);
		expect(await held()).toBe("held");
	});

	it("while the coder is waiting on the owner's answer", async () => {
		d1.exec("INSERT INTO mcp_input_requests (id, instance_id, user_id, endpoint, tool, message, schema_json, expires_at) VALUES ('q1', 'coder', 'u1', 'e', 't', 'Which?', '[]', '2099-01-01T00:00:00Z')");
		expect((await wake()) as { gate: string }).toMatchObject({ gate: expect.stringMatching(/waiting on your answer/) });
		expect(queued()).toHaveLength(0);
	});
});

describe("the switch (#1025 §1 slice)", () => {
	it("turning PO triage on creates one default trigger: hourly, never :00, Melbourne, dry run", async () => {
		const rows = d1.sqlite.prepare("SELECT schedule, config, enabled, next_run_at FROM agent_triggers WHERE instance_id = 'coder' AND action = ?").all(PO_TRIAGE_ACTION) as Array<{ schedule: string; config: string; enabled: number; next_run_at: string }>;
		expect(rows).toHaveLength(1);
		const minute = poTriageDefaultMinute("coder");
		expect(minute).toBeGreaterThanOrEqual(1);
		expect(minute).toBeLessThanOrEqual(59);
		expect(rows[0]).toMatchObject({ schedule: `${minute} * * * *`, enabled: 1 });
		expect(normalizeSchedule(rows[0].schedule)).toBe(rows[0].schedule);
		expect(JSON.parse(rows[0].config)).toEqual({ timezone: "Australia/Melbourne", dryRun: true });
		expect(rows[0].next_run_at).toBeTruthy();
		// Spread: not every instance lands on the same minute.
		expect(new Set(["a", "b", "c", "d", "e", "f"].map(poTriageDefaultMinute)).size).toBeGreaterThan(1);
	});

	it("turning the brain off disables every run_po_triage trigger; on again re-enables without a second one", async () => {
		await setCoderBrain(env, "coder", "u1", { enabled: false });
		const enabled = () => (d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_triggers WHERE instance_id = 'coder' AND action = ? AND enabled = 1").get(PO_TRIAGE_ACTION) as { n: number }).n;
		expect(enabled()).toBe(0);
		await setCoderBrain(env, "coder", "u1", { enabled: true, poEnabled: true });
		expect(enabled()).toBe(1);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_triggers WHERE instance_id = 'coder' AND action = ?").get(PO_TRIAGE_ACTION) as { n: number }).n).toBe(1);
	});

	it("PO triage cannot be on while the brain is off", async () => {
		await setCoderBrain(env, "coder", "u1", { enabled: false, poEnabled: true });
		expect(await readCoderBrain(env, "coder", "u1")).toEqual({ enabled: false, poEnabled: false });
	});
});
