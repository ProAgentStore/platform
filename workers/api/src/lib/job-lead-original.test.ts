/**
 * #1607: a verified-live board lead gets its ORIGINAL posting from the Apply link, published to the Jobs app; a lead
 * with none asks the Original Finder; Jobs keeps the lead's location, verification and decision. Over the real schema
 * and the real verification route; faked: the browser run, the Jobs MCP tools and the connection outbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionRecord } from "../agent-storage-types.js";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

type Run = { id: string; status: string; result?: unknown };
const runs = new Map<string, Run>();
const jobs = vi.hoisted(() => ({ calls: [] as Array<{ tool: string; args: Record<string, unknown> }>, fail: false, leadStatus: "new" }));
const events = vi.hoisted(() => [] as Array<{ eventType: string; payload: Record<string, unknown> }>);

vi.mock("./local-browser/start.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./local-browser/start.js")>()),
	startLocalBrowserRun: async () => {
		const run: Run = { id: `run-${runs.size + 1}`, status: "running" };
		runs.set(run.id, run);
		return { kind: "started", run };
	},
}));
vi.mock("./local-browser/store.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./local-browser/store.js")>()),
	getLocalBrowserRun: async (_e: unknown, _i: string, _u: string, id: string) => runs.get(id) ?? null,
}));
vi.mock("../routes/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../routes/push.js")>()), notifyUser: async () => undefined }));
vi.mock("./jobs-app.js", () => ({
	callJobsTool: async (_e: unknown, _w: unknown, tool: string, args: Record<string, unknown>) => {
		jobs.calls.push({ tool, args });
		if (jobs.fail) return { ok: false, reason: "failed", detail: "Jobs is down" };
		return tool === "get_my_lead_by_url" ? { ok: true, data: { rows: [{ id: "jl-1", status: jobs.leadStatus }] } } : { ok: true };
	},
}));
vi.mock("./connections.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./connections.js")>()),
	deliverEvent: async (_e: unknown, _i: string, _u: string, eventType: string, payloads: Array<Record<string, unknown>>) => {
		for (const payload of payloads) events.push({ eventType, payload });
		return { connections: 1 };
	},
}));

const { applyJobLeadBrowserVerification, triageJobLead } = await import("../agent-do-storage-routes.js");
const { acceptOriginal } = await import("./job-lead-triage.js");
const { originalFromRun, pageTitleFromRun, runLeadBrowserVerification, verificationObjective } = await import("./job-lead-browser-verification.js");
const { enqueueBrowserVerification } = await import("./job-lead-queue.js");
const { runJobLeadTriage } = await import("../routes/instances-job-leads.js");
const { listLeadVerifications } = await import("./job-lead-browser-verification.js");

const SEEK = "https://www.seek.com.au/job/12345678";
const ATS = "https://careers.smartrecruiters.com/endeavour/743999";
const SEEK_TITLE = "Platform Engineer Job in Richmond, Melbourne VIC - SEEK";
let d1: RealSchemaD1;
let leads: Map<string, CollectionRecord>;
let env: Env;

beforeEach(async () => {
	runs.clear();
	jobs.calls.length = 0;
	jobs.fail = false;
	jobs.leadStatus = "new";
	events.length = 0;
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('scout', 'u1', 't1607-scout', 'Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{}}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('s1', 'scout', 'u1', 'active', '{"browserVerification":{"enabled":true}}')`);
	d1.exec(`INSERT INTO local_browser_domain_consent (instance_id, user_id, domain, scope, decision, decided_at) VALUES ('s1', 'u1', 'seek.com.au', 'navigate', 'allow', 1)`);
	leads = new Map([["lead-1", { id: "lead-1", data: { status: "awaiting_browser_verification", lifecycle_version: 0, url: SEEK, title: "Platform Engineer", company: "Endeavour Group", verification: { state: "awaiting_browser_verification", canonical_job_url: SEEK } } } as unknown as CollectionRecord]]);
	const engine = {
		recordGet: async (_c: string, id: string) => leads.get(id) ?? null,
		recordUpdate: async (_c: string, id: string, patch: Record<string, unknown>) => {
			const r = leads.get(id);
			if (!r) return null;
			const next = { ...r, data: { ...r.data, ...patch } } as CollectionRecord;
			leads.set(id, next);
			return next;
		},
		recordQuery: async () => ({ records: [...leads.values()], total: leads.size }),
	};
	env = {
		DB: d1.DB,
		SESSION_SIGNING_KEY: "k",
		AGENT: {
			idFromName: (n: string) => n,
			get: () => ({
				fetch: async (req: Request) => {
					const url = new URL(req.url);
					const parts = url.pathname.split("/");
					if (parts[1] === "collections") {
						if (parts.length === 3) return Response.json({ name: "job_leads" });
						if (req.method === "PUT") return Response.json(await engine.recordUpdate("job_leads", decodeURIComponent(parts[4]), ((await req.json()) as { data: Record<string, unknown> }).data));
						return Response.json({ records: [...leads.values()] });
					}
					return parts[3] === "triage" ? triageJobLead(engine as never, parts[2], req) : applyJobLeadBrowserVerification(engine as never, parts[2], req);
				},
			}),
		},
	} as unknown as Env;
	await enqueueBrowserVerification(env, { instanceId: "s1", userId: "u1", leadId: "lead-1", workKey: "wk-1", canonicalUrl: SEEK, expectedTitle: "Platform Engineer", expectedCompany: "Endeavour Group", reason: "server_fetch_refused" }, 1_000);
});
afterEach(() => d1.close());

const lead = () => leads.get("lead-1")!.data as Record<string, unknown>;
const verification = () => lead().verification as Record<string, unknown>;
type Finding = { title: string; url: string; evidence: string; fields: Record<string, unknown> };
const board = (extra: Record<string, unknown> = {}): Finding => ({ title: "Platform Engineer", url: SEEK, evidence: "Platform Engineer Endeavour Group", fields: { verification_outcome: "active", job_title: "Platform Engineer", job_company: "Endeavour Group", page_title: SEEK_TITLE, ...extra } });
const landing = (fields: Record<string, unknown> = {}, evidence = "Platform Engineer. Build and run our platform. You will own CI/CD and Kubernetes."): Finding => ({
	title: "Platform Engineer",
	url: ATS,
	evidence,
	fields: { original: "external", original_url: ATS, original_host: "careers.smartrecruiters.com", original_title: "Platform Engineer", original_live: true, ...fields },
});
/** Dispatch, let the run end with these findings, and settle it. */
async function verify(findings: Finding[]) {
	await runLeadBrowserVerification(env, 2_000);
	runs.set("run-1", { id: "run-1", status: "completed", result: { findings, summary: "done" } });
	await runLeadBrowserVerification(env, 3_000);
}
const tools = (name: string) => jobs.calls.filter((c) => c.tool === name);

