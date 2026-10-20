/**
 * #1114 — a runner attach that does not land says WHY, measured, and leaves a record.
 *
 * Over the real schema and the real routes (`instanceRoutes`: the pin, the remote attach, and the
 * placement read). Faked: only the relay — which sockets are live, and what a machine's runner does
 * when it is asked to attach — and the instance DO, which records the activity it is sent. Every
 * instance, node and machine below is a fixture; nothing real is attached, unpaused or pruned.
 *
 * The issue's own case: the Interns coder, PAUSED, pinned to an online, heavily loaded Macmini, with
 * a months-old registration on pink-laptop (runner 0.4.62). Both tools answered "not yet confirmed".
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { CONFIRMATION_WINDOW_MS } from "../lib/confirmation-window.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { saveResourceSample } from "../lib/runner-resources.js";
import { STALE_REGISTRATION_MS, staleRegistration, windowExpiredCause } from "../lib/runner-attach-report.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

/** Live relay sockets, `instanceId@node`. */
const live = new Set<string>();
/** What a machine's runner does when asked to attach: hang (never answers) or attach. */
let runnerHangs = false;
const asked: string[] = [];
vi.mock("../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/runner-client.js")>("../lib/runner-client.js");
	return {
		...actual,
		relayConnected: async (_env: unknown, id: string, node: string) => live.has(`${id}@${node}`),
		liveAliasForPin: async () => null,
		evictStaleRunnerSocket: async (_env: unknown, id: string, node: string) => (live.has(`${id}@${node}`) ? { sockets: 1, alive: true, evicted: 0 } : { sockets: 0, alive: false, evicted: 0 }),
		getRunnerConnIgnoringLiveness: async (_env: unknown, id: string, _uid: string, node: string) => ({ instanceId: id, runnerNode: node, relayName: `${id}:node:${node}` }),
		callRunner: async (conn: { instanceId: string; runnerNode: string }, path: string) => {
			asked.push(`${path}@${conn.runnerNode}`);
			if (runnerHangs) return new Promise(() => {});
			return { attached: [] };
		},
	};
});

const { instanceRoutes } = await import("./instances.js");

const INTERNS = "f61b3232"; // the paused coder
const CARRIER = "rl-coder"; // another agent with a live socket on Macmini
let d1: RealSchemaD1;
let activity: Array<{ userId: string; data: Record<string, unknown> }>;
let pending: Promise<unknown>[];

