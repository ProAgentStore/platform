/**
 * Local CLI browser research routes (#945) over the real schema. Only the relay/runner seam is
 * faked; ownership, capability resolution, settings storage, idempotency, the concurrency cap,
 * the lifecycle and the trace are the real code against the real migrations.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { getBoundRunnerConn } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn }));

const { instanceRoutes } = await import("./instances.js");

let d1: RealSchemaD1;
/** What the fake runner answers, and every command it was sent. */
let runner: { status: number; body: unknown; taskTypes: string[] | null; paths?: Record<string, { status: number; body: unknown; onCall?: () => void }> };
let sent: Array<{ method: string; path: string; body: unknown }>;
const relay = {
	idFromName: (n: string) => n,
	get: () => ({
		fetch: async (req: Request) => {
			const cmd = (await req.json()) as { method: string; path: string; body: unknown };
			sent.push(cmd);
			if (cmd.path === "/capabilities") return Response.json(runner.taskTypes ? { taskTypes: runner.taskTypes } : {});
			const byPath = runner.paths?.[cmd.path];
			if (byPath) {
				byPath.onCall?.();
				return new Response(JSON.stringify(byPath.body), { status: byPath.status });
			}
			return new Response(JSON.stringify(runner.body), { status: runner.status });
		},
	}),
};

/** The instance's collections, behind a fake Agent DO: just enough of /collections/:name/records. */
let collections: Record<string, Array<{ id: string; data: Record<string, unknown> }>>;
const agentDO = {
	idFromName: (n: string) => n,
	get: () => ({
		fetch: async (req: Request) => {
			const url = new URL(req.url);
			const name = decodeURIComponent(url.pathname.split("/")[2] ?? "");
			if (req.method === "GET") {
				if (!collections[name]) return Response.json({ error: `Collection "${name}" not found` }, { status: 500 });
				const where = JSON.parse(url.searchParams.get("where") || "{}") as Record<string, unknown>;
				const records = collections[name].filter((r) => Object.entries(where).every(([k, v]) => r.data[k] === v));
				return Response.json({ records, total: records.length });
			}
			const { data } = (await req.json()) as { data: Record<string, unknown> };
			const record = { id: `rec_${Object.values(collections).flat().length + 1}`, data };
			if (!collections[name]) collections[name] = [];
			collections[name].push(record);
			return Response.json(record, { status: 201 });
		},
	}),
};

