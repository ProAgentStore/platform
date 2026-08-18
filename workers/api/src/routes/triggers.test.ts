/**
 * PUT /v1/triggers/:id — the anchor half (#665).
 *
 * The sweep selects `type='cron' AND enabled = 1 AND next_run_at IS NOT NULL`, and the auto-disable
 * that fires on a schedule the current grammar rejects clears all three of `enabled`, `next_run_at`
 * and `next_slot_at`. Re-enabling used to restore only `enabled`, because the recompute sat behind
 * `body.schedule !== undefined || zoneChanged` and `{enabled:true}` satisfies neither — so the row
 * read as ON everywhere and could never be selected again. Silent, permanent, and on the recovery
 * path from an AUTOMATIC disable.
 *
 * These tests are the pin: delete the `unanchored` clause and the first three red.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { triggerRoutes } from "./triggers.js";
import type { TriggerRow } from "../lib/triggers.js";
import type { Env } from "../types.js";

const TEST_SECRET = "test-secret";

function cronRow(over: Partial<TriggerRow> = {}): TriggerRow {
	return {
		id: "trg-1",
		user_id: "user-1",
		agent_id: "agent-1",
		instance_id: "inst-1",
		name: "Nightly digest",
		type: "cron",
		action: "create_task",
		enabled: 1,
		secret_token: null,
		schedule: "@daily",
		config: "{}",
		last_run_at: null,
		next_run_at: "2099-01-01T03:00:00.000Z",
		next_slot_at: "2099-01-01T03:00:00.000Z",
		failure_count: 0,
		last_error: null,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		...over,
	};
}

/** The row as the auto-disable leaves it: off, both pointers NULL, and the reason recorded. */
function autoDisabledRow(over: Partial<TriggerRow> = {}): TriggerRow {
	return cronRow({
		enabled: 0,
		next_run_at: null,
		next_slot_at: null,
		last_error: 'Disabled: schedule "* * * * *" is no longer valid — minimum cron interval is 5 minutes',
		...over,
	});
}

