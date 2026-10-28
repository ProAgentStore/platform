/**
 * #1384 — one definition of "who holds the checkout" and "what keeps a coder busy", on the real migrated schema.
 *
 * The live failure: a coder with auto-pickup on, an empty queue and open issues sat idle ~17 hours with no log row. A run parked on a question
 * (answered, never resumed) on a machine that was away counted as busy for ever; the idle check, the auto-pickup admission and the repo start
 * lock each spelled the rule out themselves, and the timer sweep skipped the coder with a bare `continue`. Invariants protected here: a run
 * stops holding once its machine has been away past PARKED_MACHINE_AWAY_MS and not before; a parked run on an online (or unknown) machine
 * still holds; the idle check, the admission and the start lock agree on the same fixtures; and every busy skip leaves a rate-limited row
 * naming the blocker. Fixtures only — no real instance is read or changed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitAutoPickup } from "./auto-pickup-admission.js";
import { BUSY_LOG_DEBOUNCE_MS, type AutoPickupDeps, runAutoPickup, setAutoPickup, sweepAutoPickup } from "./auto-pickup.js";
import { awayCutoffSeconds, CHECKOUT_WAKE_GRACE_MS, coderBlocker, PARKED_MACHINE_AWAY_MS } from "./checkout-hold.js";
import { repoFreeForRun, repoOwners } from "./coding-ownership.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { IssueSummary } from "./github-issues.js";
import { describeBusyHolder } from "./loop-busy.js";
import { createLoopRun } from "./agent-loop-store.js";
import { coderIsIdle } from "./po-triage-wake.js";
import type { Env } from "../types.js";

// The wall clock, fixed once: the start lock (`repoOwners`, `createLoopRun`) reads the clock itself, and every threshold here is minutes wide.
const NOW = Date.now();
const MIN = 60_000;
const AWAY = PARKED_MACHINE_AWAY_MS;

let d1: RealSchemaD1;
let env: Env;

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'coder', 'u1', 'app', 'acme/app')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status) VALUES ('s1', 'coder', 'r1', 'u1', 'claude', 'suspended')`);
	env = { DB: d1.DB } as unknown as Env;
	await setAutoPickup(env, "coder", "u1", { enabled: true });
});
afterEach(() => d1.close());

/** UTC `YYYY-MM-DD HH:MM:SS`, `ago` ms before NOW — the shape `last_seen_at` is stored in. */
const stamp = (ago: number) => new Date(NOW - ago).toISOString().replace("T", " ").slice(0, 19);

function machine(id: string, seenAgo: number) {
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id, last_seen_at) VALUES ('coder', 'u1', 'node-${id}', 'relay://x', '${id}', '${stamp(seenAgo)}')`);
}

interface RunOpts {
	released?: boolean;
	parked?: boolean;
	machineId?: string | null;
	answered?: boolean;
	wokenAgo?: number | null;
	session?: string;
}
/** A `running` run. `parked` = waiting on a question (`waiting_reason = 'decision'`); `answered` adds the owner's answer, not yet applied. */
function run(id: string, o: RunOpts = {}) {
	const parked = o.parked ?? false;
	d1.sqlite
		.prepare(
			`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, waiting_reason, parked_since, parked_machine_id, checkout_released_at, checkout_wake_at)
			 VALUES (?, 'u1', 'coder', 'x', 'running', 10, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(id, NOW - 10 * 60 * MIN, o.session ?? "s1", parked ? "decision" : null, parked ? NOW - 5 * 60 * MIN : null, o.machineId ?? null, o.released ? NOW - 5 * 60 * MIN : null, o.wokenAgo == null ? null : NOW - o.wokenAgo);
	if (parked) {
		d1.sqlite
			.prepare(
				`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, question, state, asked_at, expires_at, answered_at)
				 VALUES (?, 'coder', 'u1', ?, ?, ?, 'Which one?', ?, 2, 3, ?)`,
			)
			.run(`q-${id}`, o.session ?? "s1", id, `csess-${id}`, o.answered ? "answered_human" : "waiting_human", o.answered ? 4 : null);
	}
}

const idle = () => coderIsIdle(env, "coder", NOW);

