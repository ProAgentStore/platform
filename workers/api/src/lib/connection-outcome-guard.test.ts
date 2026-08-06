import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimDelivery, markAttemptFailed, markDelivered, MAX_ATTEMPTS, type DeliveryRow } from "./connection-deliveries.js";
import type { Env } from "../types.js";

/**
 * The guarded terminal writes (#239), EXECUTED against real SQLite rather than text-matched.
 *
 * `claimDelivery` stopped two sweeps STARTING the same delivery, but the writes that END an
 * attempt keyed on `id` alone. A slow attempt that outlived its 5-minute hold could still
 * corrupt the row after another attempt had finished with it:
 *
 *   1. a `delivered` row pushed back to `pending` and delivered a THIRD time — site-builder
 *      building and billing twice, exactly what the outbox promises it prevents;
 *   2. a `dead` row overwritten as `delivered`, so a real failure vanished from `?status=dead`
 *      and from replay;
 *   3. two overlapping attempts both writing a stale ABSOLUTE `attempts`, so the counter never
 *      advanced past N+1 and MAX_ATTEMPTS was never reached — retrying forever, the opposite
 *      of the bounded at-least-once contract.
 *
 * A SQL-string assertion cannot show any of that; only running the statements can. Restore the
 * unguarded `WHERE id = ?1` (or the absolute `attempts = ?`) and every test here goes red.
 *
 * Note the 5-minute re-execution window itself is INTENTIONAL — a died-mid-flight attempt
 * "simply becomes due again", trading possible re-execution for recoverability. That trade is
 * not what these tests change; the corruption caused by the late writer is.
 */
const MIGRATION = join(__dirname, "../../migrations/0058_connection_deliveries.sql");

