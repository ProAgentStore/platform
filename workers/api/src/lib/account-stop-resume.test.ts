/**
 * #1318 — runs that stopped on `provider_credit` continue by themselves once the key works again. Real migrated schema; the
 * only fakes are the start (the Continue path itself is covered by loop-continue-routes tests) and the 4-token probe.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptKey } from "./crypto.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { AUTO_RESUME_WINDOW_MS, CLAIM_TTL_MS, type CreditResumeDeps, MAX_RESUME_ATTEMPTS, PER_OWNER_PER_MINUTE, resumeRecoveredCreditRuns, runCreditAutoResume } from "./account-stop-resume.js";
import { probeFailingKeys } from "./provider-hold-probe.js";
import { probeDelayMs, PROBE_GIVE_UP_MS, resumeDelayMs } from "./retry-policy.js";
import { classifyCodingFailure, DRIVER_RESUME_POLICY } from "./coding-failure.js";
import { getLoopRun } from "./agent-loop-store.js";
import { providerCredentialId } from "./provider-account-hold.js";
import type { Env } from "../types.js";

const KEK = "37".repeat(32);
const KEY = "sk-ant-8QAA-not-a-real-key";
const OTHER_KEY = "sk-ant-OLD0-not-a-real-key";
const H = 3_600_000;
const NOW = Date.parse("2026-10-23T08:00:00Z");

let d1: RealSchemaD1;
let env: Env;
let credId: string;
let started: Array<{ runId: string; instanceId: string }>;

const run = (id: string, over: Record<string, unknown> = {}) => {
	const r = { instance: "coder", status: "needs_human", stop: "provider_credit", startedAt: NOW - 6 * H, finishedAt: NOW - 5 * H, repo: "repo-1", ...over };
	const session = r.repo ? `sess-${id}` : null;
	if (r.repo) {
		d1.exec(`INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('${r.repo}', '${r.instance}', 'u1', '${r.repo}')`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, client_type, status) VALUES ('${session}', '${r.instance}', 'u1', '${r.repo}', 'claude', 'ended')`);
	}
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id) VALUES ('${id}', 'u1', '${r.instance}', 'Implement #${id}', '${r.status}', ${r.stop ? `'${r.stop}'` : "NULL"}, 20, ${r.startedAt}, ${r.finishedAt}, ${session ? `'${session}'` : "NULL"})`);
};
const hold = (credential: string, cleared: number | null, failedAt = NOW - 5 * H, failureClass = "provider_credit") =>
	providerCredentialId("anthropic", credential).then((id) => d1.exec(`INSERT OR REPLACE INTO provider_account_holds (user_id, provider, credential_id, failure_class, failed_at, cleared_at) VALUES ('u1', 'anthropic', '${id}', '${failureClass}', ${failedAt}, ${cleared === null ? "NULL" : cleared})`));
const row = (id: string) => d1.sqlite.prepare("SELECT auto_resume_state AS state, auto_resume_successor AS successor, auto_resume_attempts AS attempts, auto_resume_next_at AS next, auto_resume_note AS note, auto_resume_at AS at FROM agent_loop_runs WHERE run_id = ?").get(id) as { state: string | null; successor: string | null; attempts: number; next: number | null; note: string | null; at: number | null };
const events = (event?: string) => (d1.sqlite.prepare("SELECT event, message, context, instance_id FROM agent_events WHERE source = 'auto-resume' ORDER BY ts, rowid").all() as Array<{ event: string; message: string; context: string; instance_id: string | null }>).filter((e) => !event || e.event === event);
const deps = (over: Partial<CreditResumeDeps> = {}): CreditResumeDeps => ({
	now: () => NOW,
	start: async (_e, r) => {
		const runId = `succ-${r.runId}`;
		started.push({ runId: r.runId, instanceId: r.instanceId });
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('${runId}', 'u1', '${r.instanceId}', '${r.objective}', 'running', 20, ${NOW})`);
		return { ok: true, runId };
	},
	...over,
});

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	d1.exec(`UPDATE agents SET config = '${JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } })}' WHERE id = 'agent-1'`);
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
	const e = await encryptKey(KEY, KEK);
	await d1.DB.prepare("INSERT INTO user_api_keys(user_id,provider,account_id,key_ciphertext,dek_wrapped,iv) VALUES('u1','anthropic','',?1,?2,?3)").bind(e.ciphertext, e.dekWrapped, e.iv).run();
	credId = await providerCredentialId("anthropic", KEY);
	started = [];
});
afterEach(() => d1.close());

describe("a credit stop still does not replay in flight (#773) — only a later, separate continue happens", () => {
	it("classifies the credit message as provider_credit and keeps it non-resumable inside the run", () => {
		const f = classifyCodingFailure(new Error("Anthropic (400): Your credit balance is too low to access the Anthropic API."));
		expect(f.class).toBe("provider_credit");
		expect(DRIVER_RESUME_POLICY.provider_credit.resume).toBe(false);
		expect(DRIVER_RESUME_POLICY.provider_credit.why).toMatch(/continues it by itself/);
	});
	it("paces by documented numbers", () => {
		expect(PER_OWNER_PER_MINUTE).toBe(3);
		expect([1, 2, 3, 4, 9].map(probeDelayMs)).toEqual([5 * 60_000, 15 * 60_000, H, 6 * H, 6 * H]);
		expect([1, 2, 3, 20].map(resumeDelayMs)).toEqual([60_000, 120_000, 240_000, H]);
	});
});

describe("a failing → recovered key continues exactly the matching runs, once (#1318)", () => {
	it("continues each credit-stopped run once, records the successor, and a second pass changes nothing", async () => {
		await hold(KEY, NOW - H);
		run("r1", { repo: "repo-1" });
		run("r2", { repo: "repo-2" });
		const first = await resumeRecoveredCreditRuns(env, deps());
		expect(first).toMatchObject({ considered: 2, resumed: 2, deferred: 0, gaveUp: 0 });
		expect(started.map((s) => s.runId).sort()).toEqual(["r1", "r2"]);
		expect(row("r1")).toMatchObject({ state: "resumed", successor: "succ-r1" });
		const second = await resumeRecoveredCreditRuns(env, deps());
		expect(second.considered).toBe(0);
		expect(started).toHaveLength(2); // idempotent: one successor per stopped run
	});

	it("shows the platform's doing on the run: the stopped run names its successor, the successor names its origin", async () => {
		await hold(KEY, NOW - H);
		run("r1");
		await resumeRecoveredCreditRuns(env, deps());
		expect((await getLoopRun(env, "u1", "r1"))?.autoResume).toMatchObject({ state: "resumed", successorRunId: "succ-r1", attempts: 0 });
		expect((await getLoopRun(env, "u1", "succ-r1"))?.autoResumedFrom).toBe("r1");
	});

	it("writes one audit entry per resume (naming the key and the successor) and one summary per recovery", async () => {
		await hold(KEY, NOW - H);
		d1.exec("UPDATE user_api_keys SET key_hint = '8QAA' WHERE user_id = 'u1'");
		run("r1");
		run("r2", { repo: "repo-2" });
		await resumeRecoveredCreditRuns(env, deps());
		const per = events("credit_resume.resumed");
		expect(per).toHaveLength(2);
		// The key's real last four (#1344) — it used to print the first four hex of the credential's HASH, which no owner could match.
		expect(per[0].message).toMatch(/^auto-continued after key …8QAA recovered at 2026-10-23T07:00:00.000Z; successor succ-r1/);
		expect(per[0].message).not.toContain(credId.slice(0, 4));
		expect(per[0].instance_id).toBe("coder");
		expect(events("credit_resume.summary")).toHaveLength(1);
		expect(events("credit_resume.summary")[0].message).toMatch(/2 run\(s\) auto-continued, 0 deferred/);
		expect(JSON.stringify(events())).not.toContain(KEY); // an opaque fingerprint, never the key
	});

	it("does nothing while the key is still failing", async () => {
		await hold(KEY, null);
		run("r1");
		expect(await resumeRecoveredCreditRuns(env, deps())).toMatchObject({ resumed: 0, skipped: 1 });
		expect(started).toEqual([]);
		expect(row("r1").state).toBeNull();
	});

	it("does not continue a run that stopped AFTER the key recovered (it failed again; that is a new problem)", async () => {
		await hold(KEY, NOW - 6 * H);
		run("r1", { finishedAt: NOW - 5 * H });
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(0);
	});

	it("does not continue runs that stopped on a DIFFERENT key", async () => {
		await hold(OTHER_KEY, NOW - H); // the old key was funded; the instance now runs on KEY, which has no recovery
		run("r1");
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(0);
		expect(started).toEqual([]);
	});
});

describe("runs that must not be continued", () => {
	beforeEach(() => hold(KEY, NOW - H));
	const none = async () => expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(0);

	it("other stop reasons", async () => {
		run("a", { stop: "max_iterations", repo: "r-a" });
		run("b", { stop: "engine_limit", repo: "r-b" });
		run("c", { stop: "done", status: "completed", repo: "r-c" });
		await none();
	});
	it("a paused instance, and an archived one", async () => {
		run("r1");
		d1.exec("UPDATE agent_instances SET status = 'paused' WHERE id = 'coder'");
		await none();
		d1.exec("UPDATE agent_instances SET status = 'archived' WHERE id = 'coder'");
		await none();
		d1.exec("UPDATE agent_instances SET status = 'active' WHERE id = 'coder'");
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(1); // …and it is not lost: resumed once it is active again
	});
	it("a run the owner has already superseded on the same repo (a newer run, including one they cancelled)", async () => {
		run("r1");
		run("newer", { startedAt: NOW - 4 * H, finishedAt: NOW - 3 * H, stop: "cancelled", status: "cancelled" });
		await none();
	});
	it("…but a newer run on ANOTHER repo of the instance does not supersede it", async () => {
		run("r1", { repo: "repo-1" });
		run("elsewhere", { repo: "repo-2", stop: "done", status: "completed", startedAt: NOW - 4 * H, finishedAt: NOW - 3 * H });
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(1);
	});
	it("a run stopped outside the window (7 days by default; configurable)", async () => {
		run("old", { startedAt: NOW - AUTO_RESUME_WINDOW_MS - 2 * H, finishedAt: NOW - AUTO_RESUME_WINDOW_MS - H });
		await none();
		expect((await resumeRecoveredCreditRuns(env, deps({ windowMs: AUTO_RESUME_WINDOW_MS + 24 * H }))).resumed).toBe(1);
	});
	it("an instance that opted out, or an account that did", async () => {
		run("r1");
		d1.exec(`UPDATE agent_instances SET config = '{"autoResumeOnCredit":false}' WHERE id = 'coder'`);
		await none();
		d1.exec(`UPDATE agent_instances SET config = '{}' WHERE id = 'coder'`);
		d1.exec(`UPDATE users SET preferences = '{"coding":{"autoResumeOnCredit":false}}' WHERE id = 'u1'`);
		await none();
		d1.exec(`UPDATE users SET preferences = '{}' WHERE id = 'u1'`);
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(1); // opting back in (or never opting out) resumes it
	});
	it("an instance explicitly ON overrides nothing the account turned off — the account switch wins", async () => {
		run("r1");
		d1.exec(`UPDATE agent_instances SET config = '{"autoResumeOnCredit":true}' WHERE id = 'coder'`);
		d1.exec(`UPDATE users SET preferences = '{"coding":{"autoResumeOnCredit":false}}' WHERE id = 'u1'`);
		await none();
	});
	it("a run already claimed or continued (by a person or an earlier pass)", async () => {
		run("r1");
		d1.exec("UPDATE agent_loop_runs SET auto_resume_at = 1, auto_resume_state = 'resumed', auto_resume_successor = 'x' WHERE run_id = 'r1'");
		await none();
	});
});

describe("pacing and the repo lock (#1318)", () => {
	beforeEach(() => hold(KEY, NOW - H));

	it("continues at most 3 per owner per minute, counted from the claims, and the rest follow on later passes", async () => {
		for (let i = 1; i <= 5; i++) run(`r${i}`, { repo: `repo-${i}` });
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(3);
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(0); // same minute: a cron overlap cannot exceed it
		expect((await resumeRecoveredCreditRuns(env, deps({ now: () => NOW + 61_000 }))).resumed).toBe(2);
		expect(started).toHaveLength(5);
	});

	it("a held repo lock defers the run — not dropped: it keeps its place, is retried with backoff, then continues", async () => {
		run("r1");
		let busy = true;
		const d = (now: number) => deps({ now: () => now, start: async (e, r, u) => (busy ? { ok: false, reason: "busy", error: "another run holds this repo" } : deps().start!(e, r, u)) });
		expect(await resumeRecoveredCreditRuns(env, d(NOW))).toMatchObject({ deferred: 1, resumed: 0 });
		expect(row("r1")).toMatchObject({ state: "deferred", attempts: 1, next: NOW + 60_000, at: null });
		expect(row("r1").note).toMatch(/another run holds this repo/);
		expect(events("credit_resume.deferred")).toHaveLength(1);
		// Not due yet: untouched.
		expect((await resumeRecoveredCreditRuns(env, d(NOW + 30_000))).considered).toBe(0);
		// Due, still busy: deferred again with a longer wait, and no second log line.
		await resumeRecoveredCreditRuns(env, d(NOW + 61_000));
		expect(row("r1")).toMatchObject({ attempts: 2, next: NOW + 61_000 + 120_000 });
		expect(events("credit_resume.deferred")).toHaveLength(1);
		busy = false;
		expect((await resumeRecoveredCreditRuns(env, d(NOW + 61_000 + 121_000))).resumed).toBe(1);
		expect(row("r1")).toMatchObject({ state: "resumed", successor: "succ-r1" });
	});

	it("gives up — saying why — on a refusal waiting cannot fix, and after too many deferrals", async () => {
		run("a", { repo: "r-a" });
		run("b", { repo: "r-b" });
		const refuse = (reason: string) => deps({ start: async () => ({ ok: false, reason, error: `refused: ${reason}` }) });
		await resumeRecoveredCreditRuns(env, refuse("capability_missing"));
		expect(row("a")).toMatchObject({ state: "gave_up", note: "refused: capability_missing" }); // both: capability is not waitable
		expect(events("credit_resume.gave_up").length).toBeGreaterThanOrEqual(1);
		d1.exec(`UPDATE agent_loop_runs SET auto_resume_at = NULL, auto_resume_state = NULL, auto_resume_attempts = ${MAX_RESUME_ATTEMPTS - 1}, auto_resume_note = NULL WHERE run_id = 'b'`);
		await resumeRecoveredCreditRuns(env, deps({ start: async () => ({ ok: false, reason: "busy", error: "still busy" }) }));
		expect(row("b")).toMatchObject({ state: "gave_up", attempts: MAX_RESUME_ATTEMPTS });
	});

	it("a start that throws is a deferral, never a crash of the pass or a lost run", async () => {
		run("r1");
		await resumeRecoveredCreditRuns(env, deps({ start: async () => { throw new Error("db locked"); } }));
		expect(row("r1")).toMatchObject({ state: "deferred", attempts: 1 });
		expect(row("r1").note).toMatch(/db locked/);
	});

	it("releases a claim whose successor never started (a crash between the two writes) and retries it", async () => {
		run("r1");
		d1.exec(`UPDATE agent_loop_runs SET auto_resume_at = ${NOW - CLAIM_TTL_MS - 1}, auto_resume_state = 'claimed' WHERE run_id = 'r1'`);
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(1);
		expect(started).toHaveLength(1);
		// …but a fresh claim is a wake still running: left alone.
		run("r2", { repo: "repo-2" });
		d1.exec(`UPDATE agent_loop_runs SET auto_resume_at = ${NOW - 1000}, auto_resume_state = 'claimed' WHERE run_id = 'r2'`);
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(0);
	});
});

describe("keys that failed before holds were recorded (the 23 Oct set)", () => {
	const credit = (at: string) => d1.exec(`INSERT INTO error_log (id, user_id, source, message, level, repeat_count, context, last_context, created_at, last_seen_at) VALUES ('e1', 'u1', 'coding:session', 'coding run abcd1234 failed (provider_credit) at s6-decide after 3 steps: Your credit balance is too low to access the Anthropic API.', 'error', 1, '{"failureClass":"provider_credit"}', '{"failureClass":"provider_credit"}', '${at}', '${at}')`);
	const lastUsed = (at: string) => d1.exec(`UPDATE user_api_keys SET last_used_at = '${at}' WHERE user_id = 'u1'`);

	it("uses the account's recorded health when no hold exists: a success after the failure resumes the run", async () => {
		credit("2026-10-23 03:28:08");
		lastUsed("2026-10-23 07:25:25");
		run("r1", { finishedAt: Date.parse("2026-10-23T03:28:08Z") + 1000 });
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(1);
	});
	it("…and does not while the key has not succeeded since", async () => {
		credit("2026-10-23 03:28:08");
		run("r1", { finishedAt: Date.parse("2026-10-23T03:28:08Z") + 1000 });
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(0);
	});
});

describe("the one-time backfill on deploy (#1318)", () => {
	it("continues the currently credit-stopped runs once; running it again produces one successor per run", async () => {
		await hold(KEY, NOW - H);
		for (let i = 1; i <= 3; i++) run(`r${i}`, { repo: `repo-${i}` });
		const first = await runCreditAutoResume(env, deps());
		expect(first).toMatchObject({ resumed: 3, probed: 0 });
		expect(events("credit_resume.backfill")).toHaveLength(1);
		expect(events("credit_resume.backfill")[0].message).toMatch(/3 credit-stopped run\(s\) auto-continued/);
		expect(d1.sqlite.prepare("SELECT backfilled_at FROM credit_auto_resume_state").all()).toHaveLength(1);
		const again = await runCreditAutoResume(env, deps());
		expect(again.resumed).toBe(0);
		expect(events("credit_resume.backfill")).toHaveLength(1);
		expect(started).toHaveLength(3);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_loop_runs WHERE auto_resume_successor IS NOT NULL").get() as { n: number }).n).toBe(3);
	});
});

describe("probing a failing key (#1318)", () => {
	const holdRow = () => d1.sqlite.prepare("SELECT probe_attempts AS a, next_probe_at AS n FROM provider_account_holds").get() as { a: number; n: number | null };

	it("probes a failing key that has credit-stopped runs waiting, with 5m → 15m → 1h → 6h backoff", async () => {
		await hold(KEY, null);
		run("r1");
		let calls = 0;
		const probe = async () => { calls++; return false; };
		const at = (t: number) => ({ now: () => t, probe });
		expect(await probeFailingKeys(env, at(NOW))).toEqual({ probed: 1, recovered: 0 });
		expect(holdRow()).toEqual({ a: 1, n: NOW + 5 * 60_000 });
		expect((await probeFailingKeys(env, at(NOW + 60_000))).probed).toBe(0); // not due
		await probeFailingKeys(env, at(NOW + 6 * 60_000));
		expect(holdRow().a).toBe(2);
		expect(holdRow().n).toBe(NOW + 6 * 60_000 + 15 * 60_000);
		await probeFailingKeys(env, at(NOW + 22 * 60_000));
		expect(holdRow().n).toBe(NOW + 22 * 60_000 + H);
		await probeFailingKeys(env, at(NOW + 90 * 60_000));
		expect(holdRow().n).toBe(NOW + 90 * 60_000 + 6 * H);
		expect(calls).toBe(4);
	});

	it("never probes a key with no credit-stopped runs waiting on it", async () => {
		await hold(KEY, null);
		let calls = 0;
		await probeFailingKeys(env, { now: () => NOW, probe: async () => { calls++; return true; } });
		expect(calls).toBe(0);
		run("other", { stop: "max_iterations" });
		await probeFailingKeys(env, { now: () => NOW, probe: async () => { calls++; return true; } });
		expect(calls).toBe(0);
	});

	it("stops probing a key that has been failing for over 7 days, and ignores keys not failing for credit", async () => {
		await hold(KEY, null, NOW - PROBE_GIVE_UP_MS - H);
		run("r1");
		expect((await probeFailingKeys(env, { now: () => NOW, probe: async () => true })).probed).toBe(0);
	});

	it("a successful probe (which clears the hold, as any real call does) lets the same tick continue the run", async () => {
		await hold(KEY, null);
		run("r1");
		const probe = async () => { d1.exec(`UPDATE provider_account_holds SET cleared_at = ${NOW}`); return true; };
		const out = await runCreditAutoResume(env, deps({ probe }));
		expect(out).toMatchObject({ probed: 1, resumed: 1 });
		expect(row("r1")).toMatchObject({ state: "resumed" });
		expect(holdRow()).toEqual({ a: 0, n: null });
	});
});

describe("a refused key heals itself instead of pausing automatic runs forever (#1326)", () => {
	const holdRow = () => d1.sqlite.prepare("SELECT probe_attempts AS a, next_probe_at AS n, cleared_at AS c FROM provider_account_holds").get() as { a: number; n: number | null; c: number | null };

	it("files a 401/403 as provider_credentials, still not replayed inside the run", () => {
		const f = classifyCodingFailure(new Error("Anthropic (403): Request not allowed [permission_error; request-id req_011] — Anthropic API key ending in 8QAA was refused."));
		expect(f.class).toBe("provider_credentials");
		expect(DRIVER_RESUME_POLICY.provider_credentials.resume).toBe(false);
	});

	it("probes a refused key with NO stopped run waiting — the hold itself is what waits (the deadlock this fixes)", async () => {
		// The incident: the hold paused every automatic start, so no call was ever made that could clear it.
		await hold(KEY, null, NOW - 5 * H, "provider_credentials");
		const seen: string[] = [];
		const out = await probeFailingKeys(env, { now: () => NOW, probe: async (_e, _u, provider) => { seen.push(provider); return false; } });
		expect(out).toEqual({ probed: 1, recovered: 0 });
		expect(seen).toEqual(["anthropic"]);
		expect(holdRow()).toMatchObject({ a: 1, n: NOW + 5 * 60_000 });
	});

	it("does not probe a refused key whose owner has no active instance, nor one refused for over 7 days", async () => {
		await hold(KEY, null, NOW - PROBE_GIVE_UP_MS - H, "provider_credentials");
		expect((await probeFailingKeys(env, { now: () => NOW, probe: async () => true })).probed).toBe(0);
		await hold(KEY, null, NOW - H, "provider_credentials");
		d1.exec("UPDATE agent_instances SET status = 'paused'");
		expect((await probeFailingKeys(env, { now: () => NOW, probe: async () => true })).probed).toBe(0);
	});

	it("retires a hold on a key since REPLACED instead of probing it (the probe would spend the new key every minute)", async () => {
		await hold(OTHER_KEY, null, NOW - H, "provider_credentials");
		let calls = 0;
		expect((await probeFailingKeys(env, { now: () => NOW, probe: async () => { calls++; return true; } })).probed).toBe(0);
		expect(calls).toBe(0);
		expect(holdRow().c).toBe(NOW);
	});

	it("a passing probe clears the hold and the same tick continues the run that stopped on the refusal", async () => {
		await hold(KEY, null, NOW - 5 * H, "provider_credentials");
		run("r403", { stop: "provider_credentials" });
		const probe = async () => { d1.exec(`UPDATE provider_account_holds SET cleared_at = ${NOW}`); return true; };
		const out = await runCreditAutoResume(env, deps({ probe }));
		expect(out).toMatchObject({ probed: 1, resumed: 1 });
		expect(row("r403")).toMatchObject({ state: "resumed", successor: "succ-r403" });
		expect(holdRow()).toMatchObject({ a: 0, n: null, c: NOW });
	});

	it("does not continue a refused-key run while the key is still refused", async () => {
		await hold(KEY, null, NOW - 5 * H, "provider_credentials");
		run("r403", { stop: "provider_credentials" });
		expect((await runCreditAutoResume(env, deps({ probe: async () => false }))).resumed).toBe(0);
		expect(started).toEqual([]);
	});
});

describe("a hold's episode and model (#1344)", () => {
	const holdRow = () => d1.sqlite.prepare("SELECT probe_attempts AS a, next_probe_at AS n, cleared_at AS c FROM provider_account_holds").get() as { a: number; n: number | null; c: number | null };

	it("gives up 7 days after the FIRST refusal, though every failed probe rewrote failed_at", async () => {
		await hold(KEY, null, NOW - H, "provider_credentials");
		d1.exec(`UPDATE provider_account_holds SET first_failed_at = ${NOW - PROBE_GIVE_UP_MS - H}`);
		expect((await probeFailingKeys(env, { now: () => NOW, probe: async () => true })).probed).toBe(0);
	});

	it("probes on the model the refused request named", async () => {
		await hold(KEY, null, NOW - H, "provider_credentials");
		d1.exec("UPDATE provider_account_holds SET model = 'claude-haiku-5-5'");
		const models: Array<string | null | undefined> = [];
		await probeFailingKeys(env, { now: () => NOW, probe: async (_e, _u, _p, model) => { models.push(model); return false; } });
		expect(models).toEqual(["claude-haiku-5-5"]);
	});

	it("records every probe, with the provider's words when it is still refused", async () => {
		await hold(KEY, null, NOW - H, "provider_credentials");
		await probeFailingKeys(env, { now: () => NOW, probe: async () => ({ ok: false, error: "Anthropic (403): Request not allowed [permission_error; request-id req_9]" }) });
		const [e] = events("provider_hold.probe");
		expect(e.message).toMatch(/still refused \(attempt 1, next re-check .*\): Anthropic \(403\): Request not allowed \[permission_error; request-id req_9\]/);
		expect(holdRow().a).toBe(1);
	});
});

describe("observeProviderAccount keeps the episode's start and the refused model (#1344)", () => {
	it("a repeat failure keeps first_failed_at; a failure after the hold cleared opens a new episode", async () => {
		const { observeProviderAccount } = await import("./provider-account-observation.js");
		const row = () => d1.sqlite.prepare("SELECT failed_at AS f, first_failed_at AS ff, model AS m FROM provider_account_holds").get() as { f: number; ff: number; m: string | null };
		await observeProviderAccount(env, "u1", "anthropic", KEY, "provider_credentials", 1_000, "claude-sonnet-4-6");
		await observeProviderAccount(env, "u1", "anthropic", KEY, "provider_credentials", 5_000);
		expect(row()).toEqual({ f: 5_000, ff: 1_000, m: "claude-sonnet-4-6" });
		await observeProviderAccount(env, "u1", "anthropic", KEY, null, 6_000);
		await observeProviderAccount(env, "u1", "anthropic", KEY, "provider_credentials", 9_000, "claude-haiku-5-5");
		expect(row()).toEqual({ f: 9_000, ff: 9_000, m: "claude-haiku-5-5" });
	});
});

describe("a refused key the owner REPLACED continues the stopped run (#1362)", () => {
	const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

	it("the stored key is newer than the stop and the refused one was a different key: the run continues", async () => {
		await hold(OTHER_KEY, null, NOW - 5 * H, "provider_credentials"); // the refused key, still held
		d1.exec(`UPDATE user_api_keys SET created_at = '${sqlTime(NOW - H)}' WHERE user_id = 'u1'`); // KEY stored after the stop
		run("r1", { stop: "provider_credentials" });
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(1);
		expect(row("r1")).toMatchObject({ state: "resumed" });
	});

	it("…only for a REFUSED key: after a credit stop the remedy is a top-up, and the run waits for a key that worked (#1318)", async () => {
		await hold(OTHER_KEY, null, NOW - 5 * H); // a credit hold on the old key
		d1.exec(`UPDATE user_api_keys SET created_at = '${sqlTime(NOW - H)}' WHERE user_id = 'u1'`);
		run("r1");
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(0);
	});

	it("a key stored BEFORE the stop is the one that was refused: nothing continues until it works", async () => {
		await hold(OTHER_KEY, null, NOW - 5 * H, "provider_credentials");
		d1.exec(`UPDATE user_api_keys SET created_at = '${sqlTime(NOW - 9 * H)}' WHERE user_id = 'u1'`);
		run("r1", { stop: "provider_credentials" });
		expect((await resumeRecoveredCreditRuns(env, deps())).resumed).toBe(0);
	});

	it("a key that cannot be READ is unknown — its hold is left alone, never retired as if replaced", async () => {
		await hold(KEY, null, NOW - H, "provider_credentials");
		const unreadable = { DB: d1.DB } as unknown as Env; // no key-encryption key: the stored key cannot be decrypted
		let calls = 0;
		expect((await probeFailingKeys(unreadable, { now: () => NOW, probe: async () => { calls++; return true; } })).probed).toBe(0);
		expect(calls).toBe(0);
		expect(d1.sqlite.prepare("SELECT cleared_at AS c FROM provider_account_holds").get()).toEqual({ c: null });
	});

	it("a key that was REMOVED is a definite answer: its hold is retired", async () => {
		await hold(KEY, null, NOW - H, "provider_credentials");
		d1.exec("DELETE FROM user_api_keys WHERE user_id = 'u1'");
		await probeFailingKeys(env, { now: () => NOW, probe: async () => true });
		expect(d1.sqlite.prepare("SELECT cleared_at AS c FROM provider_account_holds").get()).toEqual({ c: NOW });
	});
});