beforeEach(() => {
	collections = {};
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
	  ('scout', 'u1', 't945-scout', 'Job Search Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{"allowDomains":["seek.com.au","indeed.com"]}}}'),
	  ('coder', 'u1', 't945-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('i1', 'scout', 'u1', 'active', '{"runnerNode":"mac"}'), ('ic', 'coder', 'u1', 'active', '{}'), ('other', 'scout', 'u2', 'active', '{}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at) VALUES ('i1', 'u1', 'mac', 'relay://', '0.5.0', 'online', '2026-10-07 00:00:00')`);
	getBoundRunnerConn.mockReset();
	getBoundRunnerConn.mockResolvedValue({ runnerNode: "mac", instanceId: "i1", userId: "u1", relayName: "i1:node:mac", endpointUrl: "relay://", token: "", env: {} });
	runner = { status: 202, body: { taskId: "task_1" }, taskTypes: ["local_browser.research"] };
	sent = [];
});
afterEach(() => d1.close());

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { DB: d1.DB, RELAY: relay, AGENT: agentDO } as unknown as Env);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("settings (#945)", () => {
	it("round-trips, with the effective policy and the existing runner pin", async () => {
		const put = await call("PUT", "/i1/local-browser/settings", { engine: "codex", workspace: { kind: "path", path: "~/jobs" }, access: { allowDomains: ["seek.com.au"] } });
		expect(put.status).toBe(200);
		const got = await call("GET", "/i1/local-browser/settings");
		expect(got.body).toMatchObject({ settings: { engine: "codex", workspace: { kind: "path", path: "~/jobs" } }, effective: { engine: "codex", authMode: "subscription", allowDomains: ["seek.com.au"] }, runnerNode: "mac", problem: null });
		// Stored beside the pin in the instance's config, not over it.
		const row = await d1.DB.prepare("SELECT config FROM agent_instances WHERE id = 'i1'").first<{ config: string }>();
		expect(JSON.parse(row!.config)).toMatchObject({ runnerNode: "mac", localBrowser: { engine: "codex" } });
	});

	it("refuses invalid combinations with the reason, and stores nothing", async () => {
		expect((await call("PUT", "/i1/local-browser/settings", { authMode: "api-key" })).body.error).toMatch(/subscription only/);
		expect((await call("PUT", "/i1/local-browser/settings", { workspace: { kind: "path", path: "/etc" } })).body.error).toMatch(/outside the runner's allowed scope/);
		expect((await call("PUT", "/i1/local-browser/settings", { access: { allowDomains: ["linkedin.com"] } })).body.error).toMatch(/outside the sites this agent may visit/);
		expect((await call("PUT", "/i1/local-browser/settings", { runnerNode: "pc" })).body.error).toMatch(/runner-node/);
		expect((await call("GET", "/i1/local-browser/settings")).body.settings).toEqual({});
	});

	it("is a 409 on an agent that is not a local browser agent, and a 404 on someone else's instance", async () => {
		const coder = await call("GET", "/ic/local-browser/settings");
		expect(coder.status).toBe(409);
		expect(coder.body.error).toMatch(/runtime is "coding"/);
		expect((await call("GET", "/other/local-browser/settings")).status).toBe(404);
	});
});

describe("preflight", () => {
	it("is ready with a connected runner that supports the task type", async () => {
		const r = await call("GET", "/i1/local-browser/preflight");
		expect(r.body.ready).toBe(true);
		expect(r.body.checks.map((c: { id: string; ok: boolean | null }) => [c.id, c.ok])).toEqual([["settings", true], ["runner", true], ["runner_support", true], ["engine_login", null]]);
	});

	it("names the one step that is missing", async () => {
		runner.taskTypes = ["browser.task"];
		expect((await call("GET", "/i1/local-browser/preflight")).body.checks.find((c: { id: string }) => c.id === "runner_support")).toMatchObject({ ok: false, detail: expect.stringMatching(/Update the CLI/) });
		getBoundRunnerConn.mockResolvedValue(null);
		const offline = await call("GET", "/i1/local-browser/preflight");
		expect(offline.body.ready).toBe(false);
		expect(offline.body.checks.find((c: { id: string }) => c.id === "runner")).toMatchObject({ ok: false, detail: expect.stringMatching(/pags up/) });
	});

	it("requires consent before the signed-in profile", async () => {
		await call("PUT", "/i1/local-browser/settings", { browserProfile: "default" });
		expect((await call("GET", "/i1/local-browser/preflight")).body.ready).toBe(false);
		await call("PUT", "/i1/local-browser/consent", { scope: "signed_in_profile", decision: "allow" });
		expect((await call("GET", "/i1/local-browser/preflight")).body.ready).toBe(true);
	});
});

describe("runs", () => {
	it("dispatches the envelope to the runner and records the trace", async () => {
		await call("PUT", "/i1/local-browser/consent", { scope: "navigate", domain: "seek.com.au", decision: "allow" });
		await call("PUT", "/i1/local-browser/consent", { scope: "navigate", domain: "indeed.com", decision: "deny" });
		const r = await call("POST", "/i1/local-browser/runs", { objective: "Find Sydney TypeScript roles", requestId: "req-1" });
		expect(r.status).toBe(202);
		expect(r.body).toMatchObject({ status: "running", runnerNode: "mac", runnerTaskId: "task_1", requestId: "req-1" });
		const dispatched = sent.find((s) => s.path === "/local-browser/run");
		expect(dispatched?.body).toMatchObject({
			type: "local_browser.research",
			runId: r.body.id,
			engine: "claude",
			authMode: "subscription",
			workspace: { kind: "scratch" },
			policy: { mode: "research_only", allowDomains: ["seek.com.au", "indeed.com"], denyDomains: ["indeed.com"], consentedDomains: ["seek.com.au"], profileConsented: false },
		});
		// Pull, not push (#944): the runner is never told where to report.
		expect(dispatched?.body).not.toHaveProperty("callback");
		const events = await call("GET", `/i1/local-browser/runs/${r.body.id}/events`);
		expect(events.body.events.map((e: { type: string }) => e.type)).toEqual(["run.requested", "runner.dispatched"]);
	});

	it("is idempotent on requestId", async () => {
		const a = await call("POST", "/i1/local-browser/runs", { objective: "x", requestId: "same" });
		const b = await call("POST", "/i1/local-browser/runs", { objective: "x", requestId: "same" });
		expect(b.status).toBe(200);
		expect(b.body.id).toBe(a.body.id);
		expect(sent.filter((s) => s.path === "/local-browser/run")).toHaveLength(1);
	});

	it("enforces the concurrency cap", async () => {
		await call("POST", "/i1/local-browser/runs", { objective: "one" });
		const second = await call("POST", "/i1/local-browser/runs", { objective: "two" });
		expect(second.status).toBe(409);
		expect(second.body.error).toMatch(/1 local browser run\(s\) already active and this instance allows 1/);
	});

	it.each([
		["no runner connected", () => getBoundRunnerConn.mockResolvedValue(null), "runner_offline"],
		["a runner that predates the feature", () => (runner = { ...runner, status: 404, body: { error: "Not found" } }), "runner_unsupported"],
		["a relay with no socket", () => (runner = { ...runner, status: 503, body: {} }), "runner_unreachable"],
		["a runner that refuses", () => (runner = { ...runner, status: 400, body: { error: "browser missing" } }), "runner_rejected"],
	])("ends the run with an actionable code for %s", async (_why, arrange, code) => {
		arrange();
		const r = await call("POST", "/i1/local-browser/runs", { objective: "x" });
		expect(r.body).toMatchObject({ status: "failed", errorCode: code });
		// A failed dispatch frees the slot.
		runner = { status: 202, body: { taskId: "t" }, taskTypes: null };
		getBoundRunnerConn.mockResolvedValue({ runnerNode: "mac", instanceId: "i1", userId: "u1", relayName: "i1:node:mac", endpointUrl: "relay://", token: "", env: {} });
		expect((await call("POST", "/i1/local-browser/runs", { objective: "again" })).body.status).toBe("running");
	});

	it("pauses and resumes on the runner's events, ignores invalid ones, then ends on a valid result", async () => {
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		const at = "2026-10-07T01:00:00Z";
		const paused = await call("POST", `/i1/local-browser/runs/${run.id}/events`, { events: [{ type: "browser.navigated", at, url: "https://seek.com.au/", detail: { cookie: "sid" } }, { type: "run.paused", at, pauseReason: "captcha" }, { type: "run.ended", at }] });
		expect(paused.body).toEqual({ accepted: 2, rejected: 1, dropped: 0, status: "paused" });
		expect((await call("GET", `/i1/local-browser/runs/${run.id}`)).body).toMatchObject({ status: "paused", pauseReason: "captcha" });
		expect((await call("POST", `/i1/local-browser/runs/${run.id}/events`, { events: [{ type: "run.resumed", at }] })).body.status).toBe("running");

		expect((await call("POST", `/i1/local-browser/runs/${run.id}/result`, { runId: run.id, outcome: "completed" })).status).toBe(400);
		const done = await call("POST", `/i1/local-browser/runs/${run.id}/result`, { runId: run.id, outcome: "completed", traceId: "t", engineAuth: "subscription", summary: "1 lead", findings: [{ title: "Dev", url: "https://seek.com.au/job/1", evidence: "Dev — Sydney", fields: {} }], sourceFailures: [] });
		expect(done.body).toMatchObject({ status: "completed", engineAuth: "subscription", result: { findings: [{ title: "Dev" }] } });
		const trace = (await call("GET", `/i1/local-browser/runs/${run.id}/events`)).body.events;
		expect(trace.map((e: { type: string }) => e.type)).toEqual(["run.requested", "runner.dispatched", "browser.navigated", "run.paused", "run.resumed", "run.ended"]);
		expect(trace[2].detail).toBeUndefined(); // the cookie was the only detail, and it never reached storage
		// Terminal: no more events, no second result, no cancel.
		expect((await call("POST", `/i1/local-browser/runs/${run.id}/events`, { events: [{ type: "note", at }] })).status).toBe(409);
		expect((await call("POST", `/i1/local-browser/runs/${run.id}/cancel`)).status).toBe(409);
	});

	it("cancels an active run and tells the runner", async () => {
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		const r = await call("POST", `/i1/local-browser/runs/${run.id}/cancel`);
		expect(r.body).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
		expect(sent.at(-1)).toMatchObject({ path: "/local-browser/cancel", body: { runId: run.id } });
	});

	it("keeps runs to their owner and instance", async () => {
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i2', 'scout', 'u1', 'active', '{}')`);
		expect((await call("GET", `/i2/local-browser/runs/${run.id}`)).status).toBe(404);
		expect((await call("GET", `/other/local-browser/runs/${run.id}`)).status).toBe(404);
		expect((await call("GET", "/i1/local-browser/runs")).body.runs).toHaveLength(1);
	});
});

