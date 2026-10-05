/**
 * coding_diagnostics reports the machine it is talking about, as fresh as the last contact (#922).
 *
 * Two contradictions from the live report, both read off real rows here:
 *  - after a repin to `Macmini`, a live socket and `healthCheck: "ok"` sat beside a `lastSeenAt` from
 *    a month earlier — only the heartbeat moved it, and it stamped another name of the same machine;
 *  - an offline agent pinned to `pink-laptop` reported the shared runtime row's machine — whoever
 *    registered last — for its `lastSeenAt` and stored status.
 * Only the relay/runner seams are faked; the database is the real schema.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn(), callRunner: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/runner-client.js")>()),
	getBoundRunnerConn,
	callRunner,
}));

const { registerDiagnosticsRoutes } = await import("./coding-diagnostics.js");

const SECRET = "diag-freshness-secret";
let d1: RealSchemaD1;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't922-diag', 'Coder')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'ag', 'u1', 'active', '{"runnerNode":"pink-laptop"}')`);
	const node = (name: string, seen: string, status = "online") =>
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at)
		         VALUES ('i1', 'u1', '${name}', 'relay://', '0.4.69', '${status}', '${seen}')`);
	node("pink-laptop", "2026-10-05 06:04:19", "registered");
	node("Macmini", "2026-09-11 23:35:32");
	// The shared row holds the last registrant — the Mac mini, not the machine the agent is pinned to.
	d1.exec(`INSERT INTO instance_runtimes (instance_id, user_id, endpoint_url, runner_version, runner_node, status, last_seen_at)
	         VALUES ('i1', 'u1', 'relay://', '0.4.69', 'Sergeys-Mac-mini.local', 'online', '2026-10-05 06:06:10')`);
	getBoundRunnerConn.mockReset();
	callRunner.mockReset();
	callRunner.mockResolvedValue({ ok: true });
});
afterEach(() => d1.close());

async function diag() {
	const routes = new Hono<{ Bindings: Env }>();
	registerDiagnosticsRoutes(routes);
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", routes);
	app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	const token = await signSession("u1", SECRET, { roles: [] });
	const res = await app.request("/v1/instances/i1/coding/diagnostics", { headers: { Authorization: `Bearer ${token}` } }, { DB: d1.DB, SESSION_SIGNING_KEY: SECRET } as unknown as Env);
	expect(res.status).toBe(200);
	return ((await res.json()) as { runner: Record<string, unknown> }).runner;
}

const seenAt = (node: string) => d1.DB.prepare("SELECT last_seen_at FROM instance_runtime_nodes WHERE instance_id = 'i1' AND runner_node = ?1").bind(node).first<{ last_seen_at: string }>();

describe("coding_diagnostics freshness (#922)", () => {
	it("moves lastSeenAt when the runner answers its health check, on the node that answered", async () => {
		d1.exec(`UPDATE agent_instances SET config = '{"runnerNode":"Macmini"}' WHERE id = 'i1'`);
		getBoundRunnerConn.mockResolvedValue({ runnerNode: "Macmini", instanceId: "i1", userId: "u1", relayName: "i1:node:Macmini", endpointUrl: "relay://", token: "", env: {} });
		const before = Date.now() - 2_000;
		const runner = await diag();
		expect(runner).toMatchObject({ status: "online", healthCheck: "ok", runnerNode: "Macmini" });
		expect(Date.parse(`${String(runner.lastSeenAt).replace(" ", "T")}Z`)).toBeGreaterThan(before);
		// Persisted, so the next reader — list_runner_nodes, instance_runner_node — sees it too.
		expect((await seenAt("Macmini"))?.last_seen_at).not.toBe("2026-09-11 23:35:32");
		expect((await seenAt("pink-laptop"))?.last_seen_at).toBe("2026-10-05 06:04:19");
	});

	it("does not move it when the health check fails", async () => {
		getBoundRunnerConn.mockResolvedValue({ runnerNode: "Macmini", instanceId: "i1", userId: "u1", relayName: "i1:node:Macmini", endpointUrl: "relay://", token: "", env: {} });
		callRunner.mockRejectedValue(new Error("Runner relay is connected but not responding"));
		await diag();
		expect((await seenAt("Macmini"))?.last_seen_at).toBe("2026-09-11 23:35:32");
	});

	it("describes the PINNED machine when nothing is live, not the shared row's last registrant", async () => {
		getBoundRunnerConn.mockResolvedValue(null);
		const runner = await diag();
		expect(runner).toMatchObject({
			status: "offline",
			relayConnected: false,
			healthCheck: "not_attempted",
			runnerNode: "pink-laptop",
			lastSeenAt: "2026-10-05 06:04:19",
			reportedStatus: "registered",
		});
	});
});

describe("coding_diagnostics reports the machine's resources (#924)", () => {
	const live = () => getBoundRunnerConn.mockResolvedValue({ runnerNode: "Macmini", instanceId: "i1", userId: "u1", relayName: "i1:node:Macmini", endpointUrl: "relay://", token: "", env: {} });
	const store = (load1: number) =>
		d1.exec(`UPDATE instance_runtime_nodes SET resources = '${JSON.stringify({ loadAvg: [load1, 4, 2], cpus: 4, memTotalBytes: 8e9, memFreeBytes: 2e9, platform: "darwin", sampledAt: Date.UTC(2026, 9, 5, 6) })}' WHERE runner_node = 'Macmini'`);

	it("reports the live machine's last sample and its active coding sessions", async () => {
		live();
		store(2);
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'platform')`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, runner_node, client_type, status) VALUES ('s1', 'i1', 'u1', 'r1', 'Macmini', 'claude', 'active')`);
		const runner = await diag();
		expect(runner.resources).toMatchObject({ load1: 2, cpus: 4, loadPerCpu: 0.5, memUsedPct: 75, activeSessions: 1, warnings: [] });
	});

	it("raises a saturated machine as an issue, beside the socket state", async () => {
		live();
		store(9);
		const routes = new Hono<{ Bindings: Env }>();
		registerDiagnosticsRoutes(routes);
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/instances", routes);
		const token = await signSession("u1", SECRET, { roles: [] });
		const res = await app.request("/v1/instances/i1/coding/diagnostics", { headers: { Authorization: `Bearer ${token}` } }, { DB: d1.DB, SESSION_SIGNING_KEY: SECRET } as unknown as Env);
		const body = (await res.json()) as { issues: Array<{ severity: string; message: string }> };
		expect(body.issues).toContainEqual(expect.objectContaining({ severity: "warn", message: expect.stringMatching(/^CPU saturated: 1-minute load 9 on 4 cores/) }));
	});

	it("is null for a runner that sends no sample", async () => {
		live();
		expect((await diag()).resources).toBeNull();
	});
});
