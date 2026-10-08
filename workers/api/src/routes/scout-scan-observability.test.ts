/**
 * #980 end to end: a Job Search Scout that is SCHEDULED, whose every scan is one card on the
 * normal board, with structured telemetry that explains what it found — and did not find.
 *
 * The live state this is about: a connected Scout with leads in its Data table, no configured
 * trigger, no run visible anywhere but the Research tab, and no way to tell whether it was
 * scheduled, what it checked, what it rejected, or why a scan found nothing.
 *
 * Real: the migrated schema, the trigger store and its cron sweep, the local-browser start path and
 * its `maxConcurrent` claim, the finding review with its duplicate check, the board projection, the
 * lead triage and the connection outbox. Faked: the machine at the end of the relay (its answers
 * are scripted, so what it was ASKED is assertable) and the Scout's Durable Object storage, behind
 * the REAL storage-route handlers.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRecord, insertRecord, queryRecords, triageJobLead, writeJobLeadApplication } from "../agent-do-storage-routes.js";
import type { CollectionRecord } from "../agent-storage-types.js";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { JOB_LEAD_APPLY_EVENT } from "../lib/job-lead-triage.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { getBoundRunnerConn } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn }));

const { instanceRoutes } = await import("./instances.js");
const { triggerRoutes } = await import("./triggers.js");
const { runDueTriggers } = await import("../lib/triggers.js");
const { runDueDeliveries } = await import("../lib/connections.js");

let d1: RealSchemaD1;
let sent: Array<{ path: string; body: Record<string, unknown> }>;
let answers: Record<string, { status: number; body: unknown }>;
const relay = {
	idFromName: (n: string) => n,
	get: () => ({
		fetch: async (req: Request) => {
			const cmd = (await req.json()) as { path: string; body: string | Record<string, unknown> };
			const body = typeof cmd.body === "string" ? JSON.parse(cmd.body) : (cmd.body ?? {});
			sent.push({ path: cmd.path, body });
			const a = answers[cmd.path] ?? { status: 404, body: { error: "unknown path" } };
			return new Response(JSON.stringify(a.body), { status: a.status });
		},
	}),
};

let leads: Map<string, CollectionRecord>;
let nextId = 0;
const engine = {
	recordInsert: async (_c: string, data: Record<string, unknown>) => {
		const rec = { id: `lead-${++nextId}`, collection: "job_leads", data, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" } as CollectionRecord;
		leads.set(rec.id, rec);
		return rec;
	},
	recordGet: async (_c: string, id: string) => leads.get(id) ?? null,
	recordUpdate: async (_c: string, id: string, patch: Record<string, unknown>) => {
		const r = leads.get(id);
		if (!r) return null;
		const next = { ...r, data: { ...r.data, ...patch }, updatedAt: new Date().toISOString() };
		leads.set(id, next);
		return next;
	},
	recordQuery: async (_c: string, o: { where?: Record<string, unknown>; limit?: number; offset?: number } = {}) => {
		const all = [...leads.values()].filter((r) => !o.where || Object.entries(o.where).every(([k, v]) => r.data[k] === v));
		return { records: all.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 50)), total: all.length };
	},
};
const agentDO = {
	idFromName: (n: string) => n,
	get: (id: string) => ({
		fetch: async (req: Request) => {
			const url = new URL(req.url);
			const p = url.pathname;
			if (id === "scout") {
				if (p === "/collections/job_leads/records" && req.method === "GET") return queryRecords(engine as never, "job_leads", url);
				if (p === "/collections/job_leads/records" && req.method === "POST") return insertRecord(engine as never, "job_leads", req);
				if (/^\/collections\/job_leads\/records\/[^/]+$/.test(p)) return getRecord(engine as never, "job_leads", p.split("/")[4]);
				if (/^\/job-leads\/[^/]+\/triage$/.test(p)) return triageJobLead(engine as never, p.split("/")[2], req);
				if (/^\/job-leads\/[^/]+\/application$/.test(p)) return writeJobLeadApplication(engine as never, p.split("/")[2], req);
			}
			return Response.json({ ok: true }, { status: 201 });
		},
	}),
};
const env = () => ({ DB: d1.DB, RELAY: relay, AGENT: agentDO } as unknown as Env);

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.route("/v1/triggers", triggerRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const dispatches = () => sent.filter((s) => s.path === "/local-browser/run");
const settings = async () => (await call("GET", "/v1/instances/scout/local-browser/settings")).body;
const board = async () => (await call("GET", "/v1/instances/scout/board")).body;
const scanCards = async () => ((await board()).items ?? []).filter((i: { scan?: unknown }) => !!i.scan);
const runView = (runId: string) => call("GET", `/v1/instances/scout/local-browser/runs/${runId}`);

/** A result envelope the scripted runner returns. */
const result = (runId: string, over: Record<string, unknown> = {}) => ({
	runId,
	outcome: "completed",
	findings: [],
	sourceFailures: [],
	summary: "done",
	traceId: runId,
	engineAuth: "subscription",
	...over,
});

