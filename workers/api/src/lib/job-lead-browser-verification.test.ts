/**
 * Browser verification of Gmail job leads (#1030), end to end over the real schema. Faked: only the
 * browser run (what starting one returns, and how it ends) and the Scout's DO, which is a small
 * in-memory record engine running the REAL `applyJobLeadBrowserVerification` route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionRecord } from "../agent-storage-types.js";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

type Run = { id: string; status: string; errorCode?: string | null; error?: string | null; result?: unknown };
const runs = new Map<string, Run>();
const started: Array<{ objective: string; requestId: string }> = [];
/** How the next start goes. */
let startAs: "running" | "offline" | "busy" = "running";

vi.mock("./local-browser/start.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./local-browser/start.js")>()),
	startLocalBrowserRun: async (_env: unknown, _inst: string, _uid: string, input: { objective: string; requestId: string }) => {
		started.push(input);
		if (startAs === "busy") return { kind: "at_capacity", error: "busy" };
		const run: Run = startAs === "offline"
			? { id: `run-${started.length}`, status: "failed", errorCode: "runner_offline", error: "No runner is connected." }
			: { id: `run-${started.length}`, status: "running" };
		runs.set(run.id, run);
		return { kind: "started", run };
	},
}));
/** Every push the dispatcher sends (#1031): what it says, where it links, which policy event decides it. */
const pushes = vi.hoisted(() => [] as Array<{ title: string; body: string; url: string; event?: string; kind?: string }>);
vi.mock("../routes/push.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../routes/push.js")>()),
	notifyUser: async (_env: unknown, _uid: string, _type: string, title: string, body: string, url: string, opts: { event?: string; kind?: string }) => {
		pushes.push({ title, body, url, event: opts.event, kind: opts.kind });
	},
}));
vi.mock("./local-browser/store.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./local-browser/store.js")>()),
	getLocalBrowserRun: async (_env: unknown, _inst: string, _uid: string, id: string) => runs.get(id) ?? null,
}));

const { applyJobLeadBrowserVerification } = await import("../agent-do-storage-routes.js");
const { MAX_ATTEMPTS, RETRY_BACKOFF_MS, listLeadVerifications, outcomeFromRun, runLeadBrowserVerification, verificationObjective, verifyLeadNow, enqueueBrowserVerification } = await import("./job-lead-browser-verification.js");
const { planJobLeadTriage, planBrowserVerificationOutcome } = await import("./job-lead-triage.js");

const CANONICAL = "https://au.indeed.com/viewjob?jk=0123456789abcdef";
let d1: RealSchemaD1;
let leads: Map<string, CollectionRecord>;
let env: Env;

