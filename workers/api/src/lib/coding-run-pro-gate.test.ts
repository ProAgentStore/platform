/**
 * The Pro gate on every coding-run start (#870), on the REAL migrated schema with the real
 * `local-coder` row from 0164.
 *
 * `POST /:id/loop` refused a coding run without Pro (#868), but the ticket queue and supervisor
 * delegation start runs with no session and never passed that route. The gate now sits on
 * `loopDriverFor` (every entry point), and the two background paths ask before they claim a ticket
 * or open a budget pool — so a refused run leaves nothing behind.
 */
import { afterEach, describe, expect, it } from "vitest";
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import { delegateToInstance } from "./delegate-instance.js";
import { type LoopStartInput, type LoopStartResult, loopDriverFor } from "./loop-drivers.js";
import { pickupNextTicket, setTicketAuthority, setTicketQueueEnabled } from "./ticket-queue.js";
import { createTicketCard } from "./tickets.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
afterEach(() => {
	d1?.close();
	d1 = undefined as unknown as RealSchemaD1;
});

/** u1 owns a `local-coder` instance (coder) and a plain chat instance (chat); u2 is a second tenant. */
function setup(paywall = true) {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["chat"] });
	seedTenant(d1, { userId: "u2", instanceIds: [] });
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('coder', 'agent_local_coder', 'u1')");
	const env = {
		DB: d1.DB,
		PAYWALL_ENFORCE: paywall ? "true" : undefined,
		AGENT_LOOP: { create: async () => ({ id: "wf" }) },
	} as unknown as Env;
	return env;
}
const pro = (user: string) => d1.exec(`UPDATE users SET subscription_status = 'active' WHERE id = '${user}'`);
const admin = (user: string) => d1.exec(`UPDATE users SET roles = '["admin"]' WHERE id = '${user}'`);
const count = (sql: string) => (d1.sqlite.prepare(sql).get() as { n: number }).n;
const input = (env: Env, instanceId: string): LoopStartInput => ({ env, instanceId, userId: "u1", objective: "fix it", maxIterations: 3, budgetId: "b1", depth: 0 });

describe("the driver gate — every coding start (#870)", () => {
	it("refuses a non-Pro account's coding run with 402 before the driver creates a run", async () => {
		const env = setup();
		const driver = loopDriverFor(await capabilitiesForInstance(env, "coder", "u1"));
		expect(driver.id).toBe("coding");
		const out = await driver.start(input(env, "coder"));
		expect(out).toMatchObject({ ok: false, status: 402 });
		expect((out as { error: string }).error).toMatch(/requires Pro/);
		expect(count("SELECT COUNT(*) AS n FROM agent_loop_runs")).toBe(0);
	});

	it("lets a Pro account and an admin through the gate (the driver's own checks answer next)", async () => {
		const env = setup();
		const driver = loopDriverFor(await capabilitiesForInstance(env, "coder", "u1"));
		pro("u1");
		expect(await driver.start(input(env, "coder"))).not.toMatchObject({ status: 402 });
		d1.exec("UPDATE users SET subscription_status = NULL WHERE id = 'u1'");
		admin("u1");
		expect(await driver.start(input(env, "coder"))).not.toMatchObject({ status: 402 });
	});

	it("does not gate with the paywall off, and never gates a chat run", async () => {
		const off = setup(false);
		expect(await loopDriverFor(await capabilitiesForInstance(off, "coder", "u1")).start(input(off, "coder"))).not.toMatchObject({ status: 402 });
		d1.close();
		const on = setup();
		const chat = loopDriverFor(await capabilitiesForInstance(on, "chat", "u1"));
		expect(chat.id).toBe("chat");
		expect(await chat.start(input(on, "chat"))).not.toMatchObject({ status: 402 });
	});

	it("reads the RUN OWNER's entitlement — another account's Pro does not carry over", async () => {
		const env = setup();
		pro("u2");
		admin("u2");
		const out = await loopDriverFor(await capabilitiesForInstance(env, "coder", "u1")).start(input(env, "coder"));
		expect(out).toMatchObject({ ok: false, status: 402 });
	});
});

