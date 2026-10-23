/** #1315 invariants: one wake owns the issue and rolling allowance; queue/receipt either both
 * commit or neither does; a crash after that commit retries the same existing queue entry.
 * Real migration schema, no model/network/runner calls.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { admitAutoPickup, pendingAutoPickupAdmission, type AutoPickupAdmission } from "./auto-pickup-admission.js";
import { RESERVATION_TTL_MS, runAutoPickup, setAutoPickup, sweepAutoPickup, type AutoPickupDeps } from "./auto-pickup.js";
import type { Env } from "../types.js";
import { MAX_CONFIGURABLE_OBJECTIVE_CHARS } from "./loop-limits.js";

const issue = { number: 9, title: "An open issue", state: "open", labels: [], assignees: [], comments: 0, updatedAt: "", url: "u/9" };
const now = 1_800_000_000_000;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

describe("atomic auto-pickup admission (#1315)", () => {
	let d1: RealSchemaD1;
	let env: Env;
	const rows = (table: string) => d1.sqlite.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
	const admission = (over: Partial<AutoPickupAdmission> = {}): AutoPickupAdmission => ({ entryId: "objq-audit", instanceId: "coder", userId: "u1", repoId: "r1", repo: "acme/app", issue: 9, objective: "Implement GitHub issue #9", maxIterations: 30, detail: "issue #9", now, observedAdmission: Number((d1.sqlite.prepare("SELECT COALESCE(MAX(admission_id), 0) AS n FROM auto_pickup_admissions").get() as { n: number }).n), ...over });
	const deps = (over: AutoPickupDeps = {}): AutoPickupDeps => ({ listOpenIssues: async () => ({ issues: [issue], unreadable: false }), startQueued: async () => undefined, postComment: async () => true, notify: async () => undefined, ...over });

	beforeEach(async () => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
		d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'coder', 'u1', 'app', 'acme/app')");
		env = { DB: d1.DB } as unknown as Env;
		await setAutoPickup(env, "coder", "u1", { enabled: true, maxPerDay: 100 });
	});
	afterEach(() => d1.close());

	it("refuses an oversized objective intact before any allowance or queue write", async () => {
		await expect(admitAutoPickup(env, admission({ objective: "x".repeat(MAX_CONFIGURABLE_OBJECTIVE_CHARS + 1) }))).rejects.toThrow("nothing was queued");
		expect(rows("auto_pickup_admissions")).toEqual([]);
		expect(rows("instance_objective_queue")).toEqual([]);
		expect(rows("auto_pickup_log")).toEqual([]);
	});

	it("two wakes reading the same idle state queue one issue, consume one allowance and kick once", async () => {
		let readers = 0;
		const both = deferred();
		let kicks = 0;
		const options = deps({ listOpenIssues: async () => { if (++readers === 2) both.resolve(); await both.promise; return { issues: [issue], unreadable: false }; }, startQueued: async () => { kicks++; } });
		const result = await Promise.all([runAutoPickup(env, "coder", "u1", options, now), runAutoPickup(env, "coder", "u1", options, now)]);
		expect(result.filter((r) => r.started)).toHaveLength(1);
		expect(rows("instance_objective_queue")).toHaveLength(1);
		expect(rows("auto_pickup_admissions")).toHaveLength(1);
		expect(rows("auto_pickup_log").filter((r) => r.outcome === "started")).toHaveLength(1);
		expect(kicks).toBe(1);
	});

	it("rechecks the allowance after another wake finished: a stale cap read cannot admit a second issue", async () => {
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 1 });
		let readers = 0;
		const both = deferred();
		const second = deferred();
		const options = deps({ listOpenIssues: async () => { const n = ++readers; if (n === 2) both.resolve(); await both.promise; if (n === 2) await second.promise; return { issues: [{ ...issue, number: n }], unreadable: false }; } });
		const firstWake = runAutoPickup(env, "coder", "u1", options, now);
		const secondWake = runAutoPickup(env, "coder", "u1", options, now);
		expect(await firstWake).toMatchObject({ started: true, issue: 1 });
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled'"); // no busy row can explain the refusal
		second.resolve();
		expect(await secondWake).toMatchObject({ started: false });
		expect(rows("instance_objective_queue")).toHaveLength(1);
		expect(rows("auto_pickup_admissions")).toHaveLength(1);
		expect(rows("auto_pickup_log").filter((r) => r.outcome === "started")).toHaveLength(1);
	});

	it("a wake holding a stale GitHub list cannot repeat an issue another wake already finished", async () => {
		let readers = 0;
		const both = deferred();
		const second = deferred();
		const options = deps({ listOpenIssues: async () => { const n = ++readers; if (n === 2) both.resolve(); await both.promise; if (n === 2) await second.promise; return { issues: [issue], unreadable: false }; } });
		const firstWake = runAutoPickup(env, "coder", "u1", options, now);
		const secondWake = runAutoPickup(env, "coder", "u1", options, now);
		expect(await firstWake).toMatchObject({ started: true });
		d1.exec("UPDATE instance_objective_queue SET status = 'started'"); // its run already finished and closed the issue upstream
		second.resolve();
		expect(await secondWake).toMatchObject({ started: false });
		expect(rows("instance_objective_queue")).toHaveLength(1);
	});

	it("an objective being admitted remains in flight before its run row exists", async () => {
		expect(await admitAutoPickup(env, admission())).toBe(true);
		d1.exec("UPDATE instance_objective_queue SET status = 'running'");
		expect(await runAutoPickup(env, "coder", "u1", deps(), now)).toMatchObject({ started: false });
		expect(rows("instance_objective_queue")).toHaveLength(1);
		expect(await pendingAutoPickupAdmission(env, "coder", "u1", now)).toBeNull();
	});

	it("a failed receipt write rolls back the admission AND objective, leaving no orphan reservation", async () => {
		d1.sqlite.prepare("INSERT INTO auto_pickup_log(id,instance_id,user_id,outcome,created_at) VALUES ('objq-audit','coder','u1','error',?)").run(now);
		await expect(admitAutoPickup(env, admission())).rejects.toThrow(/UNIQUE/);
		expect(rows("auto_pickup_admissions")).toEqual([]);
		expect(rows("instance_objective_queue")).toEqual([]);
		expect(rows("auto_pickup_log")).toHaveLength(1);
	});

	it("a queue write failure also rolls back all admission state", async () => {
		d1.exec("INSERT INTO instance_objective_queue(id,instance_id,user_id,objective,status,created_at) VALUES ('objq-audit','elsewhere','u1','unrelated','cancelled',1)");
		await expect(admitAutoPickup(env, admission())).rejects.toThrow(/UNIQUE/);
		expect(rows("auto_pickup_admissions")).toEqual([]);
		expect(rows("auto_pickup_log")).toEqual([]);
		expect(rows("instance_objective_queue")).toHaveLength(1);
	});

	it("a crash after commit is recovered by the sweep using the same entry, even at the daily cap", async () => {
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 1 });
		d1.sqlite.prepare("INSERT INTO auto_pickup_log(id,instance_id,user_id,outcome,created_at) VALUES ('quiet','coder','u1','none_eligible',?)").run(now - 1);
		expect(await admitAutoPickup(env, admission())).toBe(true); // process died here, before its kick; the old idle-recheck delay must not strand it
		const kicks: string[] = [];
		const wake = async () => {
			const result = await runAutoPickup(env, "coder", "u1", deps({ startQueued: async (repoId) => { kicks.push(repoId); } }), now);
			expect(result).toMatchObject({ started: true, entryId: "objq-audit" });
			return "recovered";
		};
		expect(await sweepAutoPickup(env, now, wake)).toEqual({ woken: 1 });
		expect(kicks).toEqual(["r1"]);
		expect(rows("instance_objective_queue")).toHaveLength(1);
		expect(rows("auto_pickup_log").filter((r) => r.outcome === "started")).toHaveLength(1);
	});

	it("a published 0279 queued start is recovered at cap without creating a new admission", async () => {
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 1 });
		d1.sqlite.prepare("INSERT INTO instance_objective_queue(id,instance_id,repo_id,user_id,objective,metadata,status,created_at) VALUES ('legacy-q','coder','r1','u1','Implement issue #9',?,'pending',?)").run(JSON.stringify({ autoPickup: { repo: "acme/app", issue: 9 } }), now - 1);
		d1.sqlite.prepare("INSERT INTO auto_pickup_log(id,instance_id,user_id,repo,issue_number,outcome,created_at,reserved,entry_id) VALUES ('legacy-start','coder','u1','acme/app',9,'started',?,0,'legacy-q')").run(now - 2);
		d1.sqlite.prepare("INSERT INTO auto_pickup_log(id,instance_id,user_id,outcome,created_at) VALUES ('quiet','coder','u1','none_eligible',?)").run(now - 3);
		let kicks = 0;
		const wake = async () => {
			expect(await runAutoPickup(env, "coder", "u1", deps({ startQueued: async () => { kicks++; } }), now)).toMatchObject({ started: true, entryId: "legacy-q" });
			return "legacy recovered";
		};
		expect(await sweepAutoPickup(env, now, wake)).toEqual({ woken: 1 });
		expect(kicks).toBe(1);
		expect(rows("auto_pickup_admissions")).toEqual([]);
		expect(rows("instance_objective_queue")).toHaveLength(1);
		expect(rows("auto_pickup_log").filter((r) => r.outcome === "started")).toHaveLength(1);
	});

	it("an unexpired published lease blocks a new atomic wake even at cap 100", async () => {
		d1.sqlite.prepare("INSERT INTO auto_pickup_log(id,instance_id,user_id,repo,issue_number,outcome,created_at,reserved) VALUES ('old-live','coder','u1','acme/app',9,'started',?,1)").run(now - RESERVATION_TTL_MS + 1);
		expect(await runAutoPickup(env, "coder", "u1", deps({ listOpenIssues: async () => ({ issues: [{ ...issue, number: 42 }], unreadable: false }) }), now)).toMatchObject({ started: false });
		expect(rows("instance_objective_queue")).toEqual([]);
		expect(rows("auto_pickup_admissions")).toEqual([]);
		expect(rows("auto_pickup_log").filter((r) => r.outcome === "started")).toMatchObject([{ id: "old-live", reserved: 1 }]);
	});

	it("recovery honours timed deferrals and a newly paused instance", async () => {
		await admitAutoPickup(env, admission());
		d1.sqlite.prepare("UPDATE instance_objective_queue SET next_retry_at = ?").run(now + 60_000);
		expect(await pendingAutoPickupAdmission(env, "coder", "u1", now)).toBeNull();
		expect(await pendingAutoPickupAdmission(env, "coder", "u1", now + 60_000)).toMatchObject({ entryId: "objq-audit" });
		d1.exec("UPDATE agent_instances SET status = 'paused'");
		let kicked = false;
		expect(await runAutoPickup(env, "coder", "u1", deps({ startQueued: async () => { kicked = true; } }), now + 60_000)).toMatchObject({ started: false, reason: expect.stringMatching(/paused/) });
		expect(kicked).toBe(false);
		expect(rows("instance_objective_queue")).toHaveLength(1);
	});

	it("counts legacy starts, expires the rolling window exactly, and preserves maxPerDay 100", async () => {
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 2 });
		d1.sqlite.prepare("INSERT INTO auto_pickup_log(id,instance_id,user_id,outcome,created_at) VALUES ('legacy','coder','u1','started',?)").run(now - 1);
		d1.sqlite.prepare("INSERT INTO auto_pickup_log(id,instance_id,user_id,outcome,created_at) VALUES ('old','coder','u1','started',?)").run(now - 86_400_000);
		expect(await admitAutoPickup(env, admission())).toBe(true);
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled'");
		expect(await admitAutoPickup(env, admission({ entryId: "blocked" }))).toBe(false);
		expect(await admitAutoPickup(env, admission({ entryId: "tomorrow", now: now + 86_400_000 }))).toBe(true);
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled'");
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 100 });
		expect(await admitAutoPickup(env, admission({ entryId: "max100", now: now + 86_400_000 }))).toBe(true);
	});

	it("the SQL allowance reads numeric whole settings exactly as the settings normalizer does", async () => {
		for (let i = 0; i < 10; i++) d1.sqlite.prepare("INSERT INTO auto_pickup_log(id,instance_id,user_id,outcome,created_at) VALUES (?,'coder','u1','started',?)").run(`legacy-${i}`, now);
		for (const raw of ["100.0", "1.5", "true", '"100"', "101", "null"]) {
			d1.sqlite.prepare("UPDATE agent_instances SET config = ? WHERE id = 'coder'").run(`{"autoPickup":{"enabled":true,"maxPerDay":${raw}}}`);
			expect(await admitAutoPickup(env, admission({ entryId: `raw-${raw}` })), raw).toBe(raw === "100.0");
			d1.exec("UPDATE instance_objective_queue SET status = 'cancelled'");
		}
	});

	it("a provider hold arriving after preflight blocks the exact credential at the atomic admission", async () => {
		const account = { provider: "anthropic" as const, credentialId: "selected-credential-fingerprint" };
		d1.sqlite.prepare("INSERT INTO provider_account_holds(user_id,provider,credential_id,failure_class,failed_at) VALUES ('u1','anthropic',?,'provider_credit',?)").run(account.credentialId, now);
		expect(await admitAutoPickup(env, admission({ providerAccount: account }))).toBe(false);
		expect(rows("instance_objective_queue")).toEqual([]);
		expect(await admitAutoPickup(env, admission({ providerAccount: { ...account, credentialId: "replacement-credential" } }))).toBe(true);
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled'");
		d1.sqlite.prepare("UPDATE provider_account_holds SET cleared_at = ?").run(now + 1);
		expect(await admitAutoPickup(env, admission({ entryId: "after-verification", providerAccount: account }))).toBe(true);
	});

	it("historical provider-auth failures stop consuming the issue failure allowance after account recovery", async () => {
		for (let n = 1; n <= 2; n++) {
			d1.sqlite.prepare("INSERT INTO instance_objective_queue(id,instance_id,repo_id,user_id,objective,metadata,status,created_at) VALUES (?, 'coder','r1','u1','Implement issue #9',?, 'started', ?)").run(`old-q${n}`, JSON.stringify({ autoPickup: { repo: "acme/app", issue: 9 } }), now - n);
			d1.sqlite.prepare("INSERT INTO agent_loop_runs(run_id,user_id,instance_id,objective,status,max_iterations,started_at,queue_entry_id) VALUES (?, 'u1','coder','Implement issue #9','failed',30,?,?)").run(`auth-${n}`, now - n, `old-q${n}`);
			d1.sqlite.prepare("INSERT INTO error_log(id,user_id,source,message,context) VALUES (?, 'u1','coding:session','provider refused the credential',?)").run(`auth-log${n}`, JSON.stringify({ failureClass: "provider_credentials", [n === 1 ? "runId" : "traceId"]: `auth-${n}` }));
		}
		expect(await runAutoPickup(env, "coder", "u1", deps(), now)).toMatchObject({ started: true, issue: 9 });
	});

	it("rechecks owner settings at admission after a slow GitHub read", async () => {
		const result = await runAutoPickup(env, "coder", "u1", deps({ listOpenIssues: async () => { await setAutoPickup(env, "coder", "u1", { enabled: false }); return { issues: [issue], unreadable: false }; } }), now);
		expect(result).toMatchObject({ started: false });
		expect(rows("instance_objective_queue")).toEqual([]);
		expect(rows("auto_pickup_log").some((r) => r.outcome === "started")).toBe(false);
	});
});