beforeEach(async () => {
	runs.clear();
	pushes.length = 0;
	started.length = 0;
	startAs = "running";
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('scout', 'u1', 't1030-scout', 'Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{}}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('s1', 'scout', 'u1', 'active', '{"browserVerification":{"enabled":true}}')`);
	leads = new Map([["lead-1", { id: "lead-1", data: { status: "awaiting_browser_verification", lifecycle_version: 0, url: CANONICAL, title: "Platform Engineer", company: "Acme", verification: { state: "awaiting_browser_verification", canonical_job_url: CANONICAL, reason: "server_fetch_refused" } } } as unknown as CollectionRecord]]);
	const engine = {
		recordGet: async (_c: string, id: string) => leads.get(id) ?? null,
		recordUpdate: async (_c: string, id: string, patch: Record<string, unknown>) => {
			const r = leads.get(id);
			if (!r) return null;
			const next = { ...r, data: { ...r.data, ...patch } } as CollectionRecord;
			leads.set(id, next);
			return next;
		},
	};
	env = {
		DB: d1.DB,
		AGENT: {
			idFromName: (n: string) => n,
			get: () => ({ fetch: async (req: Request) => applyJobLeadBrowserVerification(engine as never, new URL(req.url).pathname.split("/")[2], req) }),
		},
	} as unknown as Env;
	await enqueueBrowserVerification(env, { instanceId: "s1", userId: "u1", leadId: "lead-1", workKey: "wk-1", canonicalUrl: CANONICAL, expectedTitle: "Platform Engineer", expectedCompany: "Acme", reason: "server_fetch_refused" }, 1_000);
});
afterEach(() => d1.close());

const lead = () => leads.get("lead-1")!.data as Record<string, unknown>;
const queue = async () => (await listLeadVerifications(env, "s1", "u1")).leads[0];
const finish = (id: string, outcome: string | null, status = "completed") =>
	runs.set(id, { id, status, result: outcome === null ? { findings: [], summary: "" } : { findings: [{ title: "x", url: CANONICAL, evidence: "", fields: { verification_outcome: outcome } }], summary: `found ${outcome}` } });

describe("what the browser is given and what it may answer (#1030)", () => {
	it("the objective carries the canonical job identity only — never an alert link — and the four typed outcomes", () => {
		const o = verificationObjective({ canonicalUrl: CANONICAL, expectedTitle: "Platform Engineer", expectedCompany: "Acme" });
		expect(o.match(/https?:\/\/\S+/g)?.every((u) => u.startsWith(CANONICAL))).toBe(true);
		for (const outcome of ["active", "expired", "mismatch", "temporarily_unverifiable"]) expect(o).toContain(outcome);
		expect(o).toMatch(/Do not apply, sign up, sign in or submit anything/);
	});

	it("reads only a single typed outcome; anything else is temporarily_unverifiable, never a guess", () => {
		finish("a", "active");
		expect(outcomeFromRun(runs.get("a") as never).outcome).toBe("active");
		finish("b", "open"); // not one of the four
		expect(outcomeFromRun(runs.get("b") as never).outcome).toBe("temporarily_unverifiable");
		finish("c", null);
		expect(outcomeFromRun(runs.get("c") as never).outcome).toBe("temporarily_unverifiable");
		runs.set("d", { id: "d", status: "completed", result: { findings: [{ fields: { verification_outcome: "active" } }, { fields: { verification_outcome: "expired" } }], summary: "" } });
		expect(outcomeFromRun(runs.get("d") as never)).toMatchObject({ outcome: "temporarily_unverifiable", detail: expect.stringMatching(/conflicting/) });
		expect(outcomeFromRun({ id: "e", status: "failed", errorCode: "runner_lost" } as never)).toMatchObject({ outcome: "temporarily_unverifiable" });
	});
});

describe("the dispatcher (#1030)", () => {
	it("dispatches the canonical posting, and an ACTIVE job becomes appliable — the only way to the Tailor", async () => {
		expect(await runLeadBrowserVerification(env, 2_000)).toEqual({ settled: 0, dispatched: 1 });
		expect(started[0]).toMatchObject({ requestId: "bv-lead-1-1" });
		expect(started[0].objective).toContain(CANONICAL);
		expect(await queue()).toMatchObject({ state: "dispatched", attempts: 1 });
		// Awaiting: an Apply is refused while it waits.
		expect(planJobLeadTriage(leads.get("lead-1")!, { action: "apply", sourceInstanceId: "s1" })).toMatchObject({ ok: false, error: expect.stringMatching(/waiting for browser verification/) });

		finish("run-1", "active");
		expect(await runLeadBrowserVerification(env, 3_000)).toEqual({ settled: 1, dispatched: 0 });
		expect(lead()).toMatchObject({ status: "new", lifecycle_version: 1, verification: { state: "live", checked_by: "browser_verification", attempts: 1 } });
		expect(await queue()).toMatchObject({ state: "active", lastOutcome: "active" });
		expect(planJobLeadTriage(leads.get("lead-1")!, { action: "apply", sourceInstanceId: "s1" })).toMatchObject({ ok: true });
		// The attempt receipt says what was dispatched and what came back.
		const [attempt] = (await listLeadVerifications(env, "s1", "u1")).attempts;
		expect(attempt).toMatchObject({ attempt: 1, runId: "run-1", state: "completed", outcome: "active" });
	});

	it("closes an expired or mismatched lead", async () => {
		for (const outcome of ["expired", "mismatch"] as const) {
			await d1.DB.prepare("UPDATE job_lead_browser_verifications SET state = 'awaiting', attempts = 0, next_attempt_at = 0").run();
			leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...lead(), status: "awaiting_browser_verification", lifecycle_version: 0 } } as CollectionRecord);
			started.length = 0;
			await runLeadBrowserVerification(env, 2_000);
			finish(`run-${started.length}`, outcome);
			await runLeadBrowserVerification(env, 3_000);
			expect(lead()).toMatchObject({ status: "archived", archive_reason: outcome === "expired" ? "job_expired" : "job_mismatch" });
			expect(await queue()).toMatchObject({ state: outcome });
		}
	});

	it("retries a transient failure with backoff, then gives up as unverifiable", async () => {
		let now = 2_000;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			await runLeadBrowserVerification(env, now);
			runs.set(`run-${attempt}`, { id: `run-${attempt}`, status: "failed", errorCode: "runner_lost" });
			await runLeadBrowserVerification(env, now + 1);
			if (attempt < MAX_ATTEMPTS) {
				expect(await queue()).toMatchObject({ state: "awaiting", attempts: attempt, lastOutcome: "temporarily_unverifiable" });
				expect(lead().status).toBe("awaiting_browser_verification");
				// Not due again until its backoff has passed.
				expect((await runLeadBrowserVerification(env, now + 2)).dispatched).toBe(0);
				now = now + 1 + RETRY_BACKOFF_MS[attempt - 1];
			}
		}
		expect(await queue()).toMatchObject({ state: "unverifiable", attempts: MAX_ATTEMPTS });
		expect(lead()).toMatchObject({ status: "unverifiable", verification: { state: "unverifiable", reason: "temporarily_unverifiable_exhausted" } });
	});

	it("verification turned off: the lead waits, nothing is dispatched", async () => {
		d1.exec(`UPDATE agent_instances SET config = '{"browserVerification":{"enabled":false}}' WHERE id = 's1'`);
		expect((await runLeadBrowserVerification(env, 2_000)).dispatched).toBe(0);
		expect(started).toEqual([]);
		expect(await queue()).toMatchObject({ state: "awaiting", lastDetail: expect.stringMatching(/Browser verification is off/) });
	});

	it("no eligible browser: fallback mark_unverifiable closes it at once; wait holds it until the limit", async () => {
		startAs = "offline";
		d1.exec(`UPDATE agent_instances SET config = '{"browserVerification":{"enabled":true,"fallback":"wait","waitLimitMinutes":10}}' WHERE id = 's1'`);
		await runLeadBrowserVerification(env, 2_000);
		expect(await queue()).toMatchObject({ state: "awaiting", lastDetail: expect.stringMatching(/Waiting \(fallback: wait\)/) });
		await runLeadBrowserVerification(env, 1_000 + 10 * 60_000);
		expect(await queue()).toMatchObject({ state: "unverifiable" });
		expect(lead().status).toBe("unverifiable");

		// mark_unverifiable, from a fresh lead
		leads.set("lead-2", { id: "lead-2", data: { status: "awaiting_browser_verification", lifecycle_version: 0, url: CANONICAL } } as unknown as CollectionRecord);
		d1.exec(`UPDATE agent_instances SET config = '{"browserVerification":{"enabled":true,"fallback":"mark_unverifiable"}}' WHERE id = 's1'`);
		await enqueueBrowserVerification(env, { instanceId: "s1", userId: "u1", leadId: "lead-2", workKey: null, canonicalUrl: CANONICAL, expectedTitle: null, expectedCompany: null, reason: "no_structured_posting" }, 5_000);
		await runLeadBrowserVerification(env, 1_000_000);
		expect((leads.get("lead-2")!.data as Record<string, unknown>).status).toBe("unverifiable");
	});

	it("a lead the owner moved on is never rewritten by a late outcome — the no-retry rule holds", async () => {
		await runLeadBrowserVerification(env, 2_000);
		// Meanwhile the owner archived it (or it reached the application flow with an uncertain submit).
		leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...lead(), status: "archived", lifecycle_version: 1 } } as CollectionRecord);
		finish("run-1", "active");
		await runLeadBrowserVerification(env, 3_000);
		expect(lead()).toMatchObject({ status: "archived", lifecycle_version: 1 });
		expect(await queue()).toMatchObject({ state: "superseded", lastOutcome: "active" });
	});

	it("the owner's verify-now dispatches a waiting lead at once, and refuses one that is not waiting", async () => {
		const out = await verifyLeadNow(env, "s1", "u1", "lead-1", 2_000);
		expect(out).toMatchObject({ state: "dispatched", lead: { state: "dispatched" } });
		expect(await verifyLeadNow(env, "s1", "u1", "lead-1", 2_001)).toMatchObject({ status: 409 });
		expect(await verifyLeadNow(env, "s1", "u1", "nope", 2_001)).toMatchObject({ status: 404 });
	});

	it("a busy browser leaves the lead waiting without spending an attempt", async () => {
		startAs = "busy";
		await runLeadBrowserVerification(env, 2_000);
		expect(await queue()).toMatchObject({ state: "awaiting", attempts: 0 });
	});
});