/** A D1-shaped facade over node:sqlite. `?N` placeholders bind positionally, as SQLite does. */
function d1(db: DatabaseSync): Env {
	return {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						const stmt = db.prepare(sql);
						return {
							async run() {
								const r = stmt.run(...(args as never[]));
								return { meta: { changes: Number(r.changes) } };
							},
							async first() {
								return (stmt.get(...(args as never[])) ?? null) as unknown;
							},
							async all() {
								return { results: stmt.all(...(args as never[])) as unknown[] };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
}

const NOW = new Date("2026-08-04T00:00:00.000Z");
const DUE = "2026-08-04T00:00:00.000Z";

function seed(over: Partial<Record<string, string | number | null>> = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(MIGRATION, "utf8"));
	const row: Record<string, string | number | null> = {
		id: "d1",
		connection_id: "c1",
		user_id: "u1",
		source_instance_id: "i-src",
		target_instance_id: "i-dst",
		event_type: "site.live",
		action: "run_pipeline",
		payload: "{}",
		config: "{}",
		idempotency_key: "k1",
		trace_id: "run-1",
		status: "pending",
		attempts: 0,
		next_attempt_at: DUE,
		last_error: null,
		created_at: DUE,
		updated_at: DUE,
		...over,
	};
	db.prepare(
		`INSERT INTO agent_connection_deliveries
      (id, connection_id, user_id, source_instance_id, target_instance_id, event_type, action, payload,
       config, idempotency_key, trace_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(...(Object.values(row) as never[]));
	return { db, env: d1(db) };
}

const read = (db: DatabaseSync) => db.prepare("SELECT * FROM agent_connection_deliveries WHERE id = 'd1'").get() as { status: string; attempts: number; next_attempt_at: string | null; last_error: string | null };

const rowFor = (next_attempt_at: string | null = DUE): DeliveryRow => ({ id: "d1", status: "pending", next_attempt_at }) as DeliveryRow;

describe("delivery outcome writes are guarded by the claim", () => {
	it("a late markAttemptFailed does NOT resurrect a delivered event", async () => {
		// t=0 sweep A claims and stalls. t=5m the hold lapses; sweep B claims and succeeds.
		// t=6m attempt A finally throws. Before the guard this flipped the row back to 'pending',
		// due in ~1m, and a third sweep delivered the same event AGAIN.
		const { db, env } = seed();
		const claimA = (await claimDelivery(env, rowFor(), NOW))!;
		expect(claimA).not.toBeNull();

		const later = new Date(NOW.getTime() + 5 * 60_000);
		const claimB = (await claimDelivery(env, rowFor(claimA.hold), later))!;
		expect(claimB).not.toBeNull();
		expect(await markDelivered(env, claimB)).toBe(true);

		expect(await markAttemptFailed(env, claimA, 0, "timeout", new Date(NOW.getTime() + 6 * 60_000))).toBe("stale");
		const after = read(db);
		expect(after.status).toBe("delivered");
		expect(after.next_attempt_at).toBeNull(); // nothing to sweep — no third delivery
		expect(after.last_error).toBeNull();
	});

	it("a late markDelivered does NOT bury a dead-lettered delivery", async () => {
		// The reverse order: the failing attempt dead-letters D, then the slow successful one
		// marked it delivered — so the row left status='dead' and vanished from ?status=dead and
		// from replay. A real failure disappeared.
		const { db, env } = seed({ attempts: MAX_ATTEMPTS - 1 });
		const claimA = (await claimDelivery(env, rowFor(), NOW))!;
		const later = new Date(NOW.getTime() + 5 * 60_000);
		const claimB = (await claimDelivery(env, rowFor(claimA.hold), later))!;

		expect(await markAttemptFailed(env, claimB, MAX_ATTEMPTS - 1, "still down", later)).toBe("dead");
		expect(await markDelivered(env, claimA)).toBe(false);
		expect(read(db).status).toBe("dead");
	});

	it("overlapping attempts each increment attempts, so the dead-letter bound still holds", async () => {
		// `attempts` came from the row the sweep SELECTed and was written as a stale ABSOLUTE, so
		// two overlapping attempts both wrote the same value and the counter never advanced —
		// a delivery that kept overlapping retried forever instead of dead-lettering.
		const { db, env } = seed();
		let hold: string | null = DUE;
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			const at = new Date(NOW.getTime() + i * 6 * 60_000);
			const claim = (await claimDelivery(env, rowFor(hold), at))!;
			expect(claim, `attempt ${i} should be claimable`).not.toBeNull();
			await markAttemptFailed(env, claim, read(db).attempts, "boom", at);
			hold = read(db).next_attempt_at;
		}
		const final = read(db);
		expect(final.attempts).toBe(MAX_ATTEMPTS);
		expect(final.status).toBe("dead"); // bounded, exactly as at-least-once promises
	});

	it("the normal single-attempt path is unaffected", async () => {
		const { db, env } = seed();
		const claim = (await claimDelivery(env, rowFor(), NOW))!;
		expect(await markDelivered(env, claim)).toBe(true);
		const after = read(db);
		expect(after).toMatchObject({ status: "delivered", attempts: 1, next_attempt_at: null });
	});

	it("a retry schedules the next attempt and stays claimable by the next sweep", async () => {
		const { db, env } = seed();
		const claim = (await claimDelivery(env, rowFor(), NOW))!;
		expect(await markAttemptFailed(env, claim, 0, "consumer down", NOW)).toBe("retrying");
		const after = read(db);
		expect(after.status).toBe("pending");
		expect(after.attempts).toBe(1);
		expect(after.next_attempt_at).toBe(new Date(NOW.getTime() + 60_000).toISOString()); // ~1m
		expect(await claimDelivery(env, rowFor(after.next_attempt_at), new Date(NOW.getTime() + 61_000))).not.toBeNull();
	});

	it("a stale claim cannot be re-used to claim the row either", async () => {
		const { env } = seed();
		const claimA = (await claimDelivery(env, rowFor(), NOW))!;
		// Someone else moved it on; the original due-time no longer matches.
		expect(await claimDelivery(env, rowFor(DUE), NOW)).toBeNull();
		expect(await claimDelivery(env, rowFor(claimA.hold), new Date(NOW.getTime() + 6 * 60_000))).not.toBeNull();
	});
});
