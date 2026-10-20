/**
 * #1114 — a pin + attach reaches `connected: true`, and when no runner would ever attach the agent the
 * cloud says so instead of answering "not yet confirmed".
 *
 * The other attach tests fake a runner that attaches whenever it is asked, which is exactly how the
 * cloud and the runner came to disagree unnoticed: the real `pags up` refuses a paused instance (and a
 * canceled one, and an agent with no local runtime) by its own rule, so the cloud's request could
 * never land. Here the fake runner decides with THAT rule — the CLI's own `reattachPlan` and
 * `diffMembership` (`packages/cli/src/commands/runner/membership.ts`), fed the real
 * `GET /v1/instances/my/instances` the runner polls — and only the relay's sockets are simulated.
 * So "attached" passes only if the CLI's rule would attach it, and every `cause` the cloud answers
 * without asking is one the CLI's rule would refuse.
 *
 * Real: the schema, the routes (pin, remote attach, placement read, resume), the attach orchestration.
 * Every instance and machine is a fixture; nothing real is attached, resumed or pinned.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DiscoverableInstance, diffMembership, reattachPlan } from "../../../../packages/cli/src/commands/runner/membership.js";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const MACHINE = "Macmini";
/** Live relay sockets, `instanceId@node`. */
const live = new Set<string>();
/** Every runner command the cloud sent, `path@node`. */
const asked: string[] = [];
let app: Hono<{ Bindings: Env }>;
let d1: RealSchemaD1;
let pending: Promise<unknown>[];

/** What `pags up` on MACHINE does with a membership sync — `relay.ts` `answerControl`, a watching runner. */
async function runnerOnMachine(body: { attach?: string; force?: boolean } | undefined) {
	const held = (id: string) => live.has(`${id}@${MACHINE}`);
	const plan = reattachPlan(body, { held: held(body?.attach ?? ""), blocked: false, watching: true, scope: [] });
	if (plan.refuse) throw new Error(`Runner /pags/membership/sync → 409: ${JSON.stringify({ error: plan.refuse })}`);
	if (plan.target && plan.detach) live.delete(`${plan.target}@${MACHINE}`);
	// syncMembership: the same poll `pags up` runs every 20s, over the instances it is actually sent.
	const { instances } = (await (await request("GET", "my/instances")).json()) as { instances: DiscoverableInstance[] };
	const attachedHere = [...live].filter((k) => k.endsWith(`@${MACHINE}`)).map((k) => k.slice(0, -MACHINE.length - 1));
	const { attach, detach } = diffMembership(attachedHere, instances, MACHINE);
	for (const inst of attach) live.add(`${inst.id}@${MACHINE}`);
	for (const id of detach) live.delete(`${id}@${MACHINE}`);
	const now = [...live].filter((k) => k.endsWith(`@${MACHINE}`)).map((k) => k.slice(0, -MACHINE.length - 1));
	return { attached: now, ...(plan.target ? { target: plan.target, holding: now.includes(plan.target) } : {}) };
}

vi.mock("../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/runner-client.js")>("../lib/runner-client.js");
	return {
		...actual,
		relayConnected: async (_env: unknown, id: string, node: string) => live.has(`${id}@${node}`),
		liveAliasForPin: async () => null,
		evictStaleRunnerSocket: async (_env: unknown, id: string, node: string) => (live.has(`${id}@${node}`) ? { sockets: 1, alive: true, evicted: 0 } : { sockets: 0, alive: false, evicted: 0 }),
		getRunnerConnIgnoringLiveness: async (_env: unknown, id: string, _uid: string, node: string) => ({ instanceId: id, runnerNode: node, relayName: `${id}:node:${node}` }),
		callRunner: async (conn: { instanceId: string; runnerNode: string }, path: string, body?: unknown) => {
			asked.push(`${path}@${conn.runnerNode}`);
			if (path === "/health") return { ok: true };
			if (conn.runnerNode !== MACHINE) throw new Error("no runner on that machine");
			return runnerOnMachine(body as { attach?: string; force?: boolean });
		},
	};
});

const { instanceRoutes } = await import("./instances.js");

const CODER = "inst-coder"; // the issue's Interns coder: a local-runtime coding agent
const CARRIER = "inst-carrier"; // another agent of the owner's, already live on the machine
const CLOUD = "inst-cloud"; // a cloud-only agent — no local runtime
const caps = (runtime: string | null) => `'${JSON.stringify({ capabilities: { surfaces: runtime ? ["coding"] : [], runtime } })}'`;

const request = (method: string, path: string, body?: unknown) =>
	app.request(
		`/v1/instances/${path}`,
		{ method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
		{ DB: d1.DB, AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) } } as unknown as Env,
		{ waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} },
	);