describe("a parked run stops holding once its machine has been away (#1384)", () => {
	it("an UNRELEASED park on a machine unseen past the threshold does not make the coder busy", async () => {
		machine("m1", AWAY + MIN);
		run("parked", { parked: true, machineId: "m1" });
		expect(await idle()).toBe(true);
		expect(await coderBlocker(env, "coder", NOW)).toBeNull();
	});

	it("…but not before the threshold: a machine quiet for 20 minutes is still holding, and the blocker says it is going quiet", async () => {
		machine("m1", 20 * MIN);
		run("parked", { parked: true, machineId: "m1" });
		expect(await idle()).toBe(false);
		expect(await coderBlocker(env, "coder", NOW)).toMatchObject({ reason: "machine_away", runId: "parked" });
	});

	it("an unreleased park on an ONLINE machine still blocks — a dirty tree there is not ours to override", async () => {
		machine("m1", MIN);
		run("parked", { parked: true, machineId: "m1" });
		expect(await idle()).toBe(false);
		expect(await coderBlocker(env, "coder", NOW)).toMatchObject({ reason: "checkout_unreleased", runId: "parked" });
	});

	it("a park that recorded no machine still blocks: unknown is not away", async () => {
		run("parked", { parked: true, machineId: null });
		expect(await idle()).toBe(false);
	});

	it("a machine with no heartbeat on record at all counts as away", async () => {
		run("parked", { parked: true, machineId: "never-seen" });
		expect(await idle()).toBe(true);
	});

	it("a WORKING run that still carries the machine id of an earlier park is not mistaken for a parked one", async () => {
		// `parked_machine_id` is written at every park and not cleared on resume; `waiting_reason` is NULL once it is working again.
		machine("m1", AWAY * 10);
		run("resumed", { parked: false, machineId: "m1" });
		expect(await idle()).toBe(false);
		expect(await coderBlocker(env, "coder", NOW)).toMatchObject({ reason: "running_work", runId: "resumed" });
	});

	it("a run that is WORKING (not parked) always blocks, whatever its machine", async () => {
		machine("m1", AWAY * 10);
		run("working", { parked: false, machineId: "m1" });
		expect(await idle()).toBe(false);
		expect(await coderBlocker(env, "coder", NOW)).toMatchObject({ reason: "running_work", runId: "working" });
	});
});

describe("an answered run that released its checkout (#1384, after 7131d1e0)", () => {
	it("blocks while it is about to resume (never woken), and says why", async () => {
		machine("m1", MIN);
		run("answered", { parked: true, released: true, answered: true, machineId: "m1" });
		expect(await idle()).toBe(false);
		expect(await coderBlocker(env, "coder", NOW)).toMatchObject({ reason: "answer_unapplied", runId: "answered" });
	});

	it("stops blocking once a wake is past the grace", async () => {
		machine("m1", MIN);
		run("answered", { parked: true, released: true, answered: true, machineId: "m1", wokenAgo: CHECKOUT_WAKE_GRACE_MS + MIN });
		expect(await idle()).toBe(true);
	});

	it("stops blocking when the machine it parked on is away — nothing can resume it, so nothing is coming", async () => {
		machine("m1", AWAY + MIN);
		run("answered", { parked: true, released: true, answered: true, machineId: "m1" });
		expect(await idle()).toBe(true);
	});

	it("an UNANSWERED released run never blocked, and still does not", async () => {
		machine("m1", MIN);
		run("waiting", { parked: true, released: true, answered: false, machineId: "m1" });
		expect(await idle()).toBe(true);
	});
});

