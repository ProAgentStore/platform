/**
 * `endCodingSession` resolving a renamed machine's STAMP (#1541).
 *
 * The live incident: a session stamped to `Sergeys-Mac-mini.local` outlived that hostname — the
 * same physical machine now answers as `Macmini.modem` — so the exact-name lookup `getRunnerConn`
 * always used found nothing live, `/coding/end` was never dispatched, and the direct-turn claim it
 * held stayed `stop_not_confirmed` forever, blocking the repo's queue even with the real machine
 * online. `getRunnerConnForStampedNode` (runner-client.ts) resolves a PROVEN alias of the same
 * machine before giving up, and `sameMachine` re-verifies that identity independently before the
 * claim is ever released — both built on the owner's `instance_runtime_nodes.machine_id` (#379),
 * and both fail closed the moment that record is unrecorded or ambiguous.
 *
 * Driven against the real D1 schema (`d1-sqlite.ts`) rather than a hand-rolled SQL-string stub —
 * `coding-session-restart-races.test.ts`'s own rationale: this exercises `getSession`,
 * `releaseReservation`, `repoOwners` and `tryDequeueAndStart` together, which a stub would have to
 * reimplement to even approximate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endCodingSession } from "./coding-session-end.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { relayNameForInstance } from "./runtime-nodes.js";
import type { Env } from "../types.js";

const INST = "i1";
const UID = "u1";
let d1: RealSchemaD1;

/** The relay's answer to one dispatched `/coding/end` — keyed by relay NAME, so a test can place a
 *  different answer (or none) under the old stamp's name vs. the renamed machine's live name. */
function buildRelay(answers: Record<string, { status: number; body: unknown }>) {
	const dispatched: Array<{ name: string; path: string; sessionId: unknown }> = [];
	return {
		relay: {
			idFromName: (name: string) => ({ name }),
			get: (id: { name: string }) => ({
				fetch: async (req: Request) => {
					const url = new URL(req.url);
					if (url.pathname === "/status") return Response.json({ connected: id.name in answers });
					if (url.pathname === "/command") {
						const body = (await req.json()) as { path: string; body?: { sessionId?: unknown } };
						dispatched.push({ name: id.name, path: body.path, sessionId: body.body?.sessionId });
						const answer = answers[id.name];
						if (!answer) return Response.json({ error: "No runner connected" }, { status: 503 });
						return new Response(JSON.stringify(answer.body), { status: answer.status });
					}
					return new Response("not found", { status: 404 });
				},
			}),
		},
		dispatched,
	};
}

function node(runnerNode: string, opts: { machineId?: string | null; instanceId?: string } = {}) {
	d1.exec(
		`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, placement, endpoint_url, token_plaintext, capabilities, runner_version, status, machine_id, last_seen_at)
		 VALUES ('${opts.instanceId ?? INST}', '${UID}', '${runnerNode}', 'local', 'http://${runnerNode}', 'tok', '[]', '0.4.90', 'registered', ${opts.machineId ? `'${opts.machineId}'` : "NULL"}, datetime('now'))`,
	);
}

function session(id: string, opts: { runnerNode?: string | null; turnId?: string | null; repo?: string } = {}) {
	d1.exec(
		`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, runner_node, direct_turn_id, direct_turn_at, updated_at)
		 VALUES ('${id}', '${INST}', '${opts.repo ?? "r1"}', '${UID}', 'active', 'claude', ${opts.runnerNode === null ? "NULL" : `'${opts.runnerNode ?? "Sergeys-Mac-mini.local"}'`}, ${opts.turnId === null ? "NULL" : `'${opts.turnId ?? "dt-1"}'`}, ${opts.turnId === null ? "NULL" : Date.now()}, datetime('now'))`,
	);
}

const row = (id: string) =>
	d1.sqlite.prepare("SELECT status, direct_turn_id, ended_at FROM coding_sessions WHERE id = ?").get(id) as { status: string; direct_turn_id: string | null; ended_at: string | null };

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: UID, instanceIds: [INST] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', '${INST}', '${UID}', 'owner/repo')`);
});
afterEach(() => d1.close());

