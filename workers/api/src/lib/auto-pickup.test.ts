/**
 * #1233 — brain-free auto-pickup: the deterministic picker (pure), and the wake on the real schema.
 * GitHub, the issue comment, the notification and the queue kick are the only fakes; there is no
 * model anywhere in this path, and the env below has no AI binding or key to call one with.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { AUTO_PICKUP_DEFAULTS, RESERVATION_TTL_MS, recoverReservations, type AutoPickupDeps, type PickCandidate, SKIP_LOG_DEBOUNCE_MS, autoPickupFrom, autoPickupPatchProblem, autoPickupStatus, pickNextIssue, priorityRank, recordWakeError, runAutoPickup, setAutoPickup, sweepAutoPickup, wakeIdleCoder } from "./auto-pickup.js";
import { paidTokensSince } from "./usage.js";
import { setCoderBrain } from "./coder-brain.js";
import type { IssueSummary } from "./github-issues.js";
import type { Env } from "../types.js";

const issue = (number: number, labels: string[] = [], assignees: string[] = []): IssueSummary => ({ number, title: `issue ${number}`, state: "open", labels, assignees, comments: 0, updatedAt: "", url: `u/${number}` });
const cand = (i: IssueSummary, over: Partial<PickCandidate> = {}): PickCandidate => ({ repo: "acme/app", repoId: "r1", issue: i, boardPosition: null, failures: 0, inFlight: false, ...over });
const pick = (cs: PickCandidate[], settings = AUTO_PICKUP_DEFAULTS) => {
	const v = pickNextIssue(cs, settings);
	return v.pick?.issue.number ?? null;
};

describe("the picker is deterministic and never random (#1233)", () => {
	it("a P1 bug beats an older P3, and P0 beats both", () => {
		expect(pick([cand(issue(3, ["P3"])), cand(issue(9, ["P1", "bug"]))])).toBe(9);
		expect(pick([cand(issue(3, ["P3"])), cand(issue(9, ["P1", "bug"])), cand(issue(12, ["P0"]))])).toBe(12);
	});

	it("matches labels like `P1: blocks external users`, and not `P10` as P1", () => {
		expect(priorityRank(["P1: blocks external users"], AUTO_PICKUP_DEFAULTS.priorityLabels)).toBe(1);
		expect(priorityRank(["p2 - nice"], AUTO_PICKUP_DEFAULTS.priorityLabels)).toBe(2);
		expect(priorityRank(["P10"], AUTO_PICKUP_DEFAULTS.priorityLabels)).toBe(4);
	});

	it("bug before unlabelled before enhancement, then board order, then oldest", () => {
		expect(pick([cand(issue(1, ["enhancement"])), cand(issue(2)), cand(issue(3, ["bug"]))])).toBe(3);
		expect(pick([cand(issue(1, ["enhancement"])), cand(issue(2))])).toBe(2);
		// Same rank: the card the owner placed first wins; an unplaced card comes after every placed one.
		expect(pick([cand(issue(1)), cand(issue(7), { boardPosition: 2 }), cand(issue(9), { boardPosition: 1 })])).toBe(9);
		// Same rank, nothing placed: the oldest (lowest number).
		expect(pick([cand(issue(8)), cand(issue(4)), cand(issue(6))])).toBe(4);
	});

	it("never picks needs-human, blocked, question, wontfix, an owner exclude label, a person's issue, one in flight, or one failed twice", () => {
		const out = [
			cand(issue(1, ["needs-human", "P0"])),
			cand(issue(2, ["blocked-on-serge", "P0"])),
			cand(issue(3, ["Blocked", "P0"])),
			cand(issue(4, ["question", "P0"])),
			cand(issue(5, ["wontfix", "P0"])),
			cand(issue(6, ["design", "P0"])),
			cand(issue(7, ["P0"], ["serge-ivo"])),
			cand(issue(8, ["P0"]), { inFlight: true }),
			cand(issue(9, ["P0"]), { failures: 2 }),
		];
		const settings = { ...AUTO_PICKUP_DEFAULTS, excludeLabels: ["design"] };
		expect(pickNextIssue(out, settings)).toMatchObject({ pick: null, reason: "none of the 9 open issue(s) qualifies" });
		// A bot assignee is not a person holding it, and one failure is not two.
		expect(pick([cand(issue(10, [], ["dependabot[bot]"]))])).toBe(10);
		expect(pick([cand(issue(11), { failures: 1 })])).toBe(11);
		expect(pickNextIssue([cand(issue(9), { failures: 2 })], settings).skippedFailed.map((c) => c.issue.number)).toEqual([9]);
	});

	it("an owner's priority labels replace the default order", () => {
		const settings = { ...AUTO_PICKUP_DEFAULTS, priorityLabels: ["urgent", "soon"] };
		expect(pick([cand(issue(1, ["P0"])), cand(issue(2, ["soon"])), cand(issue(3, ["urgent"]))], settings)).toBe(3);
	});

	it("settings are validated at the write and defaulted at the read", () => {
		expect(autoPickupFrom(null)).toEqual(AUTO_PICKUP_DEFAULTS);
		expect(autoPickupFrom({ autoPickup: { enabled: true, maxPerDay: 999 } })).toMatchObject({ enabled: true, maxPerDay: 10, maxIterations: 30 });
		expect(autoPickupFrom({ autoPickup: { enabled: true, maxPerDay: 100 } })).toMatchObject({ enabled: true, maxPerDay: 100 });
		expect(autoPickupPatchProblem({ enabled: "yes" })).toMatch(/true or false/);
		expect(autoPickupPatchProblem({ priorityLabels: Array.from({ length: 21 }, (_, i) => `L${i}`) })).toMatch(/at most 20/);
		expect(autoPickupPatchProblem({ maxPerDay: 100 })).toBeNull();
		expect(autoPickupPatchProblem({ maxPerDay: 101 })).toMatch(/1 to 100/);
		expect(autoPickupPatchProblem({ maxIterations: 0 })).toMatch(/1 to 100/);
		expect(autoPickupPatchProblem({ surprise: 1 })).toMatch(/Unknown/);
		expect(autoPickupPatchProblem({ enabled: true, excludeLabels: ["design"], maxPerDay: 3 })).toBeNull();
	});
});

describe("the wake, on the real schema (#1233)", () => {
	let d1: RealSchemaD1;
	let env: Env;
	let open: IssueSummary[];
	let log: { started: string[]; comments: number[]; notes: string[] };
	const deps = (): AutoPickupDeps => ({
		listOpenIssues: async () => ({ issues: open, unreadable: false }),
		postComment: async (_repo, n) => {
			log.comments.push(n);
			return true;
		},
		notify: async (_t, body) => void log.notes.push(body),
		startQueued: async (repoId) => void log.started.push(repoId),
	});
	const drain = () => d1.exec("UPDATE instance_objective_queue SET status = 'cancelled' WHERE status = 'pending'");
	const queued = () => d1.sqlite.prepare("SELECT objective, max_iterations, metadata FROM instance_objective_queue WHERE status = 'pending'").all() as Array<{ objective: string; max_iterations: number; metadata: string }>;

	beforeEach(async () => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'coder', 'u1', 'app', 'acme/app')`);
		env = { DB: d1.DB } as unknown as Env;
		open = [issue(3, ["P3"]), issue(9, ["P1", "bug"]), issue(1, ["needs-human", "P0"])];
		log = { started: [], comments: [], notes: [] };
		await setAutoPickup(env, "coder", "u1", { enabled: true });
	});
	afterEach(() => d1.close());

	it("an empty queue starts the highest-priority eligible issue: queued with its iterations, and kicked at once", async () => {
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: true, repo: "acme/app", issue: 9 });
		const [entry] = queued();
		expect(entry.objective).toMatch(/^Implement GitHub issue #9 in acme\/app: issue 9\. Read the issue and all its comments first\..*"closes #9"/);
		expect(entry.max_iterations).toBe(30);
		expect(JSON.parse(entry.metadata)).toEqual({ autoPickup: { repo: "acme/app", issue: 9 } });
		expect(log.started).toEqual(["r1"]);
		expect(await autoPickupStatus(env, "coder", "u1")).toMatchObject({ enabled: true, picker: "auto_pickup", last: { outcome: "started" } });
	});

	it("off is off, and a coder with work does not pick", async () => {
		await setAutoPickup(env, "coder", "u1", { enabled: false });
		expect(await runAutoPickup(env, "coder", "u1", deps())).toEqual({ started: false, reason: "auto-pickup is off for this instance" });
		await setAutoPickup(env, "coder", "u1", { enabled: true });
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('busy', 'u1', 'coder', 'x', 'running', 10, 1)`);
		expect(await runAutoPickup(env, "coder", "u1", deps())).toEqual({ started: false, reason: "the coder still has queued or running work" });
		expect(queued()).toEqual([]);
	});

	it("nothing eligible: the coder stays idle and the owner is told ONCE, not on every empty queue", async () => {
		open = [issue(1, ["needs-human"])];
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: false, reason: expect.stringMatching(/none of the 1 open issue/) });
		await runAutoPickup(env, "coder", "u1", deps());
		await runAutoPickup(env, "coder", "u1", deps());
		expect(log.notes).toHaveLength(1);
		expect(log.notes[0]).toMatch(/queue is empty/);
		// Once it has picked something again, a later empty spell is news again.
		open = [issue(5)];
		await runAutoPickup(env, "coder", "u1", deps());
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled'");
		open = [];
		await runAutoPickup(env, "coder", "u1", deps());
		expect(log.notes).toHaveLength(2);
	});

	it("an issue two auto-picked runs ended failed on is skipped, with ONE comment on it, and the next one starts", async () => {
		open = [issue(9, ["P1", "bug"]), issue(3, ["P3"])];
		for (const n of [1, 2]) {
			d1.exec(`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, metadata, status, created_at) VALUES ('q${n}', 'coder', 'r1', 'u1', 'Implement GitHub issue #9', '{"autoPickup":{"repo":"acme/app","issue":9}}', 'started', ${n})`);
			d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, queue_entry_id) VALUES ('f${n}', 'u1', 'coder', 'Implement GitHub issue #9', 'failed', 30, ${n}, 'q${n}')`);
		}
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: true, issue: 3 });
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled' WHERE status = 'pending'");
		await runAutoPickup(env, "coder", "u1", deps());
		expect(log.comments).toEqual([9]);
	});

	it("stops at the daily cap", async () => {
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 1 });
		await runAutoPickup(env, "coder", "u1", deps());
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled'");
		expect(await runAutoPickup(env, "coder", "u1", deps())).toEqual({ started: false, reason: "the daily cap of 1 auto-picked run(s) is reached" });
	});

	it("a paused instance picks nothing", async () => {
		d1.exec("UPDATE agent_instances SET status = 'paused' WHERE id = 'coder'");
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: false, reason: expect.stringMatching(/paused/) });
		expect(queued()).toEqual([]);
	});

	describe("overlapping wakes reserve before they enqueue (#1315)", () => {
		const startedRows = () => d1.sqlite.prepare("SELECT reserved, entry_id FROM auto_pickup_log WHERE outcome = 'started'").all() as Array<{ reserved: number; entry_id: string | null }>;
		const pendingFor = (iid: string) => d1.sqlite.prepare("SELECT id FROM instance_objective_queue WHERE instance_id = ? AND status = 'pending'").all(iid) as Array<{ id: string }>;

		it("two simultaneous wakes at maxPerDay 1 queue the issue once and spend the allowance once", async () => {
			open = [issue(9, ["P1"])];
			await setAutoPickup(env, "coder", "u1", { maxPerDay: 1 });
			const results = await Promise.all([runAutoPickup(env, "coder", "u1", deps()), runAutoPickup(env, "coder", "u1", deps())]);
			expect(results.filter((r) => r.started)).toHaveLength(1);
			expect(queued()).toHaveLength(1);
			expect(startedRows()).toEqual([{ reserved: 0, entry_id: expect.stringMatching(/^objq-/) }]);
			expect(log.started).toHaveLength(1);
			expect(results.find((r) => !r.started)).toMatchObject({ reason: expect.stringMatching(/reserved by another wake|daily cap|queued or running/) });
		});

		it("many overlapping wakes (the timer and terminal wakes together) still queue the issue once", async () => {
			open = [issue(9, ["P1"])];
			const results = await Promise.all(Array.from({ length: 6 }, () => runAutoPickup(env, "coder", "u1", deps())));
			expect(results.filter((r) => r.started)).toHaveLength(1);
			expect(queued()).toHaveLength(1);
			expect(startedRows()).toHaveLength(1);
		});

		it("the cap holds at its selected size under overlap, and a later wake after the queue drains stays capped", async () => {
			open = [issue(9, ["P1"])];
			await setAutoPickup(env, "coder", "u1", { maxPerDay: 2 });
			await Promise.all([runAutoPickup(env, "coder", "u1", deps()), runAutoPickup(env, "coder", "u1", deps())]);
			drain();
			await runAutoPickup(env, "coder", "u1", deps());
			drain();
			expect(startedRows()).toHaveLength(2);
			expect(await runAutoPickup(env, "coder", "u1", deps())).toEqual({ started: false, reason: "the daily cap of 2 auto-picked run(s) is reached" });
		});

		it("independent instances each start their own work in parallel", async () => {
			d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) SELECT 'coder2', agent_id, user_id, status, config FROM agent_instances WHERE id = 'coder'");
			d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r2', 'coder2', 'u1', 'app', 'acme/app')`);
			await setAutoPickup(env, "coder2", "u1", { enabled: true, maxPerDay: 1 });
			await setAutoPickup(env, "coder", "u1", { maxPerDay: 1 });
			open = [issue(9, ["P1"])];
			const results = await Promise.all([runAutoPickup(env, "coder", "u1", deps()), runAutoPickup(env, "coder2", "u1", deps()), runAutoPickup(env, "coder", "u1", deps()), runAutoPickup(env, "coder2", "u1", deps())]);
			expect(results.filter((r) => r.started)).toHaveLength(2);
			expect(pendingFor("coder")).toHaveLength(1);
			expect(pendingFor("coder2")).toHaveLength(1);
		});

		it("an enqueue that fails gives the allowance back, so a retry at cap 1 still starts", async () => {
			await setAutoPickup(env, "coder", "u1", { maxPerDay: 1 });
			open = [issue(9, ["P1"])];
			d1.exec("CREATE TRIGGER boom BEFORE INSERT ON instance_objective_queue BEGIN SELECT RAISE(ABORT, 'disk full'); END");
			expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: false, reason: expect.stringMatching(/auto-pickup failed.*disk full/) });
			expect(startedRows()).toEqual([]);
			d1.exec("DROP TRIGGER boom");
			expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: true, issue: 9 });
			expect(startedRows()).toHaveLength(1);
		});

		const orphan = (ageMs: number, now: number) =>
			d1.exec(`INSERT INTO auto_pickup_log (id, instance_id, user_id, repo, issue_number, outcome, detail, created_at, reserved) VALUES ('orph', 'coder', 'u1', 'acme/app', 9, 'started', 'issue #9', ${now - ageMs}, 1)`);

		it("a reservation a crash left before enqueueing is recovered without leaking the allowance", async () => {
			const now = Date.now();
			open = [issue(9, ["P1"])];
			await setAutoPickup(env, "coder", "u1", { maxPerDay: 1 });
			orphan(RESERVATION_TTL_MS + 1000, now);
			expect(await runAutoPickup(env, "coder", "u1", deps(), now)).toMatchObject({ started: true, issue: 9 });
			expect(queued()).toHaveLength(1);
			expect(startedRows()).toHaveLength(1);
		});

		it("a reservation a crash left AFTER enqueueing is linked to its entry, never queued twice", async () => {
			const now = Date.now();
			await runAutoPickup(env, "coder", "u1", deps(), now - RESERVATION_TTL_MS - 5000);
			const [entry] = queued();
			d1.exec("UPDATE auto_pickup_log SET reserved = 1, entry_id = NULL WHERE outcome = 'started'"); // the crash: queued, never confirmed
			expect(await recoverReservations(env, "coder", now)).toBe(1);
			expect(startedRows()).toEqual([{ reserved: 0, entry_id: expect.stringMatching(/^objq-/) }]);
			expect(queued()).toEqual([entry]);
			expect(queued()).toHaveLength(1);
		});

		it("a young reservation belongs to a wake still running: it blocks the issue and is left alone", async () => {
			const now = Date.now();
			open = [issue(9, ["P1"])];
			orphan(1000, now);
			expect(await recoverReservations(env, "coder", now)).toBe(0);
			const r = await runAutoPickup(env, "coder", "u1", deps(), now);
			expect(r.started).toBe(false);
			expect(queued()).toEqual([]);
			expect(startedRows()).toHaveLength(1);
		});

		it("queue ordering is unchanged: the next wake still picks by priority after the first drains", async () => {
			open = [issue(3, ["P3"]), issue(9, ["P1"])];
			await Promise.all([runAutoPickup(env, "coder", "u1", deps()), runAutoPickup(env, "coder", "u1", deps())]);
			expect(queued().map((q) => JSON.parse(q.metadata).autoPickup.issue)).toEqual([9]);
			drain();
			// Issue 9's run is over and still open (no human closed it), so it is a candidate again; priority still wins.
			expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: true, issue: 9 });
		});
	});

	describe("provider-credit and owner-action holds (#1314)", () => {
		const endRun = (id: string, entry: string, status: string, stopReason: string) =>
			d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, queue_entry_id) VALUES ('${id}', 'u1', 'coder', 'x', '${status}', '${stopReason}', 10, 1, '${entry}')`);

		it("a needs_human run counts toward the per-issue bound, but a provider_credit stop does not", async () => {
			await runAutoPickup(env, "coder", "u1", deps());
			const [{ id }] = d1.sqlite.prepare("SELECT id FROM instance_objective_queue").all() as Array<{ id: string }>;
			drain();
			endRun("r-credit", id, "needs_human", "provider_credit");
			endRun("r-credit2", id, "needs_human", "provider_credit");
			expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: true, issue: 9 });
			drain();
			endRun("r-human", id, "needs_human", "decision");
			endRun("r-human2", id, "needs_human", "escalated");
			// Issue 9 is now passed over (two owner-action stops); the next best is picked instead.
			expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: true, issue: 3 });
			expect(log.comments).toEqual([9]);
		});
	});

	it("an empty queue wakes ONE picker: triage when the brain's PO layer is on, auto-pickup otherwise", async () => {
		await setCoderBrain(env, "coder", "u1", { enabled: true, poEnabled: true });
		expect(await autoPickupStatus(env, "coder", "u1")).toMatchObject({ enabled: true, picker: "triage" });
		expect(await wakeIdleCoder(env, "coder", "u1")).toMatch(/^triage/);
		expect(queued().some((q) => q.metadata?.includes("autoPickup"))).toBe(false);
	});
});

describe("the token ceiling, skips and the timer (#1276)", () => {
	let d1: RealSchemaD1;
	let env: Env;
	const deps = (): AutoPickupDeps => ({ listOpenIssues: async () => ({ issues: [issue(9, ["P1"])], unreadable: false }), postComment: async () => true, notify: async () => undefined, startQueued: async () => undefined });
	const rows = () => d1.sqlite.prepare("SELECT outcome, detail FROM auto_pickup_log ORDER BY created_at, rowid").all() as Array<{ outcome: string; detail: string }>;
	const usage = (payer: string | null, input: number, output: number, cacheRead: number, cacheWrite = 0) =>
		d1.sqlite.prepare("INSERT INTO ai_usage (user_id, provider, model, kind, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, payer) VALUES ('u1', 'anthropic', 'm', 'coding', ?, ?, ?, ?, ?)").run(input, output, cacheRead, cacheWrite, payer);
	const busyRun = () => d1.exec("INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('busy', 'u1', 'coder', 'x', 'running', 10, 1)");

	beforeEach(async () => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'coder', 'u1', 'app', 'acme/app')`);
		d1.exec("INSERT INTO account_budget_limits (user_id, token_ceiling) VALUES ('u1', 1000)");
		env = { DB: d1.DB } as unknown as Env;
		await setAutoPickup(env, "coder", "u1", { enabled: true });
	});
	afterEach(() => d1.close());

	it("counts only paid tokens, and cache reads not at all", async () => {
		usage("subscription", 5_000, 5_000, 1_000_000);
		usage(null, 5_000, 5_000, 1_000_000);
		usage("byok-api", 100, 50, 900_000, 25);
		usage("platform", 10, 5, 0);
		expect(await paidTokensSince(env, "u1")).toBe(190);
	});

	it("an account showing billions of subscription tokens is NOT blocked when enforcement is off (the reported bug)", async () => {
		usage("subscription", 1_000_000, 1_000_000, 1_900_000_000);
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: true, issue: 9 });
	});

	it("even paid tokens over the ceiling only warn while enforcement is off, and the log says so", async () => {
		usage("byok-api", 2_000, 2_000, 0);
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: true });
		expect(rows().at(-1)?.detail).toMatch(/issue #9.*over the daily paid-token ceiling, which is not enforced/);
	});

	it("with enforcement ON, paid tokens over the ceiling block and the skip is logged with its reason; subscription tokens never block", async () => {
		(env as { BUDGET_ENFORCE?: string }).BUDGET_ENFORCE = "1";
		usage("byok-api", 2_000, 2_000, 0);
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: false, reason: expect.stringMatching(/daily budget is spent \(the daily paid-token ceiling\)/) });
		expect(rows()).toEqual([{ outcome: "skipped_gate", detail: expect.stringMatching(/paid-token ceiling/) }]);
		d1.exec("DELETE FROM ai_usage");
		usage("subscription", 9_000_000, 9_000_000, 9_000_000);
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: true });
	});

	it("every skip leaves a row: not idle, the gate, the daily cap, an error", async () => {
		busyRun();
		await runAutoPickup(env, "coder", "u1", deps());
		d1.exec("DELETE FROM agent_loop_runs");
		d1.exec("UPDATE agent_instances SET status = 'paused' WHERE id = 'coder'");
		await runAutoPickup(env, "coder", "u1", deps());
		d1.exec("UPDATE agent_instances SET status = 'active' WHERE id = 'coder'");
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 1 });
		await runAutoPickup(env, "coder", "u1", deps()); // starts #9
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled'");
		await runAutoPickup(env, "coder", "u1", deps()); // the cap
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 10 });
		const boom: AutoPickupDeps = {
			...deps(),
			listOpenIssues: async () => {
				throw new Error("GitHub is down");
			},
		};
		await runAutoPickup(env, "coder", "u1", boom);
		expect(rows().map((r) => r.outcome)).toEqual(["skipped_busy", "skipped_gate", "started", "capped", "error"]);
		expect(rows().at(-1)?.detail).toMatch(/GitHub is down/);
		expect(await autoPickupStatus(env, "coder", "u1")).toMatchObject({ last: { outcome: "error" } });
	});

	it("a repeated skip is written once an hour, not on every sweep", async () => {
		busyRun();
		const t0 = Date.now();
		await runAutoPickup(env, "coder", "u1", deps(), t0);
		await runAutoPickup(env, "coder", "u1", deps(), t0 + 60_000);
		expect(rows()).toHaveLength(1);
		await runAutoPickup(env, "coder", "u1", deps(), t0 + SKIP_LOG_DEBOUNCE_MS + 1);
		expect(rows()).toHaveLength(2);
	});

	it("auto-pickup off writes nothing; the sweeper's error is logged only for a coder with it on", async () => {
		await setAutoPickup(env, "coder", "u1", { enabled: false });
		await runAutoPickup(env, "coder", "u1", deps());
		await recordWakeError(env, "coder", "u1", new Error("drain failed"));
		expect(rows()).toEqual([]);
		await setAutoPickup(env, "coder", "u1", { enabled: true });
		await recordWakeError(env, "coder", "u1", new Error("drain failed"));
		expect(rows()).toEqual([{ outcome: "error", detail: "the wake failed: drain failed" }]);
	});

	it("the timer wakes idle coders with auto-pickup on, skips busy ones and ones that just found nothing, and survives a throwing wake", async () => {
		seedTenant(d1, { userId: "u1", instanceIds: ["busy", "quiet", "off"] });
		for (const id of ["busy", "quiet"]) await setAutoPickup(env, id, "u1", { enabled: true });
		d1.exec("INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('b', 'u1', 'busy', 'x', 'running', 10, 1)");
		const now = Date.now();
		d1.sqlite.prepare("INSERT INTO auto_pickup_log (id, instance_id, user_id, outcome, detail, created_at) VALUES ('n', 'quiet', 'u1', 'none_eligible', 'nothing', ?)").run(now - 60_000);
		const woken: string[] = [];
		const wake = async (_e: Env, iid: string) => {
			woken.push(iid);
			if (iid === "coder") throw new Error("kaboom");
			return "ok";
		};
		expect(await sweepAutoPickup(env, now, wake)).toEqual({ woken: 0 });
		expect(woken).toEqual(["coder"]);
		expect(rows().at(-1)).toMatchObject({ outcome: "error", detail: "the wake failed: kaboom" });
		// Once the recheck window has passed, the quiet coder is asked again.
		woken.length = 0;
		await sweepAutoPickup(env, now + 31 * 60_000, wake);
		expect(woken).toContain("quiet");
		expect(woken).not.toContain("busy");
		expect(woken).not.toContain("off");
	});
});