describe("the objective asks for the original behind the Apply link, read-only (#1607)", () => {
	it("names the Apply link, Quick Apply, the typed fields, and still forbids applying", () => {
		const o = verificationObjective({ canonicalUrl: SEEK, expectedTitle: "Platform Engineer", expectedCompany: "Endeavour" });
		expect(o).toMatch(/click the link named "Apply" ONCE/);
		expect(o).toMatch(/Quick apply/);
		expect(o).toContain("fields.original");
		expect(o).toMatch(/Do not apply, sign up, sign in or submit anything/);
	});
});

describe("an external Apply link records the original and publishes it (#1607)", () => {
	it("records original_url/host/description on the lead, submits it with location + external_id, then get_my_lead_by_url and publish_lead", async () => {
		await verify([board(), landing()]);
		expect(lead().status).toBe("new");
		expect(verification()).toMatchObject({ state: "live", original: "external", original_url: ATS, original_host: "careers.smartrecruiters.com", original_description: expect.stringContaining("CI/CD and Kubernetes"), title: SEEK_TITLE });

		const submitted = JSON.parse(tools("submit_leads")[0].args.leads as string)[0];
		expect(submitted).toMatchObject({ source_url: SEEK, external_id: "lead-1", location: "Richmond, Melbourne VIC", verification_state: "live", decision: "pending" });
		expect(submitted.verified_at).toBeGreaterThan(0);
		expect(tools("get_my_lead_by_url")[0].args).toEqual({ source_url: SEEK });
		expect(tools("publish_lead")).toHaveLength(1);
		expect(tools("publish_lead")[0].args).toMatchObject({ lead_id: "jl-1", original_url: ATS, source_host: "careers.smartrecruiters.com", slug: "endeavour-group-platform-engineer", description: expect.stringContaining("Kubernetes"), location: "Richmond, Melbourne VIC" });
		expect(lead().jobs_published_at).toBeTypeOf("number");
		expect(events).toHaveLength(0);
	});

	it("an already-published lead is stamped, not published twice", async () => {
		jobs.leadStatus = "published";
		await verify([board(), landing()]);
		expect(tools("publish_lead")).toHaveLength(0);
		expect(lead().jobs_published_at).toBeTypeOf("number");
	});
});