describe("planBrowserVerificationOutcome (#1030)", () => {
	const rec = (data: Record<string, unknown>) => ({ id: "l", data }) as unknown as CollectionRecord;
	const base = { attempt: 1, receiptId: "r1", exhausted: false };

	it("refuses an outcome on a lead that changed since the run started (compare-and-set)", () => {
		expect(planBrowserVerificationOutcome(rec({ status: "awaiting_browser_verification", lifecycle_version: 2 }), { ...base, outcome: "active", expectedVersion: 1 })).toMatchObject({ ok: false, stale: true });
	});

	it("a transient outcome records the attempt without moving the lead", () => {
		const plan = planBrowserVerificationOutcome(rec({ status: "awaiting_browser_verification", lifecycle_version: 0 }), { ...base, outcome: "temporarily_unverifiable" });
		expect(plan).toMatchObject({ ok: true, transitioned: false, to: "awaiting_browser_verification", patch: { verification: { attempts: 1, last_outcome: "temporarily_unverifiable" } } });
		expect((plan as { patch: Record<string, unknown> }).patch).not.toHaveProperty("status");
	});

	it("a lead in the application flow — where a submission may be uncertain — is never touched", () => {
		for (const status of ["apply_requested", "tailoring", "blocked"]) {
			expect(planBrowserVerificationOutcome(rec({ status, lifecycle_version: 3 }), { ...base, outcome: "expired" })).toEqual({ ok: true, transitioned: false, to: status, patch: null });
		}
	});
});