beforeEach(() => {
	d1 = realSchemaD1();
	leads = new Map();
	nextId = 0;
	sent = [];
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, description, category, visibility, config) VALUES
	  ('scout-a', 'u1', 't980-scout', 'Job Search Scout', 'Finds job leads', 'productivity', 'public',
	   '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{"allowDomains":["jobs.example.com","boards.example.org"],"collection":{"name":"job_leads","keyField":"url"}}}}'),
	  ('tailor-a', 'u1', 't980-tailor', 'Application Tailor', 'Writes materials', 'productivity', 'public', '{"capabilities":{"surfaces":[],"runtime":"local_artifact"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('scout', 'scout-a', 'u1', 'active', '{"runnerNode":"mac"}'), ('t1', 'tailor-a', 'u1', 'active', '{"runnerNode":"mac"}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at) VALUES
	  ('scout', 'u1', 'mac', 'relay://', '0.6.0', 'online', '2026-10-08 00:00:00'), ('t1', 'u1', 'mac', 'relay://', '0.6.0', 'online', '2026-10-08 00:00:00')`);
	d1.exec(`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled) VALUES
	  ('c-lead', 'u1', 'scout', '${JOB_LEAD_APPLY_EVENT}', 't1', 'generate_application_materials', '{}', 1)`);
	getBoundRunnerConn.mockReset();
	getBoundRunnerConn.mockImplementation(async (_env: unknown, instanceId: string) => ({ runnerNode: "mac", instanceId, userId: "u1", relayName: `${instanceId}:node:mac`, endpointUrl: "relay://", token: "", env: {} }));
	answers = { "/local-browser/run": { status: 202, body: { taskId: "task-1" } }, "/local-artifact/run": { status: 202, body: { status: "running" } } };
});
afterEach(() => d1.close());

/** Schedule scans the way both surfaces do it: the cron trigger that actually fires them. */
const schedule = (over: Record<string, unknown> = {}) =>
	call("POST", "/v1/triggers", { instanceId: "scout", type: "cron", action: "run_local_browser", name: "Scheduled scan", schedule: "0 7 * * *", config: { objective: "Senior TypeScript roles in Sydney" }, ...over });

describe("#980: the Scout's scan schedule", () => {
	it("an unscheduled Scout says so — the platform never fills in a cadence", async () => {
		const s = await settings();
		expect(s.schedule).toMatchObject({ configured: false, enabled: false, cadence: null, objective: null });
		expect(s.scheduleSummary).toMatch(/No scan schedule/);
	});

	it("once scheduled, the settings read answers cadence, objective and the next run", async () => {
		expect((await schedule()).status).toBe(201);
		const s = await settings();
		expect(s.schedule).toMatchObject({ configured: true, enabled: true, cadence: "0 7 * * *", objective: "Senior TypeScript roles in Sydney" });
		expect(s.schedule.nextRunAt).toBeTruthy();
		expect(s.schedule.triggerId).toBeTruthy();
		expect(s.scheduleSummary).toMatch(/^Scanning 0 7 \* \* \* — next/);
	});

	it("disabled is a different state from unconfigured, and both are visible", async () => {
		const id = (await schedule()).body.trigger.id as string;
		expect((await call("PUT", `/v1/triggers/${id}`, { enabled: false })).status).toBe(200);
		const s = await settings();
		expect(s.schedule).toMatchObject({ configured: true, enabled: false, cadence: "0 7 * * *" });
		expect(s.scheduleSummary).toMatch(/SWITCHED OFF/);
	});
});

describe("#980: a SCHEDULED scan is one card on the normal board", () => {
	it("the cron sweep starts the scan, and it appears as a scheduled scan card", async () => {
		const id = (await schedule()).body.trigger.id as string;
		// Due now: the sweep is the real one, the same path a live deployment takes.
		d1.exec(`UPDATE agent_triggers SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id}'`);
		const swept = await runDueTriggers(env(), new Date());
		expect(swept).toMatchObject({ dispatched: 1, failed: 0 });

		// The run was dispatched to the machine with the schedule's objective.
		expect(dispatches()).toHaveLength(1);
		expect(dispatches()[0].body.objective).toBe("Senior TypeScript roles in Sydney");

		const cards = await scanCards();
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ status: "running" });
		expect(cards[0].scan).toMatchObject({ startedBy: "trigger", pages: 0, results: 0, leadsAdded: 0 });
		expect(cards[0].title).toMatch(/^Scan: Senior TypeScript roles/);
		expect(cards[0].subtitle).toBe("Scheduled scan");
		// The card links the run page, which is where the structured activity is.
		expect(cards[0].url).toBe(`/instances/scout/research/${dispatches()[0].body.runId}`);
		// …and the schedule now reports when it last ran.
		expect((await settings()).schedule.lastRunAt).toBeTruthy();
	});

	it("replay: the sweep firing again while a scan is active starts nothing and adds no card", async () => {
		const id = (await schedule()).body.trigger.id as string;
		d1.exec(`UPDATE agent_triggers SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id}'`);
		await runDueTriggers(env(), new Date());
		d1.exec(`UPDATE agent_triggers SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id}'`);
		await runDueTriggers(env(), new Date());

		// `maxConcurrent` is 1: the second tick is a SKIP, recorded, not a second scan.
		expect(dispatches()).toHaveLength(1);
		expect(await scanCards()).toHaveLength(1);
		// The skip is RECORDED and told once (#962's rule), so an owner reading the trigger's own
		// history sees why the second tick produced nothing — rather than a silent gap.
		const events = (await call("GET", `/v1/triggers/${id}/events`)).body.events as Array<{ status: string; message: string | null; payload: string }>;
		const skip = events.find((e) => (e.message ?? "").includes("skipped"));
		expect(skip).toMatchObject({ status: "succeeded" });
		expect(JSON.parse(skip?.payload ?? "{}")).toMatchObject({ skipped: true, reason: "a run is already in progress" });
		expect(events.filter((e) => (e.message ?? "").includes("started research run"))).toHaveLength(1);
	});

	it("idempotency: the owner's own start, retried with the same key, is one run and one card", async () => {
		const first = await call("POST", "/v1/instances/scout/local-browser/runs", { objective: "Senior roles", requestId: "key-1" });
		expect(first.status).toBe(202);
		const again = await call("POST", "/v1/instances/scout/local-browser/runs", { objective: "Senior roles", requestId: "key-1" });
		expect(again.status).toBe(200);
		expect(again.body.id).toBe(first.body.id);
		expect(dispatches()).toHaveLength(1);
		expect(await scanCards()).toHaveLength(1);
	});
});