beforeEach(() => {
	live.clear();
	asked.length = 0;
	runnerHangs = false;
	activity = [];
	pending = [];
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't1114-coder', 'Coder', '${JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "local" } })}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('${INTERNS}', 'ag', 'u1', 'active', '{}'), ('${CARRIER}', 'ag', 'u1', 'active', '{}')`);
	// Macmini: online for the carrier (heartbeat now, 0.4.134). pink-laptop: Interns' old machine, last seen 19 days ago on 0.4.61.
	// Each with its stable machine id (#1250): a pin names a machine, so a machine with no id cannot be pinned.
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, last_seen_at, updated_at, machine_id) VALUES
		('${CARRIER}', 'u1', 'Macmini', 'relay://', '0.4.134', datetime('now'), datetime('now'), 'machine-macmini01'),
		('${INTERNS}', 'u1', 'pink-laptop', 'relay://', '0.4.61', datetime('now', '-19 days'), datetime('now', '-19 days'), 'machine-pinklap01')`);
	live.add(`${CARRIER}@Macmini`);
});
afterEach(() => {
	vi.useRealTimers();
	d1.close();
});

const env = () =>
	({
		DB: d1.DB,
		AGENT: {
			idFromName: (n: string) => n,
			get: () => ({
				fetch: async (req: Request) => {
					expect(new URL(req.url).pathname).toBe("/activity/runner-attach");
					activity.push(await req.json());
					return Response.json({});
				},
			}),
		},
	}) as unknown as Env;

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(
		`/v1/instances/${path}`,
		{ method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
		env(),
		{ waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} },
	);
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const settle = () => Promise.allSettled(pending.splice(0));
const pause = () => d1.exec(`UPDATE agent_instances SET status = 'paused' WHERE id = '${INTERNS}'`);
const statusOf = () => (d1.sqlite.prepare(`SELECT status, config FROM agent_instances WHERE id = '${INTERNS}'`).get() as { status: string; config: string });
const errors = () => d1.sqlite.prepare("SELECT source, message, context FROM error_log WHERE source = 'runner.attach'").all() as Array<{ source: string; message: string; context: string }>;

describe("a PAUSED instance is answered before any machine is asked (#1114)", () => {
	it("set_instance_runner_node: the pin is saved, cause paused, nothing asked, still paused — activity only, no error row", async () => {
		pause();
		const r = await call("PUT", `${INTERNS}/runner-node`, { runnerNode: "Macmini" });
		await settle();
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ runnerNode: "Macmini", attachment: { node: "Macmini", attached: false, cause: "paused" } });
		expect(r.body.attachment.detail).toMatch(/paused — resume it \(resume_instance\)/);
		expect(asked).toEqual([]);
		expect(statusOf().status).toBe("paused");
		expect(JSON.parse(statusOf().config)).toEqual({ runnerMachineId: "machine-macmini01" }); // the machine, not its hostname (#1250)
		expect(activity).toEqual([{ userId: "u1", data: expect.objectContaining({ node: "Macmini", via: "pin", outcome: "not_attached", cause: "paused" }) }]);
		expect(errors()).toEqual([]);
	});

	it("force_runner_attach: 409 with cause paused, nothing asked, status and pin unchanged", async () => {
		pause();
		const r = await call("POST", `${INTERNS}/runner-attach`, { runnerNode: "Macmini" });
		await settle();
		expect(r.status).toBe(409);
		expect(r.body).toMatchObject({ attached: false, cause: "paused", error: expect.stringMatching(/Instance is paused/) });
		expect(asked).toEqual([]);
		expect(statusOf()).toEqual({ status: "paused", config: "{}" });
		expect(activity[0].data).toMatchObject({ via: "force_attach", forced: true, cause: "paused" });
		expect(errors()).toEqual([]);
	});
});

describe("an attach the window outran says how far it got — a timeout, measured, with load as context only (#1114)", () => {
	it("a runner that never answers: runner_timeout naming the seconds waited, the last heartbeat beside it, recorded and logged", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		runnerHangs = true;
		await saveResourceSample(env(), CARRIER, "u1", "Macmini", { loadAvg: [5.9, 25.5, 31.7], cpus: 12, memTotalBytes: 16e9, memFreeBytes: 2.3e9, platform: "darwin", sampledAt: Date.now() - 20_000 });
		const response = call("POST", `${INTERNS}/runner-attach`, { runnerNode: "Macmini" });
		await vi.advanceTimersByTimeAsync(CONFIRMATION_WINDOW_MS);
		const r = await response;
		expect(r.status).toBe(200);
		expect(asked).toEqual(["/pags/membership/sync@Macmini"]);
		expect(r.body).toMatchObject({ attached: false, unconfirmed: true, cause: "runner_timeout", phase: "sync_sent" });
		expect(r.body.detail).toMatch(/The runner on Macmini did not answer the attach request within 15s/);
		expect(r.body.detail).not.toMatch(/load|cpu/i); // the cause is the timeout, not the load
		expect(r.body.machineAtLastHeartbeat).toMatchObject({ load1: 5.9, load5: 25.5, load15: 31.7, cpus: 12, sampleAgeSec: 35, note: expect.stringMatching(/context only/) });
		expect(activity.map((a) => a.data)).toEqual([expect.objectContaining({ outcome: "unconfirmed", cause: "runner_timeout", durationMs: CONFIRMATION_WINDOW_MS })]);
		const [row] = errors();
		expect(row.message).toMatch(/Runner attach on Macmini unconfirmed \(runner_timeout\)/);
		expect(JSON.parse(row.context)).toMatchObject({ instanceId: INTERNS, cause: "runner_timeout", machineAtLastHeartbeat: { load15: 31.7 } });
	});

	it("the same expiry on a pin keeps the pin and says so", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		runnerHangs = true;
		const response = call("PUT", `${INTERNS}/runner-node`, { runnerNode: "Macmini" });
		await vi.advanceTimersByTimeAsync(CONFIRMATION_WINDOW_MS);
		const r = await response;
		expect(r.body).toMatchObject({ runnerNode: "Macmini", attachment: { cause: "runner_timeout", unconfirmed: true } });
		expect(r.body.attachment.detail).toMatch(/^The pin to Macmini is saved\. The runner on Macmini did not answer/);
	});
});

describe("a machine with nothing to ask, and a stale registration (#1114)", () => {
	it("no socket on the machine: cause no_socket, recorded, and logged as a failure", async () => {
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, last_seen_at) VALUES ('${INTERNS}', 'u1', 'office-mini', 'relay://', '0.4.134', datetime('now', '-1 hour'))`);
		const r = await call("POST", `${INTERNS}/runner-attach`, { runnerNode: "office-mini" });
		await settle();
		expect(r.body).toMatchObject({ attached: false, cause: "no_socket" });
		expect(r.body).not.toHaveProperty("stale");
		expect(asked).toEqual([]);
		expect(activity.map((a) => a.data)).toEqual([expect.objectContaining({ outcome: "not_attached", cause: "no_socket" })]);
		expect(errors()).toHaveLength(1);
	});

	it("an old registration is the cause, flagged with why — and nothing is deleted or repinned", async () => {
		const rowsBefore = d1.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_runtime_nodes").get();
		const r = await call("POST", `${INTERNS}/runner-attach`, { runnerNode: "pink-laptop" });
		await settle();
		expect(r.body).toMatchObject({ attached: false, cause: "stale_registration", stale: { version: "0.4.61", reason: expect.stringMatching(/not seen for 19 days.*predates 0\.4\.62/) } });
		expect(r.body.detail).toMatch(/^Stale registration on pink-laptop/);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_runtime_nodes").get()).toEqual(rowsBefore);
		expect(statusOf().config).toBe("{}");
		expect(JSON.parse(errors()[0].context)).toMatchObject({ cause: "stale_registration", stale: { version: "0.4.61" } });
	});

	it("instance_runner_node flags the stale machine and not the live one", async () => {
		const r = await call("GET", `${INTERNS}/runner-node`);
		const byNode = Object.fromEntries((r.body.nodesDetail as Array<{ node: string; stale?: unknown }>).map((n) => [n.node, n.stale ?? null]));
		expect(byNode["pink-laptop"]).toMatchObject({ version: "0.4.61", reason: expect.stringMatching(/19 days/) });
		expect(byNode.Macmini).toBeNull();
	});
});