function testApp(row: TriggerRow) {
	const store = { row };
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/triggers", triggerRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});

	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		DB: {
			prepare(sql: string) {
				const s = sql.trim();
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								if (s.startsWith("SELECT") && s.includes("agent_triggers")) {
									return String(args[0]) === store.row.id && String(args[1]) === store.row.user_id ? store.row : null;
								}
								// capabilitiesForInstance — the route wraps it in .catch(() => null).
								return null;
							},
							async all() {
								return { results: [] };
							},
							async run() {
								if (s.startsWith("UPDATE") && s.includes("agent_triggers")) {
									// Bind order mirrors the route's UPDATE exactly.
									store.row = {
										...store.row,
										name: args[1] as string,
										action: args[2] as TriggerRow["action"],
										enabled: args[3] as number,
										secret_token: args[4] as string | null,
										schedule: args[5] as string | null,
										config: args[6] as string,
										next_run_at: args[7] as string | null,
										next_slot_at: args[9] as string | null,
										last_error: args[10] as string | null,
									};
								}
								return { success: true, meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;

	return { app, env, store };
}

async function put(app: Hono<{ Bindings: Env }>, env: Env, body: unknown, uid = "user-1") {
	const token = await signSession(uid, TEST_SECRET);
	return app.request(
		"/v1/triggers/trg-1",
		{
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		env,
	);
}

/** The sweep's own predicate, spelled out — what the row has to satisfy to ever fire again. */
function sweepWouldSelect(row: TriggerRow): boolean {
	return row.type === "cron" && row.enabled === 1 && row.next_run_at !== null;
}

describe("PUT /v1/triggers/:id — re-enabling re-anchors the schedule (#665)", () => {
	it("gives an auto-disabled cron a fresh next_run_at, so the sweep can select it again", async () => {
		const { app, env, store } = testApp(autoDisabledRow({ schedule: "@daily" }));
		expect(sweepWouldSelect(store.row)).toBe(false);

		const res = await put(app, env, { enabled: true });
		expect(res.status).toBe(200);

		expect(store.row.enabled).toBe(1);
		expect(store.row.next_run_at).not.toBeNull();
		expect(sweepWouldSelect(store.row)).toBe(true);
		expect(Date.parse(store.row.next_run_at as string)).toBeGreaterThan(Date.now());
	});

	it("restores the SLOT beside the fire time, not one without the other (#412)", async () => {
		const { app, env, store } = testApp(autoDisabledRow());
		await put(app, env, { enabled: true });
		expect(store.row.next_slot_at).not.toBeNull();
		expect(Date.parse(store.row.next_slot_at as string)).toBeGreaterThan(Date.now());
	});

	it("re-anchors an already-enabled cron that somehow holds no next_run_at", async () => {
		// Not only the enable transition: any save that leaves the row ON with no anchor has to
		// repair it, or an unrelated rename would keep re-writing the dormant state.
		const { app, env, store } = testApp(cronRow({ enabled: 1, next_run_at: null, next_slot_at: null }));
		const res = await put(app, env, { name: "Renamed" });
		expect(res.status).toBe(200);
		expect(store.row.name).toBe("Renamed");
		expect(sweepWouldSelect(store.row)).toBe(true);
	});

	it("REFUSES to re-enable a row whose stored schedule the grammar no longer accepts", async () => {
		// The loud half. Re-arming this row would only hand it back to the sweep to disable again
		// next minute; the grammar's own sentence is the useful answer.
		const { app, env, store } = testApp(autoDisabledRow({ schedule: "* * * * *" }));
		const res = await put(app, env, { enabled: true });
		expect(res.status).toBe(400);
		expect(await res.json<{ error: string }>()).toMatchObject({ error: expect.stringContaining("5 minutes") });
		expect(store.row.enabled).toBe(0);
		expect(store.row.next_run_at).toBeNull();
	});

	it("leaves a DISABLE alone — turning a trigger off must not anchor it", async () => {
		const { app, env, store } = testApp(cronRow());
		const before = store.row.next_run_at;
		await put(app, env, { enabled: false });
		expect(store.row.enabled).toBe(0);
		expect(store.row.next_run_at).toBe(before);
	});

	it("does not touch a webhook trigger's NULL pointers when it is re-enabled", async () => {
		const { app, env, store } = testApp(
			cronRow({ type: "webhook", schedule: null, enabled: 0, next_run_at: null, next_slot_at: null, secret_token: "s3cret" }),
		);
		const res = await put(app, env, { enabled: true });
		expect(res.status).toBe(200);
		expect(store.row.enabled).toBe(1);
		expect(store.row.next_run_at).toBeNull();
	});
});

describe("PUT /v1/triggers/:id — the anchor moves only on a REAL change (#665)", () => {
	it("re-sending the SAME schedule does not walk the next fire time forward", async () => {
		const { app, env, store } = testApp(cronRow({ schedule: "@daily" }));
		const before = store.row.next_run_at;
		await put(app, env, { schedule: "@daily", name: "Renamed" });
		expect(store.row.next_run_at).toBe(before);
		expect(store.row.next_slot_at).toBe("2099-01-01T03:00:00.000Z");
	});

	it("normalises before comparing, so a differently-spelled same schedule is still no change", async () => {
		const { app, env, store } = testApp(cronRow({ schedule: "every 60 minutes" }));
		const before = store.row.next_run_at;
		await put(app, env, { schedule: "  EVERY   1   hour  " });
		expect(store.row.schedule).toBe("every 60 minutes");
		expect(store.row.next_run_at).toBe(before);
	});

	it("a genuinely different schedule still re-anchors both halves", async () => {
		const { app, env, store } = testApp(cronRow({ schedule: "@daily" }));
		await put(app, env, { schedule: "every 30 minutes" });
		expect(store.row.schedule).toBe("every 30 minutes");
		expect(store.row.next_run_at).not.toBe("2099-01-01T03:00:00.000Z");
		expect(Date.parse(store.row.next_run_at as string)).toBeLessThan(Date.now() + 31 * 60_000);
	});

	it("a changed timezone still re-anchors (#18), because the same expression now means another time", async () => {
		const { app, env, store } = testApp(cronRow({ schedule: "@daily", config: "{}" }));
		await put(app, env, { config: { timezone: "Australia/Sydney" } });
		expect(store.row.next_run_at).not.toBe("2099-01-01T03:00:00.000Z");
	});
});

describe("PUT /v1/triggers/:id — a save that omits config validates the fields the row HAS (#665)", () => {
	it("does not reject a rename for vocabulary keys the trigger never set", async () => {
		// `parseConfig` emits all 21 keys with `undefined` for the unset ones and
		// `validateTriggerConfig` counts key presence, so re-validating its output rejected every
		// create_task row as fifteen wrong-action fields. Reaching the anchor logic at all depends
		// on this: `{enabled:true}` never got past the validator.
		const { app, env } = testApp(cronRow({ action: "create_task", config: '{"title":"Digest"}' }));
		const res = await put(app, env, { name: "Renamed" });
		expect(res.status).toBe(200);
	});

	it("still rejects a config the caller SENDS with a field the action ignores", async () => {
		const { app, env } = testApp(cronRow({ action: "create_task" }));
		const res = await put(app, env, { config: { pipeline: "nope" } });
		expect(res.status).toBe(400);
		expect(await res.json<{ error: string }>()).toMatchObject({ error: expect.stringContaining("not used by the create_task action") });
	});
});

describe("PUT /v1/triggers/:id — last_error on the off→on transition (#665)", () => {
	it("clears the recorded reason when the trigger is turned back on", async () => {
		const { app, env, store } = testApp(autoDisabledRow({ failure_count: 3 }));
		await put(app, env, { enabled: true });
		expect(store.row.last_error).toBeNull();
		// The history is NOT the owner's to reset by flipping a switch.
		expect(store.row.failure_count).toBe(3);
	});

	it("keeps it on every other save, including a disable", async () => {
		const { app, env, store } = testApp(cronRow({ last_error: "boom" }));
		await put(app, env, { name: "Renamed" });
		expect(store.row.last_error).toBe("boom");
		await put(app, env, { enabled: false });
		expect(store.row.last_error).toBe("boom");
	});

	it("keeps it when a disabled row is edited but left disabled", async () => {
		const { app, env, store } = testApp(autoDisabledRow({ schedule: "@daily" }));
		await put(app, env, { schedule: "every 15 minutes" });
		expect(store.row.enabled).toBe(0);
		expect(store.row.last_error).toContain("Disabled:");
	});
});