describe("the verdict is pushed once it is final — and as what it is (#1031)", () => {
	it("no eligible browser under mark_unverifiable: a failure push, though no run ever started", async () => {
		startAs = "offline";
		d1.exec(`UPDATE agent_instances SET config = '{"browserVerification":{"enabled":true,"fallback":"mark_unverifiable"}}' WHERE id = 's1'`);
		await runLeadBrowserVerification(env, 2_000);
		expect(await queue()).toMatchObject({ state: "unverifiable" });
		expect(pushes).toEqual([
			{
				title: expect.stringMatching(/could not verify a job/),
				body: expect.stringMatching(/“Platform Engineer” at Acme could not be verified — no eligible browser was available \(fallback: mark_unverifiable\)/),
				url: "/console/instances/s1/settings",
				event: "browser_verification_failed",
				kind: "alert",
			},
		]);
	});

	it("wait: nothing while it waits, one failure push when the limit closes it", async () => {
		startAs = "offline";
		d1.exec(`UPDATE agent_instances SET config = '{"browserVerification":{"enabled":true,"fallback":"wait","waitLimitMinutes":10}}' WHERE id = 's1'`);
		await runLeadBrowserVerification(env, 2_000);
		expect(pushes).toEqual([]);
		await runLeadBrowserVerification(env, 1_000 + 10 * 60_000);
		expect(pushes.map((p) => p.event)).toEqual(["browser_verification_failed"]);
	});

	it("a COMPLETED run that could not read the posting is not a completed verification: no push until the last attempt, then a failure", async () => {
		let now = 2_000;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			await runLeadBrowserVerification(env, now);
			finish(`run-${attempt}`, null); // completed, with no typed outcome
			await runLeadBrowserVerification(env, now + 1);
			if (attempt < MAX_ATTEMPTS) expect(pushes, `after attempt ${attempt}`).toEqual([]);
			now = now + 1 + RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length) - 1];
		}
		expect(pushes.map((p) => p.event)).toEqual(["browser_verification_failed"]);
		expect(pushes[0].body).toMatch(/could not be verified — 3 attempt\(s\) could not read the posting/);
	});

	it("a real verdict — open, closed or a different job — is a completion push", async () => {
		await runLeadBrowserVerification(env, 2_000);
		finish("run-1", "active");
		await runLeadBrowserVerification(env, 3_000);
		expect(pushes).toEqual([expect.objectContaining({ event: "browser_verification_completed", kind: "update", body: "“Platform Engineer” at Acme is open — ready to triage." })]);
	});

	it("never carries the posting URL", async () => {
		startAs = "offline";
		d1.exec(`UPDATE agent_instances SET config = '{"browserVerification":{"enabled":true,"fallback":"mark_unverifiable"}}' WHERE id = 's1'`);
		await runLeadBrowserVerification(env, 2_000);
		expect(JSON.stringify(pushes)).not.toMatch(/https?:|indeed/);
	});

	it("a lead the owner moved on is not pushed", async () => {
		await runLeadBrowserVerification(env, 2_000);
		leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...lead(), status: "archived", lifecycle_version: 5 } } as CollectionRecord);
		finish("run-1", "active");
		await runLeadBrowserVerification(env, 3_000);
		expect(await queue()).toMatchObject({ state: "superseded" });
		expect(pushes).toEqual([]);
	});
});
