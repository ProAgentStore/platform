/**
 * #1432 — a runner_update operation that ended `unreachable` (every relay socket on the machine
 * connected but not answering during install) is an acknowledgement GAP, not a confirmed failure.
 * The machine's own next registration — `POST /:instanceId/runtime`, exactly what `pags up`
 * sends on every startup and reconnect — is the passive signal that it came back on a newer
 * version; this reconciles the durable operation without sending the machine anything.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { type RealSchemaD1, realSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

const NODE = "Macmini.modem";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }), requirePro: async () => undefined };
});
const { instanceRoutes } = await import("./instances.js");
const { claimUpdateOp, advanceUpdateOp, latestUpdateOp, RUNNER_UPDATE_RECONCILE_GRACE_MS } = await import("../lib/runner-update-ops.js");

let d1: RealSchemaD1;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't1432-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('inst-1', 'ag', 'u1', 'active', '{}')");
});
afterEach(() => d1.close());

async function register(runnerVersion: string) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(
		"/v1/instances/inst-1/runtime",
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpointUrl: "http://127.0.0.1:1111", runnerNode: NODE, runnerVersion }) },
		{ DB: d1.DB } as unknown as Env,
	);
	expect(res.status).toBe(201);
}

describe("the registration route passively reconciles an `unreachable` update (#1432)", () => {
	it("flips the durable operation to `restarted` when the machine re-registers on a newer version", async () => {
		// The route reconciles against the REAL clock (no injected `now`), so the op's `ended_at`
		// has to sit inside the grace window as of the moment `register()` actually runs below.
		const NOW = Date.now() - 71_000; // the ~71s a real restart took in #1432's own evidence
		const { op } = await claimUpdateOp({ DB: d1.DB }, "u1", NODE, { now: NOW });
		await advanceUpdateOp({ DB: d1.DB }, "u1", op.id, { state: "unreachable", currentVersion: "0.4.197", detail: "Every relay socket on Macmini.modem is connected but not answering." }, NOW + 1_000);

		// The same machine, moments later, with a new runner process (`pags up` respawned it).
		await register("0.4.198");

		const after = await latestUpdateOp({ DB: d1.DB }, "u1", NODE);
		expect(after).toMatchObject({ id: op.id, state: "restarted", finalVersion: "0.4.198" });
		expect(after?.reconciliation).toMatch(/re-registered on 0\.4\.198/);
	});

	it("leaves an unrelated `running` operation alone — a registration must not close a live one", async () => {
		const NOW = Date.now();
		const { op } = await claimUpdateOp({ DB: d1.DB }, "u1", NODE, { now: NOW });
		await advanceUpdateOp({ DB: d1.DB }, "u1", op.id, { state: "running", phase: "installing", currentVersion: "0.4.197" }, NOW + 1_000);
		await register("0.4.198");
		expect(await latestUpdateOp({ DB: d1.DB }, "u1", NODE)).toMatchObject({ id: op.id, state: "running" });
	});

	it("does not reconcile once the registration arrives after the restart grace window", async () => {
		// The route reconciles against the REAL clock, so push `ended_at` just past the grace
		// window relative to the moment `register()` actually runs below.
		const endedAtMs = Date.now() - RUNNER_UPDATE_RECONCILE_GRACE_MS - 1_000;
		const { op } = await claimUpdateOp({ DB: d1.DB }, "u1", NODE, { now: endedAtMs - 1_000 });
		await advanceUpdateOp({ DB: d1.DB }, "u1", op.id, { state: "unreachable", currentVersion: "0.4.197" }, endedAtMs);
		await register("0.4.198");
		expect(await latestUpdateOp({ DB: d1.DB }, "u1", NODE)).toMatchObject({ id: op.id, state: "unreachable", finalVersion: null });
	});
});