describe("renamed original machine (#1541)", () => {
	it("resolves the live alias, stops the engine, and releases the queue-blocking claim", async () => {
		node("Sergeys-Mac-mini.local", { machineId: "mac-mini-id" });
		node("Macmini.modem", { machineId: "mac-mini-id" });
		session("s1");
		const { relay, dispatched } = buildRelay({ [relayNameForInstance(INST, "Macmini.modem")]: { status: 200, body: { ok: true } } });
		const env = { DB: d1.DB, RELAY: relay } as unknown as Env;

		const result = await endCodingSession(env, { instanceId: INST, userId: UID, sessionId: "s1" });
		expect(result.engineStopped).toBe(true);
		expect(result.directTurn).toMatchObject({ turnId: "dt-1", released: true });
		expect(row("s1")).toMatchObject({ status: "ended", direct_turn_id: null });
		// The /coding/end that actually reached a machine named the exact session — dispatched to
		// the RENAMED name, never the dead stamp.
		expect(dispatched).toEqual([{ name: relayNameForInstance(INST, "Macmini.modem"), path: "/coding/end", sessionId: "s1" }]);
	});
});

describe("a different machine being live is never mistaken for the stamped one (#1541)", () => {
	it("an unrelated live machine (no shared machine_id) leaves the claim unconfirmed, and is never asked to stop anything", async () => {
		node("Sergeys-Mac-mini.local", { machineId: "mac-mini-id" });
		node("dell-laptop", { machineId: "dell-id" });
		session("s1");
		const { relay, dispatched } = buildRelay({ [relayNameForInstance(INST, "dell-laptop")]: { status: 200, body: { ok: true } } });
		const env = { DB: d1.DB, RELAY: relay } as unknown as Env;

		const result = await endCodingSession(env, { instanceId: INST, userId: UID, sessionId: "s1" });
		expect(result.engineStopped).toBeNull();
		expect(result.directTurn).toEqual({ turnId: "dt-1", released: false, reason: "stop_not_confirmed" });
		expect(row("s1")).toMatchObject({ status: "ended", direct_turn_id: "dt-1" }); // the row still closes; the claim does not release
		expect(dispatched).toEqual([]);
	});
});

describe("ambiguous or unknown alias (#1541)", () => {
	it("ambiguous: the stamped name is itself shared by two machines — refuses outright, asks nobody", async () => {
		// `instance_runtime_nodes`'s PRIMARY KEY is (instance_id, runner_node), so two machines
		// sharing one hostname can only show up as rows under DIFFERENT instances — exactly how a
		// second, unrelated agent registering the same hostname would actually land. The identity
		// read is owner-wide (`ownerNodeRegistrations`), so it sees both regardless of which
		// instance this session itself belongs to.
		d1.exec(`INSERT OR IGNORE INTO agent_instances (id, agent_id, user_id) VALUES ('i2', 'agent-1', '${UID}')`);
		node("Sergeys-Mac-mini.local", { machineId: "machine-a" });
		node("Sergeys-Mac-mini.local", { machineId: "machine-b", instanceId: "i2" });
		session("s1");
		const { relay, dispatched } = buildRelay({ [relayNameForInstance(INST, "Sergeys-Mac-mini.local")]: { status: 200, body: { ok: true } } });
		const env = { DB: d1.DB, RELAY: relay } as unknown as Env;

		const result = await endCodingSession(env, { instanceId: INST, userId: UID, sessionId: "s1" });
		expect(result.engineStopped).toBeNull(); // never even dispatched — identity was ambiguous before any connection attempt
		expect(result.directTurn).toEqual({ turnId: "dt-1", released: false, reason: "stop_not_confirmed" });
		expect(dispatched).toEqual([]);
	});

	it("unknown: the stamped name carries no recorded machine_id — no alias candidate even with another live machine", async () => {
		node("Sergeys-Mac-mini.local", { machineId: null });
		node("Macmini.modem", { machineId: "some-other-id" });
		session("s1");
		const { relay, dispatched } = buildRelay({ [relayNameForInstance(INST, "Macmini.modem")]: { status: 200, body: { ok: true } } });
		const env = { DB: d1.DB, RELAY: relay } as unknown as Env;

		const result = await endCodingSession(env, { instanceId: INST, userId: UID, sessionId: "s1" });
		expect(result.engineStopped).toBeNull();
		expect(result.directTurn).toEqual({ turnId: "dt-1", released: false, reason: "stop_not_confirmed" });
		expect(dispatched).toEqual([]);
	});
});

