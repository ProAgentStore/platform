import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../d1-sqlite.js";
import type { Env } from "../../types.js";
import { insertApplyRun, getApplyRun, type ApplyRun, type ApplyRunPolicy } from "./store.js";
import { notifyApplyInputRequired, reconcileApplyInputAttention } from "./input-attention.js";
import { syncApplyRun } from "./apply.js";
import { answerDecision } from "../owner-decisions.js";
import { applyRunSignals } from "../applications/run-signals.js";
import { attentionDeps } from "../applications/attention-deps.js";
import { checkConsoleLink } from "../../../../../store/console/src/lib/routes.js";

let d1: RealSchemaD1; let env: Env;
const NOW = Date.now();
const POLICY: ApplyRunPolicy = { engine: "codex", authMode: "auto", browserProfile: "isolated", mode: "fill_and_review", allowDomains: [], limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 }, gate: { allowed: false, gateId: null, checks: [] } };
beforeEach(() => {
	d1 = realSchemaD1(); seedTenant(d1, { userId: "u1", instanceIds: ["tailor", "runner"] });
	env = { DB: d1.DB, AGENT: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ ok: true }) }) } } as unknown as Env;
});
afterEach(() => d1.close());
const notifications = () => d1.sqlite.prepare("SELECT title,body,url,kind,dedupe_key FROM notifications ORDER BY rowid").all() as Array<Record<string, string>>;
async function fixture(status: "paused" | "blocked" = "blocked", reason = "missing_answer", appStatus = "blocked"): Promise<ApplyRun> {
	await env.DB.prepare("INSERT INTO job_applications(id,instance_id,user_id,source_instance_id,lead_id,lifecycle_version,idempotency_key,status,lead,block_reason,block_questions,fill_run_id,created_at,updated_at) VALUES('app-1','tailor','u1','scout','lead-1',1,'idem',?1,?2,?3,?4,'run-1',?5,?5)").bind(appStatus, JSON.stringify({ lead: { title: "Delivery Manager", company: "AFCA" } }), reason, JSON.stringify(["What is your notice period?"]), NOW).run();
	await insertApplyRun(env, { id: "run-1", instanceId: "runner", userId: "u1", applicationId: "app-1", requestId: "req", policy: POLICY, trace: [], now: NOW });
	const result = { runId: "run-1", outcome: "blocked", mode: "fill_and_review", blockReason: reason, questions: ["What is your notice period?"], engineAuth: "machine-login", filled: 15, uploaded: ["resume"], submitAttempted: false, traceId: "run-1" };
	await env.DB.prepare("UPDATE local_apply_runs SET status=?1,pause=?2,result=?3,started_at=?4,ended_at=?5 WHERE id='run-1'").bind(status, status === "paused" ? JSON.stringify({ reason, question: "What is your notice period?" }) : null, status === "blocked" ? JSON.stringify(result) : null, NOW, status === "blocked" ? NOW : null).run();
	return (await getApplyRun(env, "runner", "u1", "run-1"))!;
}

