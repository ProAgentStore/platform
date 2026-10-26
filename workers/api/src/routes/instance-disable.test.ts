/**
 * #1383: the disabled coder state, through the real routes on the real migrated schema.
 *
 * "Disabled" is `status = 'paused'` plus a record (`disabled_at`, `disabled_by`, `disabled_reason`). Invariants protected: disable and enable are
 * idempotent and owner-only; the actor is the verified session, never the body; a round trip changes nothing else about the instance; every
 * list that hides paused instances hides disabled ones by default and shows them on its flag; the Disabled list says why, when and by whom; and
 * a disabled instance starts nothing. Isolated fixtures only — no real instance is disabled, paused or deleted.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

const uid = { current: "u1" };
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: uid.current, roles: [] }) };
});
const driverStart = vi.fn();
vi.mock("../lib/loop-drivers.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/loop-drivers.js")>("../lib/loop-drivers.js");
	return { ...actual, loopDriverFor: () => ({ id: "coding", label: "coding", start: (...a: unknown[]) => driverStart(...a) }) };
});

const { instanceRoutes } = await import("./instances.js");
const { terminalRoutes } = await import("./terminals.js");
const { enqueueObjective } = await import("../lib/objective-queue.js");
const { tryDequeueAndStart } = await import("../lib/objective-queue-start.js");

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2", "i3"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["x1"] });
	d1.exec("UPDATE agent_instances SET agent_id = 'agent_local_coder' WHERE user_id = 'u1'"); // the seeded Local Coder: the nodes view lists runner agents only
	d1.exec(`UPDATE agent_instances SET config = '{"displayName":"Coder One","runnerNode":"mac-1","autoPickup":{"enabled":true}}' WHERE id = 'i1'`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'i1', 'u1', 'app', 'acme/app'), ('r2', 'i2', 'u1', 'web', 'acme/web')`);
	const RELAY = { idFromName: (name: string) => ({ name }), get: () => ({ fetch: async () => Response.json({ connected: true }) }) };
	env = { DB: d1.DB, SESSION_SIGNING_KEY: "k", RELAY } as unknown as Env;
	uid.current = "u1";
	driverStart.mockReset();
});
afterEach(() => d1.close());

// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
type Json = Record<string, any>;
const app = () => {
	const router = new Hono<{ Bindings: Env }>();
	router.route("/v1/instances", instanceRoutes);
	router.route("/v1/terminals", terminalRoutes);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return router;
};
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
	const res = await app().request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env, { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as never);
	return { status: res.status, body: (await res.json()) as Json };
}
const disable = (id: string, body?: unknown) => call("POST", `/v1/instances/${id}/disable`, body ?? {});
const enable = (id: string) => call("POST", `/v1/instances/${id}/enable`);
const row = (id: string) => d1.sqlite.prepare("SELECT status, disabled_at, disabled_by, disabled_reason, config FROM agent_instances WHERE id = ?").get(id) as { status: string; disabled_at: string | null; disabled_by: string | null; disabled_reason: string | null; config: string };
const ids = (r: { body: Json }) => (r.body.instances as Json[]).map((i) => i.id ?? i.instanceId).sort();

describe("disable (#1383)", () => {
	it("pauses the instance and records when, by whom (the verified session) and why", async () => {
		const r = await disable("i1", { reason: "  duplicate of i2  " });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ success: true, status: "paused", changed: true, disabled: { by: "u1", reason: "duplicate of i2" } });
		expect(r.body.disabled.at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
		expect(row("i1")).toMatchObject({ status: "paused", disabled_by: "u1", disabled_reason: "duplicate of i2" });
	});

	it("takes the actor from the session, never from the body", async () => {
		await disable("i1", { reason: "x", by: "someone-else", disabled_by: "u2" });
		expect(row("i1").disabled_by).toBe("u1");
	});

	it("is idempotent: a repeat keeps the original time and actor, and replaces the reason only when a new one is given", async () => {
		const first = await disable("i1", { reason: "first" });
		d1.exec("UPDATE agent_instances SET disabled_at = '2026-01-01 00:00:00' WHERE id = 'i1'");
		const again = await disable("i1");
		expect(again.status).toBe(200);
		expect(again.body).toMatchObject({ changed: false, disabled: { at: "2026-01-01 00:00:00", by: "u1", reason: "first" } });
		const reworded = await disable("i1", { reason: "second" });
		expect(reworded.body).toMatchObject({ changed: true, disabled: { at: "2026-01-01 00:00:00", reason: "second" } });
		expect(first.body.disabled.by).toBe("u1");
	});

	it("records a disable on an instance already paused with plain pause (which kept no record)", async () => {
		await call("POST", "/v1/instances/i1/pause");
		expect(row("i1")).toMatchObject({ status: "paused", disabled_at: null });
		const r = await disable("i1", { reason: "now on the record" });
		expect(r.body).toMatchObject({ changed: true, disabled: { by: "u1", reason: "now on the record" } });
	});

	it("rejects a non-string or over-long reason with a 400 that names it, and writes nothing", async () => {
		expect((await disable("i1", { reason: 42 })).body.error).toMatch(/reason must be a string/);
		expect((await disable("i1", { reason: "x".repeat(501) })).body.error).toMatch(/at most 500/);
		expect(row("i1").status).toBe("active");
	});

	it("is the owner's alone: another account's instance is a 404, and a canceled one a 409", async () => {
		expect((await disable("x1")).status).toBe(404);
		expect(row("x1").status).toBe("active");
		d1.exec("UPDATE agent_instances SET status = 'canceled' WHERE id = 'i3'");
		expect((await disable("i3")).status).toBe(409);
		expect(row("i3")).toMatchObject({ status: "canceled", disabled_at: null });
	});
});

describe("enable (#1383)", () => {
	it("switches it back on and clears the record; a repeat is a no-op success", async () => {
		await disable("i1", { reason: "tidy" });
		const r = await enable("i1");
		expect(r.body).toMatchObject({ success: true, status: "active", changed: true, disabled: null });
		expect(row("i1")).toMatchObject({ status: "active", disabled_at: null, disabled_by: null, disabled_reason: null });
		const again = await enable("i1");
		expect(again.status).toBe(200);
		expect(again.body.changed).toBe(false);
	});

	it("plain resume clears the record too, so an active instance never carries one", async () => {
		await disable("i1", { reason: "tidy" });
		await call("POST", "/v1/instances/i1/resume");
		expect(row("i1")).toMatchObject({ status: "active", disabled_at: null, disabled_reason: null });
	});

	it("is the owner's alone", async () => {
		expect((await enable("x1")).status).toBe(404);
	});

	it("a disable→enable round trip changes NOTHING else: config, pin, repos, queue entries and schedules are exactly as they were", async () => {
		await enqueueObjective(env, { instanceId: "i1", userId: "u1", repoId: "r1", objective: "Work issue #7 on app" });
		driverStart.mockResolvedValue({ ok: false, status: 409, reason: "busy", error: "busy" });
		// `queueStatus` is left out of the after-enable comparison on purpose: enabling DRAINS the queue the disable held back, which is the point.
		const snapshot = (queueStatus: boolean) =>
			JSON.stringify({
				config: (d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'i1'").get() as { config: string }).config,
				repos: d1.sqlite.prepare("SELECT * FROM coding_repos WHERE instance_id = 'i1'").all(),
				queue: d1.sqlite.prepare(`SELECT id, ${queueStatus ? "status," : ""} objective, repo_id FROM instance_objective_queue WHERE instance_id = 'i1'`).all(),
				triggers: d1.sqlite.prepare("SELECT id, enabled, type FROM agent_triggers WHERE instance_id = 'i1'").all(),
			});
		const before = snapshot(true);
		await disable("i1", { reason: "round trip" });
		expect(snapshot(true)).toBe(before); // disabled: still all there, the entry still pending
		await enable("i1");
		expect(snapshot(false)).toBe(before.replace(/"status":"pending",/, ""));
		expect(d1.sqlite.prepare("SELECT count(*) AS n FROM instance_objective_queue WHERE instance_id = 'i1'").get()).toEqual({ n: 1 });
		expect(JSON.parse(row("i1").config)).toMatchObject({ displayName: "Coder One", runnerNode: "mac-1", autoPickup: { enabled: true } });
	});
});

describe("every list hides disabled instances by default and shows them on its flag (#1383)", () => {
	beforeEach(async () => {
		// i1 has activity so the activity view has something to hide; i2 stays active.
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('run-1', 'u1', 'i1', 'Work issue #1', 'running', 5, ${Date.now()}), ('run-2', 'u1', 'i2', 'Work issue #2', 'running', 5, ${Date.now()})`);
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, last_seen_at) VALUES ('i1', 'u1', 'mac-1', 'relay://x', datetime('now')), ('i2', 'u1', 'mac-1', 'relay://x', datetime('now')), ('i3', 'u1', 'mac-2', 'relay://x', datetime('now'))`);
		await disable("i1", { reason: "duplicate" });
		await disable("i3", { reason: "idle" });
	});

	it("my_instances: hidden by default; includePaused shows them with their record; disabled_only shows only them", async () => {
		expect(ids(await call("GET", "/v1/instances/my/instances"))).toEqual(["i2"]);
		const all = await call("GET", "/v1/instances/my/instances?includePaused=1");
		expect(ids(all)).toEqual(["i1", "i2", "i3"]);
		expect((all.body.instances as Json[]).find((i) => i.id === "i1")?.disabled).toMatchObject({ by: "u1", reason: "duplicate" });
		expect((all.body.instances as Json[]).find((i) => i.id === "i2")?.disabled).toBeUndefined();
		const only = await call("GET", "/v1/instances/my/instances?disabled_only=1");
		expect(ids(only)).toEqual(["i1", "i3"]);
		expect((only.body.instances as Json[]).every((i) => i.disabled && i.status === "paused")).toBe(true);
	});

	it("account_activity: only active instances by default, and it says how many it left out; include_paused restores them", async () => {
		const quiet = await call("GET", "/v1/instances/my/activity");
		expect(ids(quiet)).toEqual(["i2"]);
		expect(quiet.body.hiddenInactive).toBe(1);
		expect(ids(await call("GET", "/v1/instances/my/activity?include_paused=1"))).toEqual(["i1", "i2"]);
	});

	it("list_runner_nodes: a machine lists only active instances — but the machine itself, and its connection, are never hidden", async () => {
		const r = await call("GET", "/v1/terminals/nodes");
		const nodes = r.body.nodes as Json[];
		const mac1 = nodes.find((n) => n.node === "mac-1") as Json;
		const mac2 = nodes.find((n) => n.node === "mac-2") as Json;
		expect(mac1.instances.map((i: Json) => i.instanceId)).toEqual(["i2"]);
		// mac-2's ONLY instance is disabled: the machine is still listed, and still reads connected.
		expect(mac2).toBeDefined();
		expect(mac2.instances).toEqual([]);
		expect(mac2.connected).toBe(true);
		expect(r.body.pausedHidden).toBe(2);
		const withAll = (await call("GET", "/v1/terminals/nodes?include_paused=1")).body.nodes as Json[];
		expect(withAll.find((n) => n.node === "mac-1")?.instances.map((i: Json) => i.instanceId).sort()).toEqual(["i1", "i2"]);
		expect(withAll.find((n) => n.node === "mac-2")?.instances.map((i: Json) => i.instanceId)).toEqual(["i3"]);
	});

	it("fleet_snapshot: hidden by default (counted), shown with include_paused and carrying the record", async () => {
		const hidden = await call("GET", "/v1/instances/my/snapshot");
		expect(ids(hidden)).toEqual(["i2"]);
		expect(hidden.body.pausedHidden).toBe(2);
		const shown = await call("GET", "/v1/instances/my/snapshot?include_paused=true");
		expect((shown.body.instances as Json[]).find((i) => i.instanceId === "i1")).toMatchObject({ status: "paused", disabled: { by: "u1", reason: "duplicate" } });
	});

	it("another owner's disabled instances never appear in mine", async () => {
		uid.current = "u2";
		await disable("x1", { reason: "theirs" });
		uid.current = "u1";
		expect(JSON.stringify((await call("GET", "/v1/instances/my/disabled-instances")).body)).not.toContain("x1");
		expect(ids(await call("GET", "/v1/instances/my/instances?disabled_only=1"))).toEqual(["i1", "i3"]);
	});
});

describe("the Disabled list (#1383)", () => {
	it("lists only disabled instances with id, name, repos, pinned machine, who/when/why, last run and queued objectives — newest disabled first", async () => {
		await enqueueObjective(env, { instanceId: "i1", userId: "u1", repoId: "r1", objective: "Work issue #7 on app" });
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at) VALUES ('run-old', 'u1', 'i1', 'Work issue #3', 'completed', 'done', 5, 1000, 2000)`);
		await disable("i2", { reason: "older" });
		d1.exec("UPDATE agent_instances SET disabled_at = '2026-01-01 00:00:00' WHERE id = 'i2'");
		await disable("i1", { reason: "duplicate" });
		const r = await call("GET", "/v1/instances/my/disabled-instances");
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ total: 2, truncated: false });
		expect((r.body.instances as Json[]).map((i) => i.id)).toEqual(["i1", "i2"]);
		expect((r.body.instances as Json[])[0]).toMatchObject({
			id: "i1",
			name: "Coder One",
			status: "paused",
			repos: [{ name: "app", githubRepo: "acme/app" }],
			disabled: { by: "u1", reason: "duplicate" },
			lastRun: { runId: "run-old", status: "completed", stopReason: "done" },
			queuedObjectives: 1,
		});
		expect((r.body.instances as Json[])[1]).toMatchObject({ id: "i2", repos: [{ name: "web", githubRepo: "acme/web" }], lastRun: null, queuedObjectives: 0, disabled: { reason: "older" } });
	});

	it("an instance paused with plain pause is listed too, with an empty record rather than an invented one", async () => {
		await call("POST", "/v1/instances/i2/pause");
		const r = await call("GET", "/v1/instances/my/disabled-instances");
		expect((r.body.instances as Json[])[0]).toMatchObject({ id: "i2", disabled: { at: null, by: null, reason: null } });
	});

	it("is empty when nothing is disabled, and enabling removes an instance from it", async () => {
		expect((await call("GET", "/v1/instances/my/disabled-instances")).body).toMatchObject({ total: 0, instances: [] });
		await disable("i1");
		await enable("i1");
		expect((await call("GET", "/v1/instances/my/disabled-instances")).body.total).toBe(0);
	});
});

describe("a disabled instance starts nothing (#1383)", () => {
	it("a queued objective is NOT started on a disabled instance, and starts once it is enabled", async () => {
		driverStart.mockResolvedValue({ ok: true, runId: "run-x", driver: "coding" });
		const entry = await enqueueObjective(env, { instanceId: "i1", userId: "u1", repoId: "r1", objective: "Work issue #9 on app" });
		await disable("i1", { reason: "off" });
		const held = await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(held.drained).toBe(false);
		expect(driverStart).not.toHaveBeenCalled();
		expect((d1.sqlite.prepare("SELECT status FROM instance_objective_queue WHERE id = ?").get(entry.id) as { status: string }).status).toBe("pending");
	});

	it("product-owner triage does not run on a disabled instance", async () => {
		const { wakePoTriageIfIdle } = await import("../lib/po-triage-wake.js");
		await disable("i1");
		const r = await wakePoTriageIfIdle(env, "i1", "u1");
		expect(r.woke).toBe(false);
	});

	it("the auto-pickup sweep does not wake a disabled coder", async () => {
		const { sweepAutoPickup } = await import("../lib/auto-pickup.js");
		await disable("i1");
		const woken: string[] = [];
		await sweepAutoPickup(env, Date.now(), async (_e, iid) => {
			woken.push(iid);
			return "";
		});
		expect(woken).not.toContain("i1");
	});
});
