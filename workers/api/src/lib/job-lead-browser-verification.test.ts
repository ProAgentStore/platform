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
const { MAX_ATTEMPTS, RETRY_BACKOFF_MS, listLeadVerifications, namesFromRun, outcomeFromRun, runLeadBrowserVerification, verificationObjective, verifyLeadNow } = await import("./job-lead-browser-verification.js");
const { enqueueBrowserVerification } = await import("./job-lead-queue.js");
const { planJobLeadTriage, planBrowserVerificationOutcome, cleanVerifiedName, nameGroundedIn } = await import("./job-lead-triage.js");
const { ingestGmailCandidates } = await import("./gmail-scout/scan.js");

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
	// The owner has allowed indeed.com for this Scout's browser (#1049): with no allowed-sites list, a site
	// is opened only after that durable decision. The consent flow itself is tested in its own describe.
	d1.exec(`INSERT INTO local_browser_domain_consent (instance_id, user_id, domain, scope, decision, decided_at) VALUES ('s1', 'u1', 'indeed.com', 'navigate', 'allow', 1)`);
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

describe("the Scout must declare a local browser, and may open only its allowed sites (#1048)", () => {
	it("an agent that declares no local browser dispatches nothing and the lead WAITS — even under mark_unverifiable", async () => {
		d1.exec(`UPDATE agents SET config = '{"capabilities":{"surfaces":[],"runtime":null,"tools":["gmail_search","gmail_read_message"]}}' WHERE id = 'scout'`);
		d1.exec(`UPDATE agent_instances SET config = '{"browserVerification":{"enabled":true,"fallback":"mark_unverifiable"}}' WHERE id = 's1'`);
		await runLeadBrowserVerification(env, 2_000);
		expect(started).toEqual([]);
		expect(await queue()).toMatchObject({ state: "awaiting", attempts: 0, lastDetail: expect.stringMatching(/does not declare a local browser/) });
		expect(lead().status).toBe("awaiting_browser_verification");
		expect((await listLeadVerifications(env, "s1", "u1")).attempts).toEqual([]);
		expect(pushes).toEqual([]);
	});

	it("a posting on an allowed site (indeed.com covers its country sites) is dispatched", async () => {
		d1.exec(`UPDATE agents SET config = '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{"allowDomains":["indeed.com"]}}}' WHERE id = 'scout'`);
		await runLeadBrowserVerification(env, 2_000);
		expect(started).toHaveLength(1);
		expect(await queue()).toMatchObject({ state: "dispatched" });
	});

	it("a posting outside the allowed sites is refused with a receipt and the reason, and never opened", async () => {
		d1.exec(`UPDATE agents SET config = '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{"allowDomains":["indeed.com"]}}}' WHERE id = 'scout'`);
		await d1.DB.prepare("UPDATE job_lead_browser_verifications SET canonical_url = 'https://www.indeed.co.uk/viewjob?jk=0123456789abcdef'").run();
		await runLeadBrowserVerification(env, 2_000);
		expect(started).toEqual([]);
		const { leads: [row], attempts } = await listLeadVerifications(env, "s1", "u1");
		expect(row).toMatchObject({ state: "unverifiable" });
		expect(attempts).toEqual([expect.objectContaining({ state: "refused", runId: null, detail: expect.stringMatching(/www\.indeed\.co\.uk is outside this Scout's allowed sites \(indeed\.com\)/) })]);
		expect(lead().status).toBe("unverifiable");
		expect(pushes.map((p) => p.event)).toEqual(["browser_verification_failed"]);
		expect(pushes[0].body).toMatch(/outside this Scout's allowed sites/);
	});
});

describe("the Scout's browser source policy is the instance's own (#1049)", () => {
	const SEEK = "https://www.seek.com.au/job/81234567";
	const LINKEDIN = "https://www.linkedin.com/jobs/view/4012345678";
	const setCanonical = (url: string) => d1.DB.prepare("UPDATE job_lead_browser_verifications SET canonical_url = ?1").bind(url).run();
	const setSites = (access: Record<string, unknown>) => d1.exec(`UPDATE agent_instances SET config = json_set(config, '$.localBrowser', json('${JSON.stringify({ access })}')) WHERE id = 's1'`);
	const takeovers = () => d1.sqlite.prepare("SELECT subject_kind, subject_id, reason, state FROM browser_takeovers WHERE instance_id = 's1'").all() as Array<Record<string, string>>;

	it("SEEK, with no allowed-sites list: the owner is asked once, durably; nothing opens until they allow it; then only an ACTIVE verdict reaches the Tailor", async () => {
		d1.exec(`DELETE FROM local_browser_domain_consent`);
		await setCanonical(SEEK);
		await runLeadBrowserVerification(env, 2_000);
		expect(started).toEqual([]);
		expect(await queue()).toMatchObject({ state: "awaiting", attempts: 0, lastDetail: expect.stringMatching(/allow or decline www\.seek\.com\.au/) });
		expect(takeovers()).toEqual([{ subject_kind: "manual", subject_id: "site-consent:www.seek.com.au", reason: "consent_required", state: "requested" }]);
		expect(pushes).toEqual([expect.objectContaining({ event: "takeover_required", body: expect.stringMatching(/Allow or decline www\.seek\.com\.au/) })]);
		// Asked once: a later tick does not ask again while the request is live.
		await runLeadBrowserVerification(env, 2_000 + 6 * 60_000);
		expect(pushes).toHaveLength(1);
		expect(started).toEqual([]);

		// The owner allows seek.com.au — a durable decision — and the next tick opens it and closes the request.
		d1.exec(`INSERT INTO local_browser_domain_consent (instance_id, user_id, domain, scope, decision, decided_at) VALUES ('s1', 'u1', 'seek.com.au', 'navigate', 'allow', 3)`);
		await runLeadBrowserVerification(env, 2_000 + 12 * 60_000);
		expect(started).toHaveLength(1);
		expect(started[0].objective).toContain(SEEK);
		expect(takeovers()[0].state).toBe("resumed");
		expect(lead().status).toBe("awaiting_browser_verification"); // not appliable while it is checked
		finish("run-1", "active");
		await runLeadBrowserVerification(env, 2_000 + 13 * 60_000);
		expect(lead()).toMatchObject({ status: "new", verification: { state: "live" } });
	});

	it("a site the owner declined is refused, with a receipt, and never opened", async () => {
		d1.exec(`DELETE FROM local_browser_domain_consent`);
		d1.exec(`INSERT INTO local_browser_domain_consent (instance_id, user_id, domain, scope, decision, decided_at) VALUES ('s1', 'u1', 'seek.com.au', 'navigate', 'deny', 1)`);
		await setCanonical(SEEK);
		await runLeadBrowserVerification(env, 2_000);
		expect(started).toEqual([]);
		const { leads: [row], attempts } = await listLeadVerifications(env, "s1", "u1");
		expect(row).toMatchObject({ state: "unverifiable" });
		expect(attempts).toEqual([expect.objectContaining({ state: "refused", detail: "You declined www.seek.com.au for this Scout's browser." })]);
	});

	it("unanswered past the wait limit, the lead is closed as unverifiable with the reason", async () => {
		d1.exec(`DELETE FROM local_browser_domain_consent`);
		d1.exec(`UPDATE agent_instances SET config = json_set(config, '$.browserVerification.waitLimitMinutes', 10) WHERE id = 's1'`);
		await setCanonical(SEEK);
		await runLeadBrowserVerification(env, 2_000);
		await runLeadBrowserVerification(env, 1_000 + 10 * 60_000);
		expect(await queue()).toMatchObject({ state: "unverifiable" });
		expect(pushes.at(-1)).toMatchObject({ event: "browser_verification_failed", body: expect.stringMatching(/www\.seek\.com\.au was not allowed in time/) });
	});

	it("LinkedIn on the instance's own allowed-sites list opens without asking; Indeed, outside it, is refused", async () => {
		d1.exec(`DELETE FROM local_browser_domain_consent`);
		setSites({ allowDomains: ["linkedin.com"] });
		await setCanonical(LINKEDIN);
		await runLeadBrowserVerification(env, 2_000);
		expect(started).toHaveLength(1);
		expect(takeovers()).toEqual([]);

		await d1.DB.prepare("UPDATE job_lead_browser_verifications SET state = 'awaiting', attempts = 0, next_attempt_at = 0, canonical_url = ?1").bind(CANONICAL).run();
		await runLeadBrowserVerification(env, 3_000);
		expect(started).toHaveLength(1);
		expect((await listLeadVerifications(env, "s1", "u1")).attempts[0]).toMatchObject({ state: "refused", detail: "au.indeed.com is outside this Scout's allowed sites (linkedin.com)." });
	});

	it("a denied host is refused even when the owner had allowed it — denial wins", async () => {
		d1.exec(`INSERT INTO local_browser_domain_consent (instance_id, user_id, domain, scope, decision, decided_at) VALUES ('s1', 'u1', 'linkedin.com', 'navigate', 'allow', 1)`);
		setSites({ denyDomains: ["linkedin.com"] });
		await setCanonical(LINKEDIN);
		await runLeadBrowserVerification(env, 2_000);
		expect(started).toEqual([]);
		expect((await listLeadVerifications(env, "s1", "u1")).attempts[0]).toMatchObject({ state: "refused", detail: "www.linkedin.com is on this Scout's denied sites." });
		expect(lead().status).toBe("unverifiable");
	});

	it("Indeed with the owner's standing decision is dispatched as before", async () => {
		await runLeadBrowserVerification(env, 2_000);
		expect(started).toHaveLength(1);
		expect(takeovers()).toEqual([]);
	});

	it("saved settings that no longer fit the agent open nothing — the lead waits and says why (fail closed)", async () => {
		d1.exec(`UPDATE agents SET config = '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{"allowDomains":["indeed.com"]}}}' WHERE id = 'scout'`);
		setSites({ allowDomains: ["seek.com.au"] });
		await runLeadBrowserVerification(env, 2_000);
		expect(started).toEqual([]);
		expect(await queue()).toMatchObject({ state: "awaiting", lastDetail: expect.stringMatching(/no longer fit this agent/) });
	});
});

describe("#1050: a LinkedIn Gmail alert reaches the owner's per-site consent with its canonical posting only", () => {
	const LI = "https://www.linkedin.com/jobs/view/4012345678";
	const link = "https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=SECRETTRACK&amp;midToken=SECRETMID&amp;otpToken=SECRETOTP";
	const message = { id: "m-li", threadId: "t", from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", to: "", cc: "", subject: "Platform Engineer at Acme", date: new Date().toUTCString(), messageId: "", references: "", snippet: "Platform Engineer Acme Sydney", text: `<a href="${link}">Platform Engineer</a> Acme`, attachments: [] };
	const takeovers = () => d1.sqlite.prepare("SELECT subject_id, reason, state FROM browser_takeovers WHERE instance_id = 's1'").all() as Array<Record<string, string>>;

	it("asks once for www.linkedin.com, opens nothing until allowed, then hands only an ACTIVE posting to the Tailor", async () => {
		d1.exec("DELETE FROM local_browser_domain_consent");
		d1.exec("DELETE FROM job_lead_browser_verifications");
		leads.clear();
		// The scan's own ingest, with LinkedIn answering the server with its sign-in wall.
		const wall = (async () => new Response(null, { status: 302, headers: { location: "https://www.linkedin.com/authwall" } })) as unknown as typeof fetch;
		const { awaiting } = await ingestGmailCandidates({
			hits: [{ id: "m-li" }],
			readMessage: async () => message as never,
			existing: [],
			insertLead: async (data) => {
				leads.set("lead-li", { id: "lead-li", data } as unknown as CollectionRecord);
				return { created: true, id: "lead-li" };
			},
			fetchImpl: wall,
		});
		// …and the scan's own queueing of what it could not check (scan.ts, #1030).
		for (const a of awaiting) await enqueueBrowserVerification(env, { instanceId: "s1", userId: "u1", leadId: a.leadId, workKey: a.workKey, canonicalUrl: a.canonicalUrl, expectedTitle: a.title, expectedCompany: a.company, reason: a.reason }, 1_000);
		const li = () => leads.get("lead-li")!.data as Record<string, unknown>;
		expect(li()).toMatchObject({ url: LI, status: "awaiting_browser_verification" });

		await runLeadBrowserVerification(env, 2_000);
		expect(started).toEqual([]);
		expect(takeovers()).toEqual([{ subject_id: "site-consent:www.linkedin.com", reason: "consent_required", state: "requested" }]);
		// Not appliable while it waits: the final-application gates are untouched.
		expect(planJobLeadTriage(leads.get("lead-li")!, { action: "apply", sourceInstanceId: "s1" })).toMatchObject({ ok: false });

		d1.exec("INSERT INTO local_browser_domain_consent (instance_id, user_id, domain, scope, decision, decided_at) VALUES ('s1', 'u1', 'linkedin.com', 'navigate', 'allow', 3)");
		await runLeadBrowserVerification(env, 2_000 + 6 * 60_000);
		expect(started).toHaveLength(1);
		expect(started[0].objective.match(/https?:\/\/\S+/g)?.every((u) => u.startsWith(LI))).toBe(true);
		runs.set("run-1", { id: "run-1", status: "completed", result: { findings: [{ title: "x", url: LI, evidence: "", fields: { verification_outcome: "active" } }], summary: "active" } });
		await runLeadBrowserVerification(env, 2_000 + 7 * 60_000);
		expect(li()).toMatchObject({ status: "new", verification: { state: "live" } });

		const written = JSON.stringify({
			lead: li(),
			started,
			queue: d1.sqlite.prepare("SELECT * FROM job_lead_browser_verifications").all(),
			attempts: d1.sqlite.prepare("SELECT * FROM job_lead_browser_verification_attempts").all(),
			takeovers: takeovers(),
			pushes,
		});
		expect(written).not.toMatch(/SECRET|trackingId|midToken|otpToken/);
	});
});

describe("a lead closed only for site consent is recovered once the site is allowed (#1235)", () => {
	// The live case: an owner-selected SEEK lead waited for consent; at the wait limit it became terminal
	// `unverifiable` with a refused receipt and no run, and "Verify now" refused it for not being `awaiting`.
	const SEEK = "https://www.seek.com.au/job/81234567";
	const allowSeek = () => d1.exec(`INSERT INTO local_browser_domain_consent (instance_id, user_id, domain, scope, decision, decided_at) VALUES ('s1', 'u1', 'seek.com.au', 'navigate', 'allow', 5)`);
	const row = () => d1.sqlite.prepare("SELECT state, closed_reason, attempts, awaiting_since FROM job_lead_browser_verifications WHERE lead_id = 'lead-1'").get() as Record<string, unknown>;
	/** Wait out the consent window unanswered, as the Coles lead did. */
	async function closeForConsent() {
		d1.exec(`DELETE FROM local_browser_domain_consent`);
		d1.exec(`UPDATE agent_instances SET config = json_set(config, '$.browserVerification.waitLimitMinutes', 10) WHERE id = 's1'`);
		await d1.DB.prepare("UPDATE job_lead_browser_verifications SET canonical_url = ?1").bind(SEEK).run();
		leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...lead(), intake: { kind: "owner_selected", receipt_id: "intake-rcpt-1" } } } as CollectionRecord);
		await runLeadBrowserVerification(env, 2_000);
		await runLeadBrowserVerification(env, 1_000 + 10 * 60_000);
	}

	it("the consent-only closure is marked as such; nothing was dispatched", async () => {
		await closeForConsent();
		expect(row()).toMatchObject({ state: "unverifiable", closed_reason: "consent_expired", attempts: 0 });
		expect(lead()).toMatchObject({ status: "unverifiable", verification: { reason: "temporarily_unverifiable_exhausted", attempts: 0 } });
		expect(started).toEqual([]);
		expect(await queue()).toMatchObject({ closedReason: "consent_expired" });
	});

	it("before the site is allowed, Verify now says what to do and changes nothing", async () => {
		await closeForConsent();
		const out = await verifyLeadNow(env, "s1", "u1", "lead-1", 2_000 + 20 * 60_000);
		expect(out).toEqual({ error: expect.stringMatching(/www\.seek\.com\.au is not allowed yet — allow it in Settings → Local browser research \(or set_local_browser_consent\)/), status: 409 });
		expect(row()).toMatchObject({ state: "unverifiable", closed_reason: "consent_expired" });
		expect(lead().status).toBe("unverifiable");
	});

	it("once allowed: Verify now reopens it — fresh wait, same lead, same intake receipt — and dispatches the check", async () => {
		await closeForConsent();
		allowSeek();
		const now = 2_000 + 30 * 60_000;
		const out = await verifyLeadNow(env, "s1", "u1", "lead-1", now);
		expect(out).toMatchObject({ state: "dispatched", lead: { state: "dispatched", closedReason: null, attempts: 1 } });
		expect(started).toEqual([expect.objectContaining({ requestId: "bv-lead-1-1" })]);
		expect(row()).toMatchObject({ closed_reason: null, awaiting_since: now });
		// The lead itself: back to awaiting through one versioned lifecycle step, its intake receipt untouched.
		expect(lead()).toMatchObject({ status: "awaiting_browser_verification", lifecycle_version: 2, intake: { kind: "owner_selected", receipt_id: "intake-rcpt-1" }, verification: { reason: "consent_granted" } });
		expect((lead().lifecycle as Array<{ action: string }>).map((e) => e.action)).toEqual(["browser_verification", "consent_reopen"]);
		// And it verifies like any other lead.
		finish("run-1", "active");
		await runLeadBrowserVerification(env, now + 60_000);
		expect(lead()).toMatchObject({ status: "new", verification: { state: "live" } });
	});

	it("idempotent: the DO's reopen of the same receipt twice transitions once", async () => {
		await closeForConsent();
		allowSeek();
		const receipt = (await listLeadVerifications(env, "s1", "u1")).attempts.find((a) => a.state === "refused")!.id;
		const reopen = () => applyJobLeadBrowserVerification({ recordGet: async () => leads.get("lead-1")!, recordUpdate: async (_c: string, _id: string, patch: Record<string, unknown>) => {
			leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...lead(), ...patch } } as CollectionRecord);
			return leads.get("lead-1")!;
		} } as never, "lead-1", new Request("https://agent/x", { method: "POST", body: JSON.stringify({ reopen: true, receipt_id: receipt }) }));
		expect(await (await reopen()).json()).toMatchObject({ transitioned: true, status: "awaiting_browser_verification" });
		expect(await (await reopen()).json()).toMatchObject({ transitioned: false, status: "awaiting_browser_verification" });
		expect(lead().lifecycle_version).toBe(2);
	});

	it("a lead with an application is never reopened — an attempted or uncertain application is never replayed", async () => {
		await closeForConsent();
		allowSeek();
		leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...lead(), application_id: "app-1", application_status: "submit_uncertain" } } as CollectionRecord);
		const out = await verifyLeadNow(env, "s1", "u1", "lead-1", 2_000 + 30 * 60_000);
		expect(out).toEqual({ error: expect.stringMatching(/an application exists for it, and an application is never replayed/), status: 409 });
		expect(started).toEqual([]);
		expect(row()).toMatchObject({ state: "unverifiable", closed_reason: "consent_expired" });
		expect(lead().status).toBe("unverifiable");
	});

	it("runner, network and policy closures stay closed: no runtime under mark_unverifiable, a declined site, an exhausted check", async () => {
		// No eligible browser, fallback mark_unverifiable.
		d1.exec(`UPDATE agent_instances SET config = json_set(config, '$.browserVerification.fallback', 'mark_unverifiable') WHERE id = 's1'`);
		startAs = "offline";
		await runLeadBrowserVerification(env, 2_000);
		expect(row()).toMatchObject({ state: "unverifiable", closed_reason: null });
		expect(await verifyLeadNow(env, "s1", "u1", "lead-1", 3_000)).toMatchObject({ status: 409, error: expect.stringMatching(/only a waiting one can be started now/) });

		// A site the owner declined.
		d1.exec(`DELETE FROM local_browser_domain_consent`);
		d1.exec(`INSERT INTO local_browser_domain_consent (instance_id, user_id, domain, scope, decision, decided_at) VALUES ('s1', 'u1', 'seek.com.au', 'navigate', 'deny', 1)`);
		await d1.DB.prepare("UPDATE job_lead_browser_verifications SET state = 'awaiting', attempts = 0, next_attempt_at = 0, canonical_url = ?1").bind(SEEK).run();
		leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...lead(), status: "awaiting_browser_verification" } } as CollectionRecord);
		await runLeadBrowserVerification(env, 4_000);
		expect(row()).toMatchObject({ state: "unverifiable", closed_reason: null });
	});

	it("a consent-expired row whose lead WAS checked in a browser is not reopened", async () => {
		await closeForConsent();
		allowSeek();
		// A dispatched attempt on record contradicts "never opened": refuse rather than replay.
		await d1.DB.prepare("INSERT INTO job_lead_browser_verification_attempts (id, instance_id, user_id, lead_id, attempt, run_id, state, created_at) VALUES ('x', 's1', 'u1', 'lead-1', 1, 'run-x', 'dispatched', 1)").run();
		expect(await verifyLeadNow(env, "s1", "u1", "lead-1", 2_000 + 30 * 60_000)).toEqual({ error: "A browser run was already made for this lead, so it is not reopened.", status: 409 });
		expect(lead().status).toBe("unverifiable");
	});
});

