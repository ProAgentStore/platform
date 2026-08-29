/**
 * coding_diagnostics live-reachability regression (#691).
 *
 * The bug: `coding_diagnostics` resolved the runner connection by passing
 * `runtimeRow?.runner_node` (the stale shared `instance_runtimes` row) to
 * `getRunnerConn`, so after a `set_runner_node` repin the tool probed the OLD
 * hostname — which had no live socket — and reported "not reachable" while
 * `instance_runtime_status` (using `getBoundRunnerConn`) correctly showed the new
 * node as online.
 *
 * The fix: use `getBoundRunnerConn` (pin-aware, relay-live-checked) for the probe,
 * and `getLiveRuntime` for the runtime metadata row, so node, version, and
 * last_seen_at all reflect the LIVE node rather than the stale default row.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

// Stub the two live-resolution seams at the module boundary, leaving everything else real.
const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({
	getBoundRunnerConn: vi.fn(),
	callRunner: vi.fn(),
}));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/runner-client.js")>()),
	getBoundRunnerConn,
	callRunner,
}));

// getLiveRuntime reads the per-node row for the live connection. Stub it so we can control
// which node's metadata is returned without setting up a real D1 database.
const { getLiveRuntime } = vi.hoisted(() => ({ getLiveRuntime: vi.fn() }));
vi.mock("./instances-runtime.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./instances-runtime.js")>()),
	getLiveRuntime,
}));

import { registerDiagnosticsRoutes } from "./coding-diagnostics.js";

const SECRET = "diag-test-secret";
const UID = "user-1";
const INSTANCE = "inst-1";

/** Old node (stale `instance_runtimes` row) — offline after repin. */
const OLD_NODE = "RLs-MacBook-Air.local";
/** New node (where the runner actually is after repin). */
const NEW_NODE = "Sergeys-Mac-mini.local";

/**
 * Build an Env whose `instance_runtimes` default row still names the OLD node — the
 * state the system is in immediately after `set_runner_node` writes the pin to
 * `agent_instances.config` but before the old runner re-registers under the new name.
 */
function buildEnv(opts: {
	/** What `instance_runtimes` row runner_node holds — the STALE node after repin. */
	staleNode?: string;
	/** Rows in `instance_runtimes` to return (null = unregistered). */
	hasRuntimeRow?: boolean;
}): Env {
	const staleNode = opts.staleNode ?? OLD_NODE;
	const DB = {
		prepare(sql: string) {
			return {
				bind(..._args: unknown[]) {
					return {
						async first() {
							if (sql.includes("FROM agent_instances")) return { id: INSTANCE };
							if (sql.includes("FROM instance_runtimes") && opts.hasRuntimeRow !== false) {
								return {
									endpoint_url: `http://${staleNode}`,
									capabilities: "[]",
									runner_version: "0.4.51",
									runner_node: staleNode,
									status: "registered",
									last_seen_at: "2026-08-16 09:00:29",
									placement: "local",
									created_at: "2026-08-01 00:00:00",
									updated_at: "2026-08-16 09:00:29",
								};
							}
							return null;
						},
						async all() { return { results: [] }; },
						async run() { return { meta: { changes: 0 } }; },
					};
				},
			};
		},
	};
	return { SESSION_SIGNING_KEY: SECRET, DB } as unknown as Env;
}

function buildApp(opts: Parameters<typeof buildEnv>[0] = {}) {
	const env = buildEnv(opts);
	const app = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerDiagnosticsRoutes(routes);
	app.route("/v1/instances", routes);
	app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	return { app, env };
}

async function getDiag(app: Hono<{ Bindings: Env }>, env: Env) {
	const token = await signSession(UID, SECRET, { roles: [] });
	const res = await app.request(
		`/v1/instances/${INSTANCE}/coding/diagnostics`,
		{ method: "GET", headers: { Authorization: `Bearer ${token}` } },
		env,
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
	getBoundRunnerConn.mockReset();
	callRunner.mockReset();
	getLiveRuntime.mockReset();
	getBoundRunnerConn.mockResolvedValue(null);
	getLiveRuntime.mockResolvedValue(null);
	// By default runner calls return a minimal health response.
	callRunner.mockResolvedValue({ ok: true, service: "proagentstore-browser-runtime" });
});