describe("consent", () => {
	it("records, lists and withdraws a decision", async () => {
		expect((await call("PUT", "/i1/local-browser/consent", { scope: "navigate", domain: "https://seek.com.au", decision: "allow" })).status).toBe(400);
		const set = await call("PUT", "/i1/local-browser/consent", { scope: "navigate", domain: "Seek.com.au", decision: "allow", ttlDays: 30 });
		expect(set.body.consent).toEqual([expect.objectContaining({ domain: "seek.com.au", scope: "navigate", decision: "allow", expiresAt: expect.any(Number) })]);
		expect((await call("PUT", "/i1/local-browser/consent", { scope: "navigate", domain: "seek.com.au", decision: null })).body.consent).toEqual([]);
	});
});

describe("pulling state from the runner (#944)", () => {
	const at = "2026-10-07T01:00:00Z";
	const result = (runId: string) => ({ runId, outcome: "completed", traceId: runId, engineAuth: "subscription", summary: "1 lead", findings: [{ title: "Dev", url: "https://seek.com.au/job/1", evidence: "Dev — Sydney", fields: {} }], sourceFailures: [] });

	it("reading a run pulls its new events from the runner, from where the last pull stopped", async () => {
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		runner.paths = { "/local-browser/status": { status: 200, body: { runId: run.id, state: "paused", pauseReason: "captcha", lastSeq: 2, events: [{ seq: 1, type: "browser.navigated", at, url: "https://seek.com.au/", domain: "seek.com.au" }, { seq: 2, type: "run.paused", at, pauseReason: "captcha" }] } } };
		expect((await call("GET", `/i1/local-browser/runs/${run.id}`)).body).toMatchObject({ status: "paused", pauseReason: "captcha", runnerSeq: 2 });
		expect(sent.filter((x) => x.path === "/local-browser/status").at(-1)?.body).toEqual({ runId: run.id, afterSeq: 0 });
		await call("GET", `/i1/local-browser/runs/${run.id}`);
		expect(sent.filter((x) => x.path === "/local-browser/status").at(-1)?.body).toEqual({ runId: run.id, afterSeq: 2 });
	});

	it("ends the run with the runner's result once the runner says it ended", async () => {
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		runner.paths = { "/local-browser/status": { status: 200, body: { runId: run.id, state: "ended", lastSeq: 1, events: [{ seq: 1, type: "engine.ended", at }], result: result(run.id) } } };
		const events = (await call("GET", `/i1/local-browser/runs/${run.id}/events`)).body.events;
		expect(events.map((e: { type: string }) => e.type)).toEqual(["run.requested", "runner.dispatched", "engine.ended", "run.ended"]);
		expect((await call("GET", `/i1/local-browser/runs/${run.id}`)).body).toMatchObject({ status: "completed", engineAuth: "subscription", result: { summary: "1 lead" } });
	});

	it("names a CLI that is not signed in", async () => {
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		runner.paths = { "/local-browser/status": { status: 200, body: { runId: run.id, state: "ended", lastSeq: 0, events: [], result: { ...result(run.id), outcome: "failed", findings: [], engineAuth: "missing_login", error: "Run `codex login`" } } } };
		const got = (await call("GET", `/i1/local-browser/runs/${run.id}`)).body;
		expect(got).toMatchObject({ status: "failed", errorCode: "engine_not_signed_in", engineAuth: "missing_login" });
	});

	it("ends a run its runner no longer holds, rather than showing it running forever", async () => {
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		runner.paths = { "/local-browser/status": { status: 404, body: { error: "No local browser run" } } };
		expect((await call("GET", `/i1/local-browser/runs/${run.id}`)).body).toMatchObject({ status: "failed", errorCode: "runner_lost" });
	});

	it("leaves a run alone while its runner is briefly unreachable", async () => {
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		getBoundRunnerConn.mockResolvedValue(null);
		expect((await call("GET", `/i1/local-browser/runs/${run.id}`)).body.status).toBe("running");
	});

	it("resumes a paused run with the owner's current decisions", async () => {
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		runner.paths = { "/local-browser/status": { status: 200, body: { runId: run.id, state: "paused", pauseReason: "consent_required", lastSeq: 1, events: [{ seq: 1, type: "run.paused", at, pauseReason: "consent_required" }] } } };
		await call("GET", `/i1/local-browser/runs/${run.id}`);
		await call("PUT", "/i1/local-browser/consent", { scope: "navigate", domain: "indeed.com", decision: "allow" });
		const paths = runner.paths;
		paths["/local-browser/resume"] = { status: 200, body: {}, onCall: () => (paths["/local-browser/status"] = { status: 200, body: { runId: run.id, state: "running", lastSeq: 2, events: [{ seq: 2, type: "run.resumed", at }] } }) };
		const resumed = await call("POST", `/i1/local-browser/runs/${run.id}/resume`);
		expect(resumed.body).toMatchObject({ status: "running" });
		expect(sent.find((x) => x.path === "/local-browser/resume")?.body).toEqual({ runId: run.id, consentedDomains: ["indeed.com"], denyDomains: [], profileConsented: false });
		expect((await call("POST", `/i1/local-browser/runs/${run.id}/resume`)).status).toBe(409);
	});

	it("is what the cron does for every active run, and it prunes traces past their retention", async () => {
		const { syncActiveLocalBrowserRuns } = await import("../lib/local-browser/sync.js");
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		runner.paths = { "/local-browser/status": { status: 200, body: { runId: run.id, state: "ended", lastSeq: 0, events: [], result: result(run.id) } } };
		expect(await syncActiveLocalBrowserRuns({ DB: d1.DB, RELAY: relay } as unknown as Env)).toBe(1);
		expect((await d1.DB.prepare("SELECT status FROM local_browser_runs WHERE id = ?1").bind(run.id).first<{ status: string }>())?.status).toBe("completed");
		d1.exec(`UPDATE local_browser_runs SET ended_at = 1 WHERE id = '${run.id}'`);
		await syncActiveLocalBrowserRuns({ DB: d1.DB, RELAY: relay } as unknown as Env);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_browser_run_events WHERE run_id = ?1").bind(run.id).first<{ n: number }>())?.n).toBe(0);
	});
});