describe("the measured-cause rules, pure (#1114)", () => {
	it("staleRegistration: the freshest row decides; a week, or a CLI that cannot be asked", () => {
		const now = Date.parse("2026-10-16T06:00:00Z");
		const at = (ms: number) => new Date(now - ms).toISOString().replace("T", " ").slice(0, 19);
		expect(staleRegistration([{ node: "a", lastSeenAt: at(STALE_REGISTRATION_MS + 60_000), version: "0.4.134" }], ["a"], now)?.reason).toMatch(/not seen for 7 days/);
		expect(staleRegistration([{ node: "a", lastSeenAt: at(STALE_REGISTRATION_MS + 60_000), version: "0.4.134" }, { node: "a2", lastSeenAt: at(60_000), version: "0.4.134" }], ["a", "a2"], now)).toBeNull();
		expect(staleRegistration([{ node: "a", lastSeenAt: at(60_000), version: "0.4.50" }], ["a"], now)?.reason).toMatch(/predates 0\.4\.62/);
		expect(staleRegistration([], ["a"], now)).toBeNull();
	});

	it("windowExpiredCause names the phase it measured, never a load guess", () => {
		expect(windowExpiredCause({ phase: "evicting", startedAt: 0 }, "m", 15_000)).toMatchObject({ cause: "runner_timeout", detail: expect.stringMatching(/no runner had been asked yet/) });
		expect(windowExpiredCause({ phase: "waiting_open", startedAt: 0, answeredAt: 5_000 }, "m", 15_000)).toMatchObject({ cause: "no_socket", detail: expect.stringMatching(/answered the attach request 10s ago/) });
		expect(windowExpiredCause({ phase: "no_carrier", startedAt: 0 }, "m", 15_000).cause).toBe("no_socket");
	});
});