describe("coding_diagnostics live-reachability (#691)", () => {
	it("reports runner online and uses the LIVE node after a repin, not the stale DB row", async () => {
		// The repinned instance: `instance_runtimes` still carries OLD_NODE but the user
		// has repinned to NEW_NODE, and NEW_NODE holds a live relay socket.
		const liveConn = {
			endpointUrl: `http://${NEW_NODE}`,
			token: "tok",
			instanceId: INSTANCE,
			userId: UID,
			env: {} as Env,
			runnerNode: NEW_NODE,
			relayName: `${INSTANCE}:node:${NEW_NODE}`,
		};
		getBoundRunnerConn.mockResolvedValue(liveConn);
		getLiveRuntime.mockResolvedValue({
			endpoint_url: `http://${NEW_NODE}`,
			capabilities: "[]",
			runner_version: "0.4.54",
			runner_node: NEW_NODE,
			status: "registered",
			last_seen_at: "2026-08-16 09:03:48",
			placement: "local",
			created_at: "2026-08-01 00:00:00",
			updated_at: "2026-08-16 09:03:48",
			instance_id: INSTANCE,
		});
		callRunner.mockResolvedValue({ ok: true, service: "proagentstore-browser-runtime" });

		const { app, env } = buildApp({ staleNode: OLD_NODE });
		const { status, body } = await getDiag(app, env);

		expect(status).toBe(200);
		const runner = body.runner as Record<string, unknown>;
		const summary = body.summary as Record<string, unknown>;
		const relay = body.relay as Record<string, unknown>;

		// Must report the LIVE node, not the stale DB row.
		expect(runner.runnerNode).toBe(NEW_NODE);
		expect(runner.runnerVersion).toBe("0.4.54");
		expect(runner.lastSeenAt).toBe("2026-08-16 09:03:48");
		expect(runner.reachable).toBe(true);

		// relay should name the live node too.
		expect(relay.connected).toBe(true);
		expect(relay.runnerNode).toBe(NEW_NODE);
		expect(relay.relayName).toContain(NEW_NODE);

		// summary: no "not reachable" error.
		expect(summary.runnerOnline).toBe(true);
		expect(summary.relayConnected).toBe(true);
		const issues = body.issues as Array<Record<string, unknown>>;
		const errors = issues.filter((i) => i.severity === "error");
		expect(errors).toHaveLength(0);
	});

	it("reports runner offline when getBoundRunnerConn returns null (no live socket)", async () => {
		// Runner is genuinely offline — getBoundRunnerConn finds nothing.
		getBoundRunnerConn.mockResolvedValue(null);

		const { app, env } = buildApp({ staleNode: OLD_NODE });
		const { status, body } = await getDiag(app, env);

		expect(status).toBe(200);
		const runner = body.runner as Record<string, unknown>;
		const summary = body.summary as Record<string, unknown>;
		const relay = body.relay as Record<string, unknown>;

		// Stale row data still shown for description purposes.
		expect(runner.registered).toBe(true);
		expect(runner.reachable).toBe(false);

		expect(summary.runnerOnline).toBe(false);
		expect(relay.connected).toBe(false);

		// There should be an error issue when offline.
		const issues = body.issues as Array<Record<string, unknown>>;
		const errors = issues.filter((i) => i.severity === "error");
		expect(errors.length).toBeGreaterThan(0);
	});

	it("relay name uses the live node when connected, falls back to stale row when offline", async () => {
		// Connected: relay name must name the live node.
		const liveConn = {
			endpointUrl: `http://${NEW_NODE}`,
			token: "tok",
			instanceId: INSTANCE,
			userId: UID,
			env: {} as Env,
			runnerNode: NEW_NODE,
			relayName: `${INSTANCE}:node:${NEW_NODE}`,
		};
		getBoundRunnerConn.mockResolvedValue(liveConn);
		getLiveRuntime.mockResolvedValue({
			endpoint_url: `http://${NEW_NODE}`,
			runner_node: NEW_NODE,
			runner_version: "0.4.54",
			status: "registered",
			last_seen_at: "2026-08-16 09:03:48",
			placement: "local",
			instance_id: INSTANCE,
			capabilities: "[]",
		});

		const { app, env } = buildApp({ staleNode: OLD_NODE });
		const onlineBody = (await getDiag(app, env)).body;
		const onlineRelay = onlineBody.relay as Record<string, unknown>;
		expect(onlineRelay.relayName).toMatch(NEW_NODE);
		expect(onlineRelay.relayName).not.toMatch(OLD_NODE);

		// Offline: relay name falls back to the stale row's node.
		getBoundRunnerConn.mockResolvedValue(null);
		getLiveRuntime.mockResolvedValue(null);
		const offlineBody = (await getDiag(app, env)).body;
		const offlineRelay = offlineBody.relay as Record<string, unknown>;
		expect(offlineRelay.relayName).toMatch(OLD_NODE);
	});
});
