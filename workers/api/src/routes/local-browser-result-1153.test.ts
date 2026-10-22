/**
 * #1153: the runner's result is normalised and validated before outcome handling. Same harness as local-browser-routes.test.ts
 * (real schema; only the relay/runner seam is faked). A version difference is read, a malformed result fails the run CLOSED with a
 * reason that names the field, and a runner that is away or answers badly is NOT filed as a malformed result.
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
let runner: { status: number; body: unknown; taskTypes: string[] | null; capabilitiesThrow?: boolean; paths?: Record<string, { status: number; body: unknown; onCall?: () => void }> };
let sent: Array<{ method: string; path: string; body: unknown }>;
const relay = {
	idFromName: (n: string) => n,
	get: () => ({
		fetch: async (req: Request) => {
			const cmd = (await req.json()) as { method: string; path: string; body: unknown };
			sent.push(cmd);
			if (cmd.path === "/capabilities" && runner.capabilitiesThrow) throw new Error("Runner relay is connected but not responding");
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

/** In-memory R2 for replay frames (#1063). */
const stored = new Map<string, Uint8Array>();
const STORAGE = { put: async (k: string, v: Uint8Array) => void stored.set(k, v), get: async (k: string) => (stored.has(k) ? { body: stored.get(k) } : null), delete: async (k: string) => void stored.delete(k) };

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { DB: d1.DB, RELAY: relay, AGENT: agentDO, STORAGE } as unknown as Env);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}


const at = "2026-10-07T01:00:00Z";
const finding = (fields: Record<string, unknown> = { verification_outcome: "active" }) => ({ title: "Dev", url: "https://seek.com.au/job/1", evidence: "Dev — Sydney", fields });
const full = (runId: string) => ({ runId, outcome: "completed", traceId: runId, engineAuth: "subscription", summary: "ok", findings: [finding()], sourceFailures: [] });
const ended = (runId: string, result: unknown) => ({ "/local-browser/status": { status: 200, body: { runId, state: "ended", lastSeq: 1, events: [{ seq: 1, type: "engine.ended", at }], result } } });
const start = async () => (await call("POST", "/i1/local-browser/runs", { objective: "x" })).body;
const read = async (id: string) => (await call("GET", `/i1/local-browser/runs/${id}`)).body;

describe("an older or newer runner's result is read, not refused (#1153)", () => {
	it("a result without traceId or engineAuth completes the run, and the run.ended event says what was normalised", async () => {
		const run = await start();
		const { traceId: _t, engineAuth: _e, ...older } = full(run.id);
		runner.paths = ended(run.id, older);
		expect(await read(run.id)).toMatchObject({ status: "completed", engineAuth: "unknown", result: { traceId: run.id } });
		const events = (await call("GET", `/i1/local-browser/runs/${run.id}/events`)).body.events as Array<{ type: string; detail?: { normalized?: string[] } }>;
		expect(events.find((e) => e.type === "run.ended")?.detail?.normalized?.join(" ")).toMatch(/traceId was missing/);
	});

	it("an unknown source-failure reason from a newer runner does not fail the run", async () => {
		const run = await start();
		runner.paths = ended(run.id, { ...full(run.id), sourceFailures: [{ url: "https://seek.com.au/", reason: "geo_blocked" }] });
		const got = await read(run.id);
		expect(got).toMatchObject({ status: "completed" });
		expect(got.result.sourceFailures).toEqual([{ url: "https://seek.com.au/", reason: "error", detail: "reason: geo_blocked" }]);
	});
});

describe("a malformed result fails the run closed, with a reason that can be acted on (#1153)", () => {
	it("a finding without evidence: failed/runner_result_invalid, naming the path, the field and the cure — and the run is over", async () => {
		const run = await start();
		runner.paths = ended(run.id, { ...full(run.id), findings: [finding(), { title: "x", url: "https://seek.com.au/job/2" }] });
		const got = await read(run.id);
		expect(got).toMatchObject({ status: "failed", errorCode: "runner_result_invalid" });
		expect(got.error).toMatch(/findings\[1\] needs evidence \(got missing\)/);
		expect(got.error).toMatch(/pags update/);
		expect(got.result ?? null).toBeNull(); // nothing from a refused envelope is kept as a result
		const events = (await call("GET", `/i1/local-browser/runs/${run.id}/events`)).body.events as Array<{ type: string; detail?: Record<string, unknown> }>;
		expect(events.find((e) => e.type === "run.ended")?.detail).toMatchObject({ status: "failed", errorCode: "runner_result_invalid" });
	});

	it("a result for a different run is refused too", async () => {
		const run = await start();
		runner.paths = ended(run.id, full("some-other-run"));
		expect(await read(run.id)).toMatchObject({ status: "failed", errorCode: "runner_result_invalid" });
	});

	it("'ended' with no result at all is a malformed result, said once — not a runner that went quiet", async () => {
		const run = await start();
		runner.paths = ended(run.id, undefined);
		const got = await read(run.id);
		expect(got).toMatchObject({ status: "failed", errorCode: "runner_result_invalid" });
		expect(got.error).toMatch(/ended but sent no result/);
	});
});

describe("a runner that is away or answers badly is NOT a malformed result (#1153)", () => {
	it("no connected runner: the run is left as it was", async () => {
		const run = await start();
		getBoundRunnerConn.mockResolvedValue(null);
		expect((await read(run.id)).status).toBe("running");
	});

	it("a status reply that is not a JSON object, or a non-2xx, leaves the run running", async () => {
		const run = await start();
		for (const body of [null, "<html>bad gateway</html>", [1, 2]]) {
			runner.paths = { "/local-browser/status": { status: 200, body } };
			expect(await read(run.id)).toMatchObject({ status: "running" });
		}
		runner.paths = { "/local-browser/status": { status: 502, body: { error: "bad gateway" } } };
		expect((await read(run.id)).status).toBe("running");
	});

	it("a runner that no longer holds the run is runner_lost, not runner_result_invalid", async () => {
		const run = await start();
		runner.paths = { "/local-browser/status": { status: 404, body: { error: "No local browser run" } } };
		expect(await read(run.id)).toMatchObject({ status: "failed", errorCode: "runner_lost" });
	});
});