describe("the idle check, the auto-pickup admission and the start lock agree (#1384)", () => {
	const admit = () =>
		admitAutoPickup(env, { entryId: "objq-admit", instanceId: "coder", userId: "u1", repoId: "r1", repo: "acme/app", issue: 7, objective: "Implement GitHub issue #7", maxIterations: 30, detail: "issue #7", now: NOW, observedAdmission: 0 });

	interface Fixture {
		name: string;
		setup: () => void;
		/** coderIsIdle === admission. The start lock differs in ONE declared case, below. */
		idle: boolean;
		/** Whether a new run may take the repo. Differs from `idle` only for a run that released its checkout and is about to resume. */
		repoFree: boolean;
	}
	const fixtures: Fixture[] = [
		{ name: "nothing running", setup: () => undefined, idle: true, repoFree: true },
		{ name: "a working run", setup: () => run("r", {}), idle: false, repoFree: false },
		{ name: "a parked run, checkout held, machine online", setup: () => { machine("m", MIN); run("r", { parked: true, machineId: "m" }); }, idle: false, repoFree: false },
		{ name: "a parked run, checkout held, machine unknown", setup: () => run("r", { parked: true }), idle: false, repoFree: false },
		{ name: "a parked run, checkout held, machine away past the threshold", setup: () => { machine("m", AWAY + MIN); run("r", { parked: true, machineId: "m" }); }, idle: true, repoFree: true },
		{ name: "a released run, unanswered", setup: () => { machine("m", MIN); run("r", { parked: true, released: true, machineId: "m" }); }, idle: true, repoFree: true },
		{ name: "a released, answered run woken past the grace", setup: () => { machine("m", MIN); run("r", { parked: true, released: true, answered: true, machineId: "m", wokenAgo: CHECKOUT_WAKE_GRACE_MS + MIN }); }, idle: true, repoFree: true },
		{ name: "a released, answered run on a machine away past the threshold", setup: () => { machine("m", AWAY + MIN); run("r", { parked: true, released: true, answered: true, machineId: "m" }); }, idle: true, repoFree: true },
		// The one declared difference: a run that gave up its checkout and has its answer in is not an OWNER (a new run may take the repo,
		// and it will queue behind it to retake it), but it is still ABOUT TO RESUME, so the coder is not idle and auto-pickup waits for it.
		{ name: "a released, answered run about to resume", setup: () => { machine("m", MIN); run("r", { parked: true, released: true, answered: true, machineId: "m" }); }, idle: false, repoFree: true },
	];

	it.each(fixtures)("$name", async (f) => {
		f.setup();
		// Asked from ANOTHER session — the start lock only treats a run on a different session as in the way (its own session is `claimSessionDriver`'s to answer).
		const free = await repoFreeForRun(env, { instanceId: "coder", userId: "u1", repoId: "r1", sessionId: "s-new" }, async () => "unknown");
		expect({ idle: await idle(), admission: await admit(), repoFree: free.free }).toEqual({ idle: f.idle, admission: f.idle, repoFree: f.repoFree });
	});

	it("the atomic lock in createLoopRun agrees with repoOwners: an away-parked run does not stop a new run on its repo, a held one does", async () => {
		machine("m", AWAY + MIN);
		run("away", { parked: true, machineId: "m" });
		expect(await repoOwners(env, { instanceId: "coder", userId: "u1", repoId: "r1" }, NOW)).toEqual([]);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status) VALUES ('s2', 'coder', 'r1', 'u1', 'claude', 'active')`);
		const start = (id: string) => createLoopRun(env, { runId: id, userId: "u1", instanceId: "coder", objective: "Work issue #9", maxIterations: 5, startedAt: Date.now(), sessionId: "s2", exclusiveRepoId: "r1" });
		expect(await start("new-1")).toBe(true);
		// …and now that a run really holds the repo, the next start is refused by the same lock.
		expect(await start("new-2")).toBe(false);
		expect((await repoOwners(env, { instanceId: "coder", userId: "u1", repoId: "r1" }, Date.now())).map((o) => (o.kind === "run" ? o.runId : o.kind))).toEqual(["new-1"]);
	});

	it("an online-parked run holds the repo for the start lock and the atomic insert alike", async () => {
		machine("m", MIN);
		run("held", { parked: true, machineId: "m" });
		expect((await repoOwners(env, { instanceId: "coder", userId: "u1", repoId: "r1" }, NOW)).map((o) => (o.kind === "run" ? o.runId : o.kind))).toEqual(["held"]);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status) VALUES ('s2', 'coder', 'r1', 'u1', 'claude', 'active')`);
		// `createLoopRun` reads the wall clock for "away", so give the machine a heartbeat that is fresh NOW.
		d1.exec(`UPDATE instance_runtime_nodes SET last_seen_at = datetime('now')`);
		expect(await createLoopRun(env, { runId: "blocked", userId: "u1", instanceId: "coder", objective: "Work issue #9", maxIterations: 5, startedAt: Date.now(), sessionId: "s2", exclusiveRepoId: "r1" })).toBe(false);
	});

	it("describeBusyHolder names the held run and leaves out the away-parked one", async () => {
		machine("up", MIN);
		machine("gone", AWAY + MIN);
		run("held", { parked: true, machineId: "up" });
		run("away", { parked: true, machineId: "gone" });
		const holder = await describeBusyHolder(env, { userId: "u1", instanceId: "coder", repoId: "r1", now: NOW });
		expect(holder.activeRun?.runId).toBe("held");
		d1.exec("DELETE FROM agent_loop_runs WHERE run_id = 'held'");
		expect((await describeBusyHolder(env, { userId: "u1", instanceId: "coder", repoId: "r1", now: NOW })).activeRun).toBeNull();
	});

	it("awayCutoffSeconds is the cut-off the SQL compares against, in seconds", () => {
		expect(awayCutoffSeconds(NOW)).toBe(Math.floor((NOW - AWAY) / 1000));
	});
});