describe("migration 0266 marks the leads already closed only for consent (#1235)", () => {
	it("the backfill marks an unattempted consent closure, and nothing else", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const sql = readFileSync(join(import.meta.dirname, "..", "..", "migrations", "0266_lead_verification_closed_reason.sql"), "utf8");
		const backfill = sql.slice(sql.indexOf("UPDATE job_lead_browser_verifications"));
		const put = (lead: string, attempts: number, detail: string) =>
			d1.exec(`INSERT INTO job_lead_browser_verifications (instance_id, lead_id, user_id, work_key, canonical_url, state, attempts, next_attempt_at, awaiting_since, last_detail, updated_at, created_at) VALUES ('s1', '${lead}', 'u1', NULL, 'https://www.seek.com.au/job/1', 'unverifiable', ${attempts}, 0, 0, '${detail}', 0, 0)`);
		put("coles", 0, "Nobody allowed www.seek.com.au within 60 minutes, so it was not opened.");
		put("declined", 0, "You declined www.seek.com.au for this Scout''s browser.");
		put("checked", 2, "Nobody allowed www.seek.com.au within 60 minutes, so it was not opened.");
		put("ran", 0, "Nobody allowed www.seek.com.au within 60 minutes, so it was not opened.");
		d1.exec("INSERT INTO job_lead_browser_verification_attempts (id, instance_id, user_id, lead_id, attempt, run_id, state, created_at) VALUES ('r1', 's1', 'u1', 'ran', 1, 'run', 'completed', 1)");
		d1.exec(backfill);
		const marked = d1.sqlite.prepare("SELECT lead_id FROM job_lead_browser_verifications WHERE closed_reason = 'consent_expired' ORDER BY lead_id").all();
		expect(marked).toEqual([{ lead_id: "coles" }]);
	});
});