describe("Application Runner input-required attention", () => {
	it.each(["missing_answer", "screening_ambiguity"])("notifies a durable paused %s question without approving or resuming", async (reason) => {
		const run = await fixture("paused", reason);
		await notifyApplyInputRequired(env, "u1", run, NOW);
		expect(notifications()).toHaveLength(1);
		expect(notifications()[0]).toMatchObject({ kind: "alert", title: "Answers needed: Delivery Manager at AFCA" });
		expect(notifications()[0].body).toContain("What is your notice period?");
		expect(notifications()[0].url).toContain("application=app-1");
		expect(checkConsoleLink(notifications()[0].url).ok).toBe(true);
		expect(d1.sqlite.prepare("SELECT question,answer FROM owner_decisions").all()).toEqual([{ question: "What is your notice period?", answer: null }]);
		expect((await getApplyRun(env, "runner", "u1", run.id))?.status).toBe("paused");
		expect(d1.sqlite.prepare("SELECT submit_attempted_at FROM job_applications").get()).toEqual({ submit_attempted_at: null });
	});
	it("normal run reads recover an already-projected terminal block, and later reads never repeat it", async () => {
		const run = await fixture();
		await syncApplyRun(env, "u1", run, NOW);
		await syncApplyRun(env, "u1", run, NOW + 24 * 60 * 60_000);
		expect(notifications()).toHaveLength(1);
		expect((await getApplyRun(env, "runner", "u1", run.id))?.status).toBe("blocked");
	});
	it("normal reconciliation projects a durable result then requests input rather than approval", async () => {
		const run = await fixture("blocked", "missing_answer", "filling");
		await syncApplyRun(env, "u1", run, NOW);
		expect(d1.sqlite.prepare("SELECT status,block_reason FROM job_applications").get()).toEqual({ status: "blocked", block_reason: "missing_answer" });
		expect(notifications()).toHaveLength(1);
		expect(notifications()[0].title).toMatch(/^Answers needed:/);
	});
	it("retries a swallowed notification INSERT failure through the terminal reconciliation sweep", async () => {
		const run = await fixture();
		d1.exec("CREATE TRIGGER fail_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(FAIL, 'temporary failure'); END");
		await syncApplyRun(env, "u1", run, NOW);
		expect(notifications()).toHaveLength(0);
		d1.exec("DROP TRIGGER fail_notification");
		await reconcileApplyInputAttention(env, 25, NOW + 1_000);
		expect(notifications()).toHaveLength(1);
		await reconcileApplyInputAttention(env, 25, NOW + 2_000);
		expect(notifications()).toHaveLength(1);
	});
	it("overlapping calls claim one delivery and preserve sibling progress markers", async () => {
		const run = await fixture(); d1.exec("UPDATE local_apply_runs SET progress_stage='filling'");
		await Promise.all([notifyApplyInputRequired(env, "u1", run, NOW), notifyApplyInputRequired(env, "u1", run, NOW)]);
		expect(notifications()).toHaveLength(1);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS count FROM owner_decisions").get()).toEqual({ count: 1 });
		expect(d1.sqlite.prepare("SELECT progress_stage FROM local_apply_runs").get()).toEqual({ progress_stage: "filling" });
	});
	it("does not resurrect an answered question, superseded fill, or another owner's run", async () => {
		const run = await fixture();
		await answerDecision(env, { instanceId: "runner", userId: "u1", taskId: run.id, value: "Four weeks", via: "console", question: "What is your notice period?", create: { kind: "apply_run", subjectId: "app-1", scope: "app-1" }, now: NOW });
		await notifyApplyInputRequired(env, "u1", run, NOW);
		expect(notifications()).toHaveLength(0);
		d1.exec("DELETE FROM owner_decisions; UPDATE job_applications SET fill_run_id='new-run'");
		await notifyApplyInputRequired(env, "u1", run, NOW);
		await notifyApplyInputRequired(env, "another-owner", run, NOW);
		expect(notifications()).toHaveLength(0);
	});
	it("recovers an expired claim but cannot duplicate an existing durable notification receipt", async () => {
		const run = await fixture();
		const stuck = JSON.stringify({ kind: "input_attention", state: "leased", token: "old", key: "old", until: NOW - 1, checkedAt: NOW - 1 });
		await env.DB.prepare("UPDATE local_apply_runs SET input_attention=?1").bind(stuck).run();
		await notifyApplyInputRequired(env, "u1", run, NOW);
		await env.DB.prepare("UPDATE local_apply_runs SET input_attention=?1").bind(stuck).run();
		await notifyApplyInputRequired(env, "u1", run, NOW + 1);
		expect(notifications()).toHaveLength(1);
	});
	it("a thrown delivery does not leave a permanent claimed marker", async () => {
		const run = await fixture();
		await expect(notifyApplyInputRequired(env, "u1", run, NOW, { ...attentionDeps, notify: async () => { throw new Error("offline"); } })).rejects.toThrow();
		await notifyApplyInputRequired(env, "u1", run, NOW + 1);
		expect(notifications()).toHaveLength(1);
	});
	it("respects explicitly disabled channels without treating their absent row as a storage failure", async () => {
		const run = await fixture();
		await env.DB.prepare("UPDATE agent_instances SET config=?1 WHERE id='runner'").bind(JSON.stringify({ notifications: { rules: [{ event: "input_required", inapp: false, push: false }] } })).run();
		await notifyApplyInputRequired(env, "u1", run, NOW);
		await reconcileApplyInputAttention(env, 25, NOW + 1_000);
		expect(notifications()).toHaveLength(0);
		const row = d1.sqlite.prepare("SELECT input_attention FROM local_apply_runs").get() as { input_attention: string };
		expect(JSON.parse(row.input_attention).state).toBe("inapp_disabled");
	});
	it("notifies a changed question state once and bounds/redacts its notification preview", async () => {
		const run = await fixture();
		await notifyApplyInputRequired(env, "u1", run, NOW);
		const question = `Confirm token sk-abcdef1234567890xyz and ${"context ".repeat(100)}`;
		await env.DB.prepare("UPDATE job_applications SET block_questions=?1 WHERE id='app-1'").bind(JSON.stringify([question])).run();
		await notifyApplyInputRequired(env, "u1", run, NOW + 1);
		await notifyApplyInputRequired(env, "u1", run, NOW + 2);
		expect(notifications()).toHaveLength(2);
		expect(notifications()[1].body).not.toContain("sk-abcdef1234567890xyz");
		expect(notifications()[1].body).toContain("[redacted]");
		expect(notifications()[1].body.length).toBeLessThanOrEqual(500);
	});
	it("does not notify when the application has already advanced to review", async () => {
		const run = await fixture();
		d1.exec("UPDATE job_applications SET status='awaiting_review'");
		await notifyApplyInputRequired(env, "u1", run, NOW);
		await reconcileApplyInputAttention(env, 25, NOW);
		expect(notifications()).toHaveLength(0);
	});
	it.each(["answer", "replace", "resume", "questions"])("revalidates %s changes during the final preferences await before delivery", async (change) => {
		const run = await fixture(); let reads = 0;
		await notifyApplyInputRequired(env, "u1", run, NOW, { ...attentionDeps, preferences: async (...args) => {
			if (++reads === 2) {
				if (change === "answer") await answerDecision(env, { instanceId: "runner", userId: "u1", taskId: run.id, value: "Four weeks", via: "console", question: "What is your notice period?", now: NOW });
				if (change === "replace") d1.exec("UPDATE job_applications SET fill_run_id='new-run'");
				if (change === "resume") d1.exec("UPDATE local_apply_runs SET status='running'");
				if (change === "questions") d1.exec("UPDATE job_applications SET block_questions='[\"Another question?\"]'");
			}
			return attentionDeps.preferences!(...args);
		} });
		expect(reads).toBe(2);
		expect(notifications()).toHaveLength(0);
	});
	it("a stale consent signal cannot steal an input lease or duplicate push-only delivery", async () => {
		const run = await fixture(); let interleaved = false; let deliveries = 0;
		await env.DB.prepare("UPDATE agent_instances SET config=?1 WHERE id='runner'").bind(JSON.stringify({ notifications: { rules: [{ event: "input_required", inapp: false, push: true }] } })).run();
		const deps = { ...attentionDeps, notify: async () => { deliveries++; }, preferences: async () => {
			if (!interleaved) {
				interleaved = true;
				const stale = { ...run, status: "paused", pause: { reason: "consent_required" } } as ApplyRun;
				await applyRunSignals(env, "u1", stale, NOW, { ...attentionDeps, notify: async () => undefined });
				await notifyApplyInputRequired(env, "u1", run, NOW, deps);
			}
			return {};
		} };
		await notifyApplyInputRequired(env, "u1", run, NOW, deps);
		expect(deliveries).toBe(1);
		expect(notifications()).toHaveLength(0);
		expect(d1.sqlite.prepare("SELECT blocker_alerted FROM local_apply_runs").get()).toEqual({ blocker_alerted: "consent_required:" });
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS count FROM owner_decisions").get()).toEqual({ count: 1 });
	});
});