const open = (n: number): IssueSummary => ({ number: n, title: `issue ${n}`, state: "open", labels: [], assignees: [], comments: 0, updatedAt: "", url: `u/${n}` });
const deps = (issues: IssueSummary[] = [open(9)]): AutoPickupDeps => ({
	listOpenIssues: async () => ({ issues, unreadable: false }),
	postComment: async () => true,
	notify: async () => undefined,
	startQueued: async () => ({ drained: true, started: true, runId: "r", driver: "d" }),
});
const rows = () => d1.sqlite.prepare("SELECT outcome, detail, created_at FROM auto_pickup_log WHERE outcome = 'skipped_busy' ORDER BY created_at, rowid").all() as Array<{ outcome: string; detail: string; created_at: number }>;

describe("the live failure, as a regression (#1384)", () => {
	it("a released, answered, never-resumed run on an away machine with an empty queue no longer starves the coder: the picker starts the next issue", async () => {
		machine("mac-modem", 2 * 24 * 60 * MIN);
		run("f3f023de", { parked: true, released: true, answered: true, machineId: "mac-modem" });
		expect(await runAutoPickup(env, "coder", "u1", deps(), NOW)).toMatchObject({ started: true, issue: 9 });
		expect(rows()).toEqual([]);
	});

	it("the same run on an ONLINE machine still holds the coder until its wake is past the grace — and says so in the log", async () => {
		machine("mac-modem", MIN);
		run("f3f023de", { parked: true, released: true, answered: true, machineId: "mac-modem" });
		expect(await runAutoPickup(env, "coder", "u1", deps(), NOW)).toMatchObject({ started: false });
	});
});

describe("every busy skip leaves a rate-limited row naming the blocker (#1384)", () => {
	const sweepWith = async (at: number) => {
		const woken: string[] = [];
		await sweepAutoPickup(env, at, async (_e, iid) => void woken.push(iid) as unknown as string);
		return woken;
	};

	it("the sweep logs a skipped_busy row naming the run and the reason, and does not wake the coder", async () => {
		machine("m1", MIN);
		run("blocker", { parked: true, machineId: "m1" });
		expect(await sweepWith(NOW)).toEqual([]);
		expect(rows()).toHaveLength(1);
		expect(rows()[0].detail).toMatch(/^checkout_unreleased — run blocker: run blocker is parked on a question and still holds its checkout/);
	});

	it("writes the next row only after the window, while the blocker is unchanged", async () => {
		run("blocker", {});
		await sweepWith(NOW);
		await sweepWith(NOW + 5 * MIN);
		await sweepWith(NOW + BUSY_LOG_DEBOUNCE_MS - MIN);
		expect(rows()).toHaveLength(1);
		await sweepWith(NOW + BUSY_LOG_DEBOUNCE_MS + MIN);
		expect(rows()).toHaveLength(2);
		expect(rows().every((r) => r.detail.startsWith("running_work — run blocker:"))).toBe(true);
	});

	it("a CHANGED blocker is logged at once, inside the window", async () => {
		run("first", {});
		await sweepWith(NOW);
		d1.exec("UPDATE agent_loop_runs SET status = 'completed' WHERE run_id = 'first'");
		run("second", {});
		await sweepWith(NOW + MIN);
		expect(rows().map((r) => r.detail.split(":")[0])).toEqual(["running_work — run first", "running_work — run second"]);
	});

	it("a queued objective is named by its entry", async () => {
		d1.exec(`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at) VALUES ('objq-waiting', 'coder', 'r1', 'u1', 'x', 'pending', ${NOW})`);
		await sweepWith(NOW);
		expect(rows()[0].detail).toMatch(/^queued_work — entry objq-waiting: queue entry objq-waiting is waiting to start/);
	});

	it("the picker's own busy branch (a wake, not the sweep) logs the same named row", async () => {
		run("blocker", {});
		expect(await runAutoPickup(env, "coder", "u1", deps(), NOW)).toEqual({ started: false, reason: "the coder still has queued or running work" });
		expect(rows()[0].detail).toMatch(/^running_work — run blocker:/);
	});

	it("an idle coder is woken and writes no busy row", async () => {
		expect(await sweepWith(NOW)).toEqual(["coder"]);
		expect(rows()).toEqual([]);
	});

	it("a machine going quiet is named as such, with when it stops counting", async () => {
		machine("m1", 20 * MIN);
		run("blocker", { parked: true, machineId: "m1" });
		await sweepWith(NOW);
		expect(rows()[0].detail).toMatch(/^machine_away — run blocker: .*its machine was last seen 20 min ago and stops counting after 30 min unseen/);
	});
});