async function call(method: string, path: string, body?: unknown) {
	const res = await request(method, path, body);
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const placement = async (id: string) => {
	const { body } = await call("GET", `${id}/runner-node`);
	return { runnerNode: body.runnerNode, connected: (body.nodesDetail as Array<{ node: string; connected: boolean }>).find((n) => n.node === MACHINE)?.connected ?? false };
};
const setStatus = (id: string, status: string) => d1.exec(`UPDATE agent_instances SET status = '${status}' WHERE id = '${id}'`);
const syncsSent = () => asked.filter((a) => a.startsWith("/pags/membership/sync")).length;

beforeEach(() => {
	live.clear();
	asked.length = 0;
	pending = [];
	app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag-local', 'u1', 't1114-local', 'Coder', ${caps("local")}), ('ag-cloud', 'u1', 't1114-cloud', 'Cloud', ${caps(null)})`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
		('${CODER}', 'ag-local', 'u1', 'active', '{}'), ('${CARRIER}', 'ag-local', 'u1', 'active', '${JSON.stringify({ runnerNode: MACHINE })}'), ('${CLOUD}', 'ag-cloud', 'u1', 'active', '{}')`);
	// With its stable machine id (#1250): a pin names a machine, never a bare hostname.
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, last_seen_at, updated_at, machine_id) VALUES
		('${CARRIER}', 'u1', '${MACHINE}', 'relay://', '0.4.134', datetime('now'), datetime('now'), 'machine-office0001')`);
	live.add(`${CARRIER}@${MACHINE}`);
});
afterEach(async () => {
	await Promise.allSettled(pending);
	d1.close();
});

describe("pin + attach on an online machine reaches connected:true (#1114)", () => {
	it("an active coder pinned to the machine: attached by the runner's own rule, and the placement read says connected", async () => {
		expect(await placement(CODER)).toEqual({ runnerNode: null, connected: false });
		const pin = await call("PUT", `${CODER}/runner-node`, { runnerNode: MACHINE });
		expect(pin.status).toBe(200);
		expect(pin.body.attachment).toMatchObject({ node: MACHINE, attached: true });
		expect(pin.body.attachment.cause).toBeUndefined();
		expect(await placement(CODER)).toEqual({ runnerNode: MACHINE, connected: true });
	});

	it("force_runner_attach on an active, pinned coder whose socket dropped: attached, connected", async () => {
		await call("PUT", `${CODER}/runner-node`, { runnerNode: MACHINE });
		live.delete(`${CODER}@${MACHINE}`); // the socket went away
		expect((await placement(CODER)).connected).toBe(false);
		const r = await call("POST", `${CODER}/runner-attach`, {});
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ node: MACHINE, attached: true, transport: "attached" });
		expect(await placement(CODER)).toEqual({ runnerNode: MACHINE, connected: true });
	});

	it("the issue's case end to end: PAUSED → a clear `paused` and no machine asked; resumed → the same attach lands, connected", async () => {
		setStatus(CODER, "paused");
		const pin = await call("PUT", `${CODER}/runner-node`, { runnerNode: MACHINE });
		expect(pin.body.attachment).toMatchObject({ attached: false, cause: "paused" });
		expect(pin.body.attachment.unconfirmed).toBeUndefined();
		const force = await call("POST", `${CODER}/runner-attach`, {});
		expect(force.status).toBe(409);
		expect(force.body).toMatchObject({ cause: "paused" });
		expect(syncsSent()).toBe(0);
		// The runner's own rule agrees it would not have attached: run its poll directly.
		await runnerOnMachine(undefined);
		expect((await placement(CODER)).connected).toBe(false);

		expect((await call("POST", `${CODER}/resume`)).body).toMatchObject({ success: true, status: "active" });
		const after = await call("POST", `${CODER}/runner-attach`, {});
		expect(after.body).toMatchObject({ node: MACHINE, attached: true });
		expect(await placement(CODER)).toEqual({ runnerNode: MACHINE, connected: true });
	});
});

describe("an instance no runner would attach is answered at once, by the runner's own rule (#1114)", () => {
	it.each([
		["canceled", CODER, () => setStatus(CODER, "canceled"), "not_active", /canceled/],
		["a cloud-only agent (no local runtime)", CLOUD, () => {}, "no_runtime", /declares no local runtime/],
	] as const)("%s: the pin answers the cause, force-attach 409s, nothing is asked — and the CLI's rule refuses it too", async (_label, id, setup, cause, detail) => {
		setup();
		const pin = await call("PUT", `${id}/runner-node`, { runnerNode: MACHINE });
		expect(pin.status).toBe(200);
		expect(pin.body).toMatchObject({ runnerNode: MACHINE, attachment: { node: MACHINE, attached: false, cause, detail: expect.stringMatching(detail) } });
		expect(pin.body.attachment.unconfirmed).toBeUndefined();
		const force = await call("POST", `${id}/runner-attach`, {});
		expect(force.status).toBe(409);
		expect(force.body).toMatchObject({ attached: false, cause, error: expect.stringMatching(detail) });
		expect(syncsSent()).toBe(0);
		// Had it been asked, the runner would not have attached it: the cause is the runner's, not a guess.
		await runnerOnMachine({ attach: id, force: true });
		expect(live.has(`${id}@${MACHINE}`)).toBe(false);
		// And the carrier — an eligible agent on the same machine — is untouched by any of it.
		expect(live.has(`${CARRIER}@${MACHINE}`)).toBe(true);
	});
});