describe("a Quick Apply has no original (#1607)", () => {
	it("records original: quick_apply, emits job.lead.original_missing with the lead envelope, and tells Jobs why", async () => {
		await verify([board(), { title: "Platform Engineer", url: SEEK, evidence: "Quick apply", fields: { original: "quick_apply" } }]);
		expect(verification()).toMatchObject({ state: "live", original: "quick_apply" });
		expect(verification().original_url).toBeUndefined();
		expect(events).toEqual([
			{
				eventType: "job.lead.original_missing",
				payload: expect.objectContaining({ eventId: "s1:lead-1:1:original_missing", sourceInstanceId: "s1", leadId: "lead-1", leadUrl: SEEK, reason: "quick_apply", lifecycleVersion: 1, lead: expect.objectContaining({ title: "Platform Engineer", company: "Endeavour Group", url: SEEK }) }),
			},
		]);
		expect(tools("publish_lead")).toHaveLength(0);
		expect(tools("update_my_lead").at(-1)?.args).toMatchObject({ source_url: SEEK, no_original_reason: expect.stringMatching(/Quick Apply/) });
	});

	it("a run that reports nothing about the Apply link is treated as no original, too", async () => {
		await verify([board()]);
		expect(verification().original).toBe("none");
		expect(events[0]?.payload).toMatchObject({ reason: "no_outbound_apply" });
	});
});

describe("an original that is not the employer's own live posting of this job is refused (#1607)", () => {
	it("a job-board landing page is refused: nothing published, the Original Finder is asked", async () => {
		await verify([board(), landing({ original_url: "https://www.linkedin.com/jobs/view/999", original_host: "www.linkedin.com" })]);
		expect(verification()).toMatchObject({ original: "none", original_rejected: "job_board" });
		expect(verification().original_url).toBeUndefined();
		expect(tools("publish_lead")).toHaveLength(0);
		expect(events[0]?.payload).toMatchObject({ reason: "no_outbound_apply", rejected: "job_board" });
	});

	it("a page for a different job (title mismatch) is refused", async () => {
		await verify([board(), landing({ original_title: "Senior Accountant" }, "Senior Accountant. Close the books.")]);
		expect(verification()).toMatchObject({ original: "none", original_rejected: "title_mismatch" });
		expect(tools("publish_lead")).toHaveLength(0);
		expect(events).toHaveLength(1);
	});

	it("a closed landing page is refused", async () => {
		await verify([board(), landing({ original_live: false })]);
		expect(verification()).toMatchObject({ original: "none", original_rejected: "not_live" });
		expect(tools("publish_lead")).toHaveLength(0);
	});

	it("acceptOriginal: https only, no credentials, a description is required, a title either way round matches", () => {
		const ok = { kind: "external" as const, url: ATS, title: "Platform Engineer (Melbourne)", description: "text", live: true };
		expect(acceptOriginal(ok, "Platform Engineer")).toMatchObject({ original: "external", host: "careers.smartrecruiters.com" });
		expect(acceptOriginal({ ...ok, url: "http://careers.example.com/1" }, "Platform Engineer")).toMatchObject({ rejected: "not_https" });
		expect(acceptOriginal({ ...ok, url: "https://u:p@careers.example.com/1" }, "Platform Engineer")).toMatchObject({ rejected: "not_https" });
		expect(acceptOriginal({ ...ok, description: "  " }, "Platform Engineer")).toMatchObject({ rejected: "no_description" });
		expect(acceptOriginal({ ...ok, url: "https://au.indeed.com/viewjob?jk=1" }, "Platform Engineer")).toMatchObject({ rejected: "job_board" });
		expect(acceptOriginal({ ...ok, description: "x".repeat(30_000) }, "Platform Engineer")).toMatchObject({ rejected: "no_description" });
	});

	it("originalFromRun: the runner-stamped url and the finding's evidence are what is read; an ungrounded title is dropped", () => {
		const run = { id: "r", status: "completed", result: { findings: [board(), landing({ original_title: "Wildly Different" })] } };
		const c = originalFromRun(run as never);
		expect(c).toMatchObject({ kind: "external", url: ATS, live: true });
		expect((c as { title?: string }).title).toBeUndefined();
		expect(pageTitleFromRun(run as never)).toBe(SEEK_TITLE);
	});
});