// ── #1257: a verified lead is named by what the browser read ──────────────────────────────────────────

describe("naming a lead from the browser's reading (#1257)", () => {
	const UNNAMED = { title: null, company: null, source: "manual_url" };
	const unname = () => leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...leads.get("lead-1")!.data, ...UNNAMED } } as CollectionRecord);
	const finding = (fields: Record<string, unknown>, evidence = "Senior Platform Engineer at Acme Pty Ltd — Sydney") => ({ title: "page", url: CANONICAL, evidence, fields });
	const finishWith = (id: string, findings: unknown[]) => runs.set(id, { id, status: "completed", result: { findings, summary: "read the page" } });
	const settleActive = async (findings: unknown[]) => {
		await runLeadBrowserVerification(env, 2_000);
		finishWith("run-1", findings);
		await runLeadBrowserVerification(env, 3_000);
	};
	const ACTIVE = { verification_outcome: "active" };

	it("asks the browser for the job's own title and employer when it is open", () => {
		const o = verificationObjective({ canonicalUrl: CANONICAL, expectedTitle: null, expectedCompany: null });
		expect(o).toContain("fields.job_title");
		expect(o).toContain("fields.job_company");
		expect(o).toMatch(/exactly as the page states them/);
	});

	it("a PASTED URL (no title, no employer) is named by the verified page, and says who named it", async () => {
		unname();
		await settleActive([finding({ ...ACTIVE, job_title: "Senior Platform Engineer", job_company: "Acme Pty Ltd" })]);
		expect(lead()).toMatchObject({ status: "new", title: "Senior Platform Engineer", company: "Acme Pty Ltd", lifecycle_version: 1, verification: { state: "live", named_by_browser: ["title", "company"] } });
	});

	it("an UNNAMED DIGEST lead from another board is named the same way — one field at a time when only one is read", async () => {
		leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...leads.get("lead-1")!.data, title: null, company: null, source: "gmail_digest", gmail_provenance: { kind: "digest" } } } as CollectionRecord);
		await settleActive([finding({ ...ACTIVE, job_title: "Senior Platform Engineer" })]);
		expect(lead()).toMatchObject({ title: "Senior Platform Engineer", company: null, verification: { named_by_browser: ["title"] } });
	});

	it("a lead that already has a name is NEVER overwritten by the browser — not even by a different one", async () => {
		await settleActive([finding({ ...ACTIVE, job_title: "Totally Different Role", job_company: "Other Co" }, "Totally Different Role at Other Co")]);
		expect(lead()).toMatchObject({ title: "Platform Engineer", company: "Acme", status: "new" });
		expect((lead().verification as Record<string, unknown>).named_by_browser).toBeUndefined();
	});

	it("only the EMPTY field is filled: a named title keeps its name while a missing employer is added", async () => {
		leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...leads.get("lead-1")!.data, company: null } } as CollectionRecord);
		await settleActive([finding({ ...ACTIVE, job_title: "Other Title", job_company: "Acme Pty Ltd" })]);
		expect(lead()).toMatchObject({ title: "Platform Engineer", company: "Acme Pty Ltd", verification: { named_by_browser: ["company"] } });
	});

	it("malformed names are ignored and the lead is still verified: non-string, empty, whitespace, over 200 characters, punctuation only", async () => {
		for (const bad of [42, true, null, {}, ["x"], "", "   ", "x".repeat(201), "!!! ---"]) {
			unname();
			leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...leads.get("lead-1")!.data, status: "awaiting_browser_verification", lifecycle_version: 0 } } as CollectionRecord);
			expect(namesFromRun({ id: "r", status: "completed", result: { findings: [finding({ ...ACTIVE, job_title: bad, job_company: bad }, "")], summary: "" } } as never), JSON.stringify(bad)).toEqual({});
		}
		unname();
		await settleActive([finding({ ...ACTIVE, job_title: "x".repeat(201), job_company: 7 })]);
		expect(lead()).toMatchObject({ status: "new", title: null, company: null });
	});

	it("control characters are stripped and spaces collapsed before a name is stored", async () => {
		unname();
		await settleActive([finding({ ...ACTIVE, job_title: "Senior\u0000 Platform\n\tEngineer\u202e", job_company: "Acme\u0007  Pty   Ltd" }, "")]);
		expect(lead().title).toBe("Senior Platform Engineer"); // the bidi override (U+202E) is removed, not kept
		expect(lead().company).toBe("Acme Pty Ltd");
		expect(cleanVerifiedName("a\u0000b")).toBe("a b");
	});

	it("a name that is NOT in the finding's evidence is ignored (the page is untrusted); a lenient match ignores case and punctuation", async () => {
		unname();
		await settleActive([finding({ ...ACTIVE, job_title: "Chief Executive Officer", job_company: "Evil Corp" }, "Senior Platform Engineer at Acme Pty Ltd")]);
		expect(lead()).toMatchObject({ status: "new", title: null, company: null });
		expect(nameGroundedIn("sr. platform  engineer", "Hiring: SR PLATFORM ENGINEER (contract)")).toBe(true);
		expect(nameGroundedIn("Platform", "Senior Platformer")).toBe(false); // whole words, not a substring
	});

	it("NO evidence at all: the name goes through (a page that renders dynamically captures none)", async () => {
		unname();
		await settleActive([finding({ ...ACTIVE, job_title: "Platform Engineer", job_company: "Acme" }, "")]);
		expect(lead()).toMatchObject({ title: "Platform Engineer", company: "Acme" });
		expect(nameGroundedIn("anything", undefined)).toBe(true);
		expect(nameGroundedIn("anything", "   ")).toBe(true);
	});

	it("several active findings that disagree name nothing; ones that agree (however spelled) do; an unusable one does not veto", async () => {
		unname();
		const two = (a: string, b: string) => namesFromRun({ id: "r", status: "completed", result: { findings: [finding({ ...ACTIVE, job_title: a }, ""), finding({ ...ACTIVE, job_title: b }, "")], summary: "" } } as never);
		expect(two("Platform Engineer", "Backend Engineer")).toEqual({});
		expect(two("Platform Engineer", "platform  engineer.").title).toMatch(/^platform\s+engineer\.?$/i);
		expect(two("Platform Engineer", "").title).toBe("Platform Engineer");
		await settleActive([finding({ ...ACTIVE, job_title: "Platform Engineer" }, ""), finding({ ...ACTIVE, job_title: "Backend Engineer" }, "")]);
		expect(lead()).toMatchObject({ status: "new", title: null });
	});

	it("a name reported alongside a non-active outcome is not read at all", () => {
		for (const outcome of ["expired", "mismatch", "temporarily_unverifiable"]) {
			expect(namesFromRun({ id: "r", status: "completed", result: { findings: [finding({ verification_outcome: outcome, job_title: "Platform Engineer", job_company: "Acme" }, "")], summary: "" } } as never), outcome).toEqual({});
		}
		expect(namesFromRun({ id: "r", status: "failed", result: { findings: [finding({ ...ACTIVE, job_title: "Platform Engineer" }, "")] } } as never)).toEqual({});
		expect(namesFromRun(null)).toEqual({});
	});

	it("MISMATCH and EXPIRED outcomes write no names even if the plan is handed some; a transient outcome writes none either", () => {
		const rec = { id: "l", data: { status: "awaiting_browser_verification", lifecycle_version: 0, title: null, company: null, url: CANONICAL } } as unknown as CollectionRecord;
		for (const outcome of ["mismatch", "expired", "temporarily_unverifiable"] as const) {
			const plan = planBrowserVerificationOutcome(rec, { outcome, attempt: 1, receiptId: "r", exhausted: false, verifiedTitle: "Platform Engineer", verifiedCompany: "Acme" });
			expect((plan as { patch: Record<string, unknown> }).patch, outcome).not.toHaveProperty("title");
			expect((plan as { patch: Record<string, unknown> }).patch, outcome).not.toHaveProperty("company");
		}
	});

	it("the TRUSTED writer re-cleans: a malformed name sent straight to the plan is not stored", () => {
		const rec = { id: "l", data: { status: "awaiting_browser_verification", lifecycle_version: 0, title: null, company: null, url: CANONICAL } } as unknown as CollectionRecord;
		const plan = planBrowserVerificationOutcome(rec, { outcome: "active", attempt: 1, receiptId: "r", exhausted: false, verifiedTitle: "x".repeat(500), verifiedCompany: "  \u0000  " });
		expect((plan as { patch: Record<string, unknown> }).patch).not.toHaveProperty("title");
		expect((plan as { patch: Record<string, unknown> }).patch).not.toHaveProperty("company");
		expect((plan as { patch: Record<string, unknown> }).patch).toMatchObject({ status: "new" });
	});

	it("a transient attempt writes no names; the retry that finally reads the page does, once", async () => {
		unname();
		await runLeadBrowserVerification(env, 2_000);
		finishWith("run-1", [finding({ verification_outcome: "temporarily_unverifiable", job_title: "Platform Engineer" }, "")]);
		await runLeadBrowserVerification(env, 3_000);
		expect(lead()).toMatchObject({ status: "awaiting_browser_verification", title: null });
		await runLeadBrowserVerification(env, 3_000 + RETRY_BACKOFF_MS[0]);
		finishWith("run-2", [finding({ ...ACTIVE, job_title: "Platform Engineer", job_company: "Acme" }, "Platform Engineer, Acme")]);
		await runLeadBrowserVerification(env, 9_000_000);
		expect(lead()).toMatchObject({ status: "new", title: "Platform Engineer", company: "Acme", lifecycle_version: 1 });
	});

	it("idempotent: a second application of the same outcome is a no-op that changes neither the names nor the version", () => {
		const rec = { id: "l", data: { status: "awaiting_browser_verification", lifecycle_version: 0, title: null, company: null, url: CANONICAL } } as unknown as CollectionRecord;
		const input = { outcome: "active" as const, attempt: 1, receiptId: "r", exhausted: false, verifiedTitle: "Platform Engineer", verifiedCompany: "Acme" };
		const first = planBrowserVerificationOutcome(rec, input) as { ok: true; patch: Record<string, unknown> };
		expect(first.patch).toMatchObject({ title: "Platform Engineer", company: "Acme", lifecycle_version: 1 });
		const after = { id: "l", data: { ...rec.data, ...first.patch } } as unknown as CollectionRecord;
		expect(planBrowserVerificationOutcome(after, { ...input, verifiedTitle: "Another Title" })).toEqual({ ok: true, transitioned: false, to: "new", patch: null });
	});

	it("a VERSION CONFLICT refuses and writes nothing — the names do not slip past the compare-and-set", async () => {
		const rec = { id: "l", data: { status: "awaiting_browser_verification", lifecycle_version: 2, title: null, company: null, url: CANONICAL } } as unknown as CollectionRecord;
		expect(planBrowserVerificationOutcome(rec, { outcome: "active", attempt: 1, receiptId: "r", exhausted: false, expectedVersion: 1, verifiedTitle: "Platform Engineer", verifiedCompany: "Acme" })).toMatchObject({ ok: false, stale: true });
		// through the real route too: a stale request is a 409 and the stored lead keeps its (empty) names
		unname();
		const res = await env.AGENT.get("s1").fetch(new Request("https://agent/job-leads/lead-1/browser-verification", { method: "POST", body: JSON.stringify({ outcome: "active", attempt: 1, receipt_id: "r", exhausted: false, expected_version: 5, verified_title: "Platform Engineer", verified_company: "Acme" }) }));
		expect(res.status).toBe(409);
		expect(lead()).toMatchObject({ title: null, company: null, status: "awaiting_browser_verification" });
	});

	it("a lead the owner moved on is not named by a late verification", async () => {
		unname();
		await runLeadBrowserVerification(env, 2_000);
		leads.set("lead-1", { ...leads.get("lead-1")!, data: { ...leads.get("lead-1")!.data, status: "archived" } } as CollectionRecord);
		finishWith("run-1", [finding({ ...ACTIVE, job_title: "Platform Engineer", job_company: "Acme" }, "")]);
		await runLeadBrowserVerification(env, 3_000);
		expect(lead()).toMatchObject({ status: "archived", title: null, company: null });
	});

	it("the work key does not change when a lead is named (it comes from the URL, not the title)", async () => {
		const { workKeyForLead } = await import("./job-lead-triage.js");
		unname();
		const before = workKeyForLead(lead());
		await settleActive([finding({ ...ACTIVE, job_title: "Platform Engineer", job_company: "Acme" }, "")]);
		expect(workKeyForLead(lead())).toBe(before);
	});
});