describe("the owner is told when a run pauses (#946)", () => {
	it("sends a local-browser alert linked to the run's page", async () => {
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "Find TypeScript roles" })).body;
		runner.paths = { "/local-browser/status": { status: 200, body: { runId: run.id, state: "paused", pauseReason: "captcha", lastSeq: 1, events: [{ seq: 1, type: "run.paused", at: "2026-10-07T01:00:00Z", pauseReason: "captcha" }] } } };
		await call("GET", `/i1/local-browser/runs/${run.id}`);
		const note = await d1.DB.prepare("SELECT type, title FROM notifications WHERE user_id = 'u1'").first<{ type: string; title: string }>();
		expect(note).toEqual({ type: "local-browser", title: "⏸ Job Search Scout hit a captcha only a person can solve" });
		// Reading it again does not notify again: the run is already paused.
		await call("GET", `/i1/local-browser/runs/${run.id}`);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM notifications").first<{ n: number }>())?.n).toBe(1);
	});
});

describe("reviewing findings (#946)", () => {
	const finding = (n: number) => ({ title: `Dev ${n}`, url: `https://seek.com.au/job/${n}`, evidence: `Dev ${n} — Sydney`, fields: { salary: 100 + n } });
	async function finishedRun(collection: Record<string, unknown> | null = { name: "job_leads" }) {
		if (collection) await call("PUT", "/i1/local-browser/settings", { collection });
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		runner.paths = { "/local-browser/status": { status: 200, body: { runId: run.id, state: "ended", lastSeq: 0, events: [], result: { runId: run.id, outcome: "completed", traceId: run.id, engineAuth: "subscription", summary: "2", findings: [finding(1), finding(2)], sourceFailures: [] } } } };
		await call("GET", `/i1/local-browser/runs/${run.id}`);
		return run.id as string;
	}

	it("saves a finding to the run's collection with where it came from, and skips another without writing", async () => {
		const runId = await finishedRun();
		const saved = await call("POST", `/i1/local-browser/runs/${runId}/findings/0/save`);
		expect(saved.body.findingReviews["0"]).toMatchObject({ decision: "saved", collection: "job_leads", recordId: "rec_1" });
		expect(collections.job_leads[0].data).toEqual({ salary: 101, title: "Dev 1", url: "https://seek.com.au/job/1", evidence: "Dev 1 — Sydney", sourceRunId: runId });
		const skipped = await call("POST", `/i1/local-browser/runs/${runId}/findings/1/skip`);
		expect(skipped.body.findingReviews["1"]).toMatchObject({ decision: "skipped" });
		expect(collections.job_leads).toHaveLength(1);
		expect((await call("POST", `/i1/local-browser/runs/${runId}/findings/0/save`)).status).toBe(409);
	});

	it("reports a duplicate BEFORE writing, and saves it only when told to", async () => {
		collections.job_leads = [{ id: "rec_old", data: { url: "https://seek.com.au/job/1" } }];
		const runId = await finishedRun();
		const dup = await call("POST", `/i1/local-browser/runs/${runId}/findings/0/save`);
		expect(dup.body.findingReviews["0"]).toMatchObject({ decision: "duplicate", duplicateOf: "rec_old" });
		expect(collections.job_leads).toHaveLength(1);
		const forced = await call("POST", `/i1/local-browser/runs/${runId}/findings/0/save`, { force: true });
		expect(forced.body.findingReviews["0"]).toMatchObject({ decision: "saved" });
		expect(collections.job_leads).toHaveLength(2);
	});

	it("checks duplicates on the collection's own key field", async () => {
		collections.job_leads = [{ id: "rec_old", data: { salary: 102 } }];
		const runId = await finishedRun({ name: "job_leads", keyField: "salary" });
		expect((await call("POST", `/i1/local-browser/runs/${runId}/findings/1/save`)).body.findingReviews["1"]).toMatchObject({ decision: "duplicate" });
	});

	it("refuses to save with no collection set, and a finding that does not exist", async () => {
		const runId = await finishedRun(null);
		expect((await call("POST", `/i1/local-browser/runs/${runId}/findings/0/save`)).body.error).toMatch(/No results collection/);
		expect((await call("POST", `/i1/local-browser/runs/${runId}/findings/9/skip`)).status).toBe(404);
		expect((await call("POST", `/i1/local-browser/runs/${runId}/findings/-1/skip`)).status).toBe(400);
	});
});

describe("console links to research (#946)", () => {
	it("links a research run id to its run page, and the Research tab only for a local browser agent", async () => {
		const { instanceRoutes: routes } = await import("./instances.js");
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/instances", routes);
		app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
		const get = async (q: string, inst = "i1") => (await app.request(`/v1/instances/${inst}/console-link${q}`, {}, { DB: d1.DB } as unknown as Env)).json() as Promise<Record<string, string>>;
		const run = (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
		expect((await get(`?run_id=${run.id}`)).path).toBe(`/console/instances/i1/research/${run.id}`);
		expect((await get("?section=research")).path).toBe("/console/instances/i1/research");
		expect((await get("?section=research", "ic")).error).toMatch(/does not show the Research tab/);
	});
});