describe("Jobs is never in the way (#1607)", () => {
	it("a Jobs error leaves the verification verdict, the lead and the queue untouched", async () => {
		jobs.fail = true;
		await verify([board(), landing()]);
		expect(lead().status).toBe("new");
		expect(verification()).toMatchObject({ state: "live", original: "external" });
		expect((await listLeadVerifications(env, "s1", "u1")).leads[0]).toMatchObject({ state: "active" });
		expect(lead().jobs_pushed_at).toBeUndefined();
		expect(lead().jobs_published_at).toBeUndefined();
	});

	it("once Jobs is back, the next push sends the lead and publishes its original", async () => {
		jobs.fail = true;
		await verify([board(), landing()]);
		jobs.fail = false;
		jobs.calls.length = 0;
		const { pushScoutLeadsToJobs } = await import("./gmail-scout/jobs-push.js");
		const { readGmailScoutLeadRecords } = await import("./gmail-scout/scan.js");
		await pushScoutLeadsToJobs(env, "s1", "u1", () => readGmailScoutLeadRecords(env, "s1"));
		expect(tools("submit_leads")).toHaveLength(1);
		expect(tools("publish_lead")).toHaveLength(1);
	});
});

describe("the owner's triage reaches the Jobs lead (#1607)", () => {
	const triage = (action: string) => runJobLeadTriage(env, "s1", "u1", "lead-1", { action });

	it.each([
		["skip", "skip"],
		["archive", "archived"],
	])("%s sets decision %s on the Jobs lead, keyed by the same URL and external_id", async (action, decision) => {
		await verify([board(), landing()]);
		jobs.calls.length = 0;
		expect((await triage(action)).status).toBe(200);
		const update = tools("update_my_lead").at(-1);
		expect(update?.args).toMatchObject({ source_url: SEEK, external_id: "lead-1", decision });
		expect(lead().jobs_synced_key).toContain(`"decision":"${decision}"`);
	});

	it("an Apply decision is `apply`", async () => {
		await verify([board(), landing()]);
		jobs.calls.length = 0;
		await triage("apply");
		expect(tools("update_my_lead").at(-1)?.args).toMatchObject({ decision: "apply" });
	});

	it("a Jobs failure on the triage push does not fail the triage", async () => {
		await verify([board(), landing()]);
		jobs.fail = true;
		const out = await triage("skip");
		expect(out.status).toBe(200);
		expect(lead().status).toBe("skipped");
	});

	it("a repeated push with nothing changed makes no Jobs call", async () => {
		await verify([board(), landing()]);
		await triage("skip");
		jobs.calls.length = 0;
		const { pushScoutLeadsToJobs } = await import("./gmail-scout/jobs-push.js");
		const { readGmailScoutLeadRecords } = await import("./gmail-scout/scan.js");
		await pushScoutLeadsToJobs(env, "s1", "u1", () => readGmailScoutLeadRecords(env, "s1"));
		expect(jobs.calls).toEqual([]);
	});
});