describe("#980: telemetry answers why a scan found what it found", () => {
	/** Start a scan and return its run id. */
	async function startScan(objective = "Senior TypeScript roles in Sydney"): Promise<string> {
		const run = await call("POST", "/v1/instances/scout/local-browser/runs", { objective, requestId: crypto.randomUUID() });
		return run.body.id as string;
	}

	it("no results, with a source that could not be read: the reason names the source and the fix", async () => {
		const runId = await startScan();
		answers["/local-browser/status"] = {
			status: 200,
			body: {
				runId,
				state: "ended",
				lastSeq: 2,
				events: [
					{ seq: 1, type: "browser.navigated", at: "2026-10-08T07:00:01Z", url: "https://jobs.example.com/search", domain: "jobs.example.com" },
					{ seq: 2, type: "browser.blocked", at: "2026-10-08T07:00:02Z", domain: "boards.example.org" },
				],
				result: result(runId, { sourceFailures: [{ url: "https://boards.example.org/search", reason: "login_required" }], summary: "nothing matched" }),
			},
		};
		const view = await runView(runId);
		expect(view.status).toBe(200);
		const t = view.body.telemetry;
		expect(t.seen).toMatchObject({ pages: 1, findings: 0 });
		expect(t.sources).toMatchObject({ configured: 2, reached: 1, unreachable: 1 });
		expect(t.sources.reach.find((r: { domain: string }) => r.domain === "boards.example.org")).toMatchObject({ failed: "login_required", blocked: 1 });
		expect(t.errors).toEqual([{ code: "source:login_required", count: 1 }]);
		// Half the configured sources failed and nothing was found, so the reason leads with the
		// sources rather than with the page count — the more actionable of the two readings.
		expect(t.terminal.reason).toMatch(/^No results: 1 of 2 source\(s\) could not be read/);
		expect(t.terminal.reason).toContain("boards.example.org: login_required");
		// And the card says the same thing, on the board.
		const card = (await scanCards())[0];
		expect(card.status).toBe("completed");
		expect(card.scan).toMatchObject({ pages: 1, results: 0, sourcesUnreachable: 1, errors: 1 });
		expect(card.description).toMatch(/1 page · 0 results · 0 leads added · 1 source unreachable/);
	});

	it("a saved finding becomes a lead in Data carrying its scan, and the card counts it", async () => {
		const runId = await startScan();
		answers["/local-browser/status"] = {
			status: 200,
			body: {
				runId,
				state: "ended",
				lastSeq: 1,
				events: [{ seq: 1, type: "finding.parsed", at: "2026-10-08T07:00:03Z", url: "https://jobs.example.com/pm" }],
				result: result(runId, { findings: [{ title: "Product Manager", url: "https://jobs.example.com/pm", evidence: "Product Manager — BusinessAI", fields: { company: "BusinessAI" } }] }),
			},
		};
		await runView(runId);
		// Still the owner's decision: the finding is PENDING until they save it (#946).
		expect((await runView(runId)).body.telemetry.leads).toMatchObject({ added: 0, pending: 1 });

		expect((await call("POST", `/v1/instances/scout/local-browser/runs/${runId}/findings/0/save`)).status).toBe(200);
		const t = (await runView(runId)).body.telemetry;
		expect(t.leads).toMatchObject({ added: 1, duplicates: 0, pending: 0 });
		expect(t.leads.recordIds).toHaveLength(1);
		// The LEAD is Data, and it names the scan that produced it (#980).
		const record = leads.get(t.leads.recordIds[0]);
		expect(record?.data).toMatchObject({ url: "https://jobs.example.com/pm", sourceRunId: runId });
		// Board → Data: the card carries the same record id.
		expect((await scanCards())[0].scan.leadRecordIds).toEqual(t.leads.recordIds);
	});

	it("a DUPLICATE lead is reported as one, and nothing is written twice", async () => {
		// The same posting, found by two scans — the case the key field exists for.
		const first = await startScan();
		answers["/local-browser/status"] = {
			status: 200,
			body: { runId: first, state: "ended", lastSeq: 0, events: [], result: result(first, { findings: [{ title: "PM", url: "https://jobs.example.com/pm", evidence: "e", fields: {} }] }) },
		};
		await runView(first);
		await call("POST", `/v1/instances/scout/local-browser/runs/${first}/findings/0/save`);
		expect(leads.size).toBe(1);

		const second = await startScan("Senior TypeScript roles in Sydney, again");
		answers["/local-browser/status"] = {
			status: 200,
			body: { runId: second, state: "ended", lastSeq: 0, events: [], result: result(second, { findings: [{ title: "PM", url: "https://jobs.example.com/pm", evidence: "e", fields: {} }] }) },
		};
		await runView(second);
		await call("POST", `/v1/instances/scout/local-browser/runs/${second}/findings/0/save`);

		// One record, and the second scan's telemetry says why it added nothing.
		expect(leads.size).toBe(1);
		const t = (await runView(second)).body.telemetry;
		expect(t.leads).toMatchObject({ added: 0, duplicates: 1 });
		expect(t.rejections).toEqual([{ reason: "duplicate", count: 1 }]);
		expect(t.terminal.reason).toMatch(/all of them already in your Data \(1 duplicate/);
		const cards = await scanCards();
		expect(cards).toHaveLength(2);
		expect(cards.find((c: { scan: { runId: string } }) => c.scan.runId === second).scan).toMatchObject({ duplicates: 1, leadsAdded: 0 });
	});

	it("a successful HANDOFF: the lead this scan produced reaches the Tailor, and says which scan found it", async () => {
		const runId = await startScan();
		answers["/local-browser/status"] = {
			status: 200,
			body: { runId, state: "ended", lastSeq: 0, events: [], result: result(runId, { findings: [{ title: "PM", url: "https://jobs.example.com/pm", evidence: "e", fields: { company: "BusinessAI" } }] }) },
		};
		await runView(runId);
		await call("POST", `/v1/instances/scout/local-browser/runs/${runId}/findings/0/save`);
		const leadId = (await runView(runId)).body.telemetry.leads.recordIds[0] as string;

		// The owner Applies to it — the Scout's handoff, which is a TRIAGE decision and not part of
		// the scan: the telemetry says so in as many words, and this is the step it points at.
		const applied = await call("POST", "/v1/instances/scout/application-queue/actions", { action: "apply", scout_instance_id: "scout", record_id: leadId, expected_status: "new", expected_version: 0 });
		expect(applied.status).toBe(200);
		await runDueDeliveries(env());
		const delivered = (await d1.DB.prepare("SELECT status, event_type FROM agent_connection_deliveries").all<{ status: string; event_type: string }>()).results ?? [];
		expect(delivered).toMatchObject([{ event_type: JOB_LEAD_APPLY_EVENT, status: "delivered" }]);
		// The lead still names the scan that found it, all the way through the handoff.
		expect(leads.get(leadId)?.data).toMatchObject({ sourceRunId: runId, status: "apply_requested" });
	});

	it("a scan waiting on a login is `needs_human` on the board, with the reason", async () => {
		const runId = await startScan();
		answers["/local-browser/status"] = {
			status: 200,
			body: { runId, state: "paused", pauseReason: "login_required", lastSeq: 1, events: [{ seq: 1, type: "run.paused", at: "2026-10-08T07:00:05Z", pauseReason: "login_required" }] },
		};
		await runView(runId);
		const card = (await scanCards())[0];
		expect(card.status).toBe("needs_human");
		expect(card.scan).toMatchObject({ pauseReason: "login_required" });
		const t = (await runView(runId)).body.telemetry;
		expect(t.terminal.reason).toMatch(/waiting for you \(login_required\)/);
		// The scripted runner re-sends its page on every pull (a real one honours `afterSeq`), so the
		// COUNT is the harness's; the code is the platform's and is what this pins.
		expect(t.warnings).toMatchObject([{ code: "paused:login_required" }]);
	});

	it("the telemetry carries no page text, finding prose or URL query — only counts and hostnames", async () => {
		const runId = await startScan();
		answers["/local-browser/status"] = {
			status: 200,
			body: {
				runId,
				state: "ended",
				lastSeq: 1,
				events: [{ seq: 1, type: "browser.navigated", at: "2026-10-08T07:00:01Z", url: "https://jobs.example.com/search?q=typescript+sydney", domain: "jobs.example.com" }],
				result: result(runId, { findings: [{ title: "Staff Engineer at Globex", url: "https://jobs.example.com/x?ref=secret", evidence: "Salary 190k, apply by Friday", fields: {} }], summary: "Found a great role" }),
			},
		};
		const json = JSON.stringify((await runView(runId)).body.telemetry);
		for (const forbidden of ["Staff Engineer at Globex", "Salary 190k", "Found a great role", "q=typescript", "ref=secret"]) {
			expect(json, forbidden).not.toContain(forbidden);
		}
		expect(json).toContain("jobs.example.com");
	});
});