describe("unreachable runner (#1541)", () => {
	it("a proven alias exists but nothing answers it — the row still closes, the claim does not release", async () => {
		node("Sergeys-Mac-mini.local", { machineId: "mac-mini-id" });
		node("Macmini.modem", { machineId: "mac-mini-id" });
		session("s1");
		const { relay, dispatched } = buildRelay({}); // nothing live at all
		const env = { DB: d1.DB, RELAY: relay } as unknown as Env;

		const result = await endCodingSession(env, { instanceId: INST, userId: UID, sessionId: "s1" });
		expect(result.ok).toBe(true); // the D1 row still moves to ended
		// No connection at all (not "connected but didn't confirm") is the three-valued `null`, not
		// a `warning` — that field is reserved for a machine that answered but didn't say `ok:true`.
		expect(result.engineStopped).toBeNull();
		expect(result.warning).toBeUndefined();
		expect(result.directTurn).toEqual({ turnId: "dt-1", released: false, reason: "stop_not_confirmed" });
		expect(row("s1")).toMatchObject({ status: "ended", direct_turn_id: "dt-1" });
		expect(dispatched).toEqual([]);
	});
});

describe("a superseded claim is preserved, never released by a stale read (#1541, #1015)", () => {
	it("a newer direct turn taken after the read is left alone", async () => {
		node("Sergeys-Mac-mini.local", { machineId: "mac-mini-id" });
		session("s1");
		// Something claimed a NEWER direct turn on this session between the read and the stop
		// confirming — simulated directly, since admitting one is a different module's job.
		d1.exec(`UPDATE coding_sessions SET direct_turn_id = 'dt-2', direct_turn_at = ${Date.now()} WHERE id = 's1'`);
		const { relay, dispatched } = buildRelay({ [relayNameForInstance(INST, "Sergeys-Mac-mini.local")]: { status: 200, body: { ok: true } } });
		const env = { DB: d1.DB, RELAY: relay } as unknown as Env;

		// endCodingSession reads the claim ('dt-2') fresh itself, so this exercises the release's
		// OWN guard: it only ever releases the turn id IT read, via the conditional UPDATE in
		// releaseReservation — proven already by coding-session-restart-races.test.ts for the
		// general case; here the superseded-claim id simply flows straight through as `turnId`.
		const result = await endCodingSession(env, { instanceId: INST, userId: UID, sessionId: "s1" });
		expect(result.directTurn).toMatchObject({ turnId: "dt-2", released: true });
		expect(dispatched).toEqual([{ name: relayNameForInstance(INST, "Sergeys-Mac-mini.local"), path: "/coding/end", sessionId: "s1" }]);
	});
});

describe("a repeated end changes nothing the second time (#1541, #1015)", () => {
	it("the first call releases and drains once; the second finds no claim left to act on", async () => {
		node("Sergeys-Mac-mini.local", { machineId: "mac-mini-id" });
		node("Macmini.modem", { machineId: "mac-mini-id" });
		session("s1");
		const { relay, dispatched } = buildRelay({ [relayNameForInstance(INST, "Macmini.modem")]: { status: 200, body: { ok: true } } });
		const env = { DB: d1.DB, RELAY: relay } as unknown as Env;

		const first = await endCodingSession(env, { instanceId: INST, userId: UID, sessionId: "s1" });
		expect(first.directTurn).toMatchObject({ released: true });
		expect(dispatched).toHaveLength(1);

		// Ending it AGAIN still asks the machine to stop (the row header's own stated case: an
		// orphaned CLI that is still editing must not be reported as a clean stop just because the
		// row already closed) — but the RELEASE is a no-op: the claim column is already NULL, so
		// there is nothing left to release or drain a second time.
		const second = await endCodingSession(env, { instanceId: INST, userId: UID, sessionId: "s1" });
		expect(second.alreadyEnded).toBe(true);
		expect(second.directTurn).toBeNull();
		expect(dispatched).toHaveLength(2);
	});
});

describe("a single queue drain per release (#1541, #1015)", () => {
	it("an empty queue drains to nothing, reported as attempted, and a repeat end never attempts it again", async () => {
		node("Sergeys-Mac-mini.local", { machineId: "mac-mini-id" });
		session("s1");
		const { relay } = buildRelay({ [relayNameForInstance(INST, "Sergeys-Mac-mini.local")]: { status: 200, body: { ok: true } } });
		const env = { DB: d1.DB, RELAY: relay } as unknown as Env;

		const first = await endCodingSession(env, { instanceId: INST, userId: UID, sessionId: "s1" });
		expect(first.directTurn).toMatchObject({ released: true, queue: { attempted: true, drained: false } });

		const second = await endCodingSession(env, { instanceId: INST, userId: UID, sessionId: "s1" });
		expect(second.directTurn).toBeNull(); // no second drain attempt — nothing was left to release
	});
});