describe("ticket-queue pickup of a coding ticket (#870)", () => {
	async function released(env: Env) {
		await setTicketQueueEnabled(env, "coder", "u1", true);
		const t = await createTicketCard(env, "coder", "u1", { id: "card-1", type: "ticket", title: "Fix it", description: "", status: "needs_approval", updatedAt: "2026-09-27T00:00:00Z" }, "human");
		await setTicketAuthority(env, "coder", "u1", t.id, "agent");
		return t;
	}
	function fakeStart() {
		const calls: LoopStartInput[] = [];
		return { calls, start: async (i: LoopStartInput): Promise<LoopStartResult> => { calls.push(i); return { ok: true, runId: `run-${calls.length}`, driver: "coding" }; } };
	}
	const green = { redDeploy: async () => null };

	it("a non-Pro owner's ticket is parked unclaimed — no start, no budget pool, the reason on the ticket", async () => {
		const env = setup();
		const t = await released(env);
		const d = fakeStart();
		const out = await pickupNextTicket(env, "coder", "u1", { ...green, start: d.start });
		expect(out).toMatchObject({ started: false, reason: "not_entitled", ticketId: t.id });
		expect(d.calls).toEqual([]);
		const row = d1.sqlite.prepare("SELECT queue_picked_at, budget_id, queue_note FROM tickets WHERE id = ?").get(t.id) as Record<string, unknown>;
		expect(row.queue_picked_at).toBeNull();
		expect(row.budget_id).toBeNull();
		expect(String(row.queue_note)).toMatch(/requires Pro/);
		expect(count("SELECT COUNT(*) AS n FROM delegation_budgets")).toBe(0);
		expect(count("SELECT COUNT(*) AS n FROM instance_runtime_tasks WHERE type = 'ticket.run'")).toBe(0);
	});

	it("a Pro owner's ticket starts; and a parked ticket starts on the first sweep after the upgrade", async () => {
		const env = setup();
		const t = await released(env);
		const d = fakeStart();
		expect(await pickupNextTicket(env, "coder", "u1", { ...green, start: d.start })).toMatchObject({ reason: "not_entitled" });
		pro("u1");
		expect(await pickupNextTicket(env, "coder", "u1", { ...green, start: d.start })).toEqual({ started: true, ticketId: t.id, runId: "run-1", driver: "coding" });
		expect(d.calls).toHaveLength(1);
	});

	it("without the injected start, the real driver path is gated too — nothing claimed, nothing opened", async () => {
		const env = setup();
		await released(env);
		expect(await pickupNextTicket(env, "coder", "u1", green)).toMatchObject({ started: false, reason: "not_entitled" });
		expect(count("SELECT COUNT(*) AS n FROM delegation_budgets")).toBe(0);
		expect(count("SELECT COUNT(*) AS n FROM agent_loop_runs")).toBe(0);
	});
});

describe("supervisor delegation into a coding instance (#870)", () => {
	const edge = () => d1.exec("INSERT INTO agent_supervision (id, user_id, supervisor_instance_id, subordinate_instance_id) VALUES ('e1', 'u1', 'chat', 'coder')");
	const delegate = (env: Env) => delegateToInstance(env, { userId: "u1", supervisorInstanceId: "chat", subordinateInstanceId: "coder", objective: "fix it" });

	it("a non-Pro owner's delegation is refused with 402 and opens no budget pool", async () => {
		const env = setup();
		edge();
		const out = await delegate(env);
		expect(out).toMatchObject({ ok: false, status: 402 });
		expect((out as { error: string }).error).toMatch(/requires Pro/);
		expect(count("SELECT COUNT(*) AS n FROM delegation_budgets")).toBe(0);
		expect(count("SELECT COUNT(*) AS n FROM agent_loop_runs")).toBe(0);
	});

	it("a Pro owner's delegation passes the gate (the coding driver's own checks answer next)", async () => {
		const env = setup();
		edge();
		pro("u1");
		expect(await delegate(env)).not.toMatchObject({ status: 402 });
	});

	it("the supervision check still comes first: no edge is a 403, whatever the plan", async () => {
		const env = setup();
		expect(await delegate(env)).toMatchObject({ ok: false, status: 403 });
	});
});
