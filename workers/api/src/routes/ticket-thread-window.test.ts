/**
 * Which 200 events a ticket thread reads, when a ticket has more than 200 (#653).
 *
 * `mirroredTaskEvents` capped at 200 with `ORDER BY created_at ASC`, so it kept the OLDEST 200 and
 * dropped everything after. Past that point the thread stopped updating — including the question
 * the owner had just posted, which the route persists BEFORE the model call — and every subsequent
 * `/ask` was answered from a permanently frozen window, with full confidence and no indication
 * that the newest turns had not been read.
 *
 * Both callers want the TAIL and one of them says so twice: `instances-tasks.ts` renders the thread
 * newest-last, and `ticket-chat.ts` does `.slice(-TICKET_THREAD_CONTEXT_TURNS)` on the result —
 * "the newest twelve" of a window that stopped advancing at event 200.
 *
 * Reaching 200 is not hypothetical: `packages/browser-runner/src/runner.ts` has 24 `addTaskEvent`
 * call sites, several inside polling loops (one emits `job.human_challenge_present` once per poll
 * while a captcha is unsolved), and every one carries the same `taskId`.
 *
 * The fix is the same decision #674 took for `coding_timeline`, in the other surface: an
 * oldest-first window over an append-only log hands the caller the wrong end. Here there is no
 * second direction to offer — nothing pages this read — so it simply takes the newest N and returns
 * them in render order.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { ticketThreadFromEvents } from "../lib/ticket-chat.js";
import { mirroredTaskEvents } from "./instances-runtime.js";
import type { Env } from "../types.js";

const USER = "u1";
const INSTANCE = "i1";
const TASK = "task-long";

describe("mirroredTaskEvents — a long ticket keeps its NEWEST events, not its first (#653)", () => {
	let db: RealSchemaD1;
	let env: Env;

	beforeEach(() => {
		db = realSchemaD1();
		seedTenant(db, { userId: USER, instanceIds: [INSTANCE] });
		env = { DB: db.DB } as unknown as Env;
	});

	/** `created_at` ascending by construction, so ordering is decided by the query, not by ties. */
	function seedEvents(n: number, taskId = TASK): void {
		for (let i = 0; i < n; i++) {
			const at = `2026-08-16T${String(Math.floor(i / 3600)).padStart(2, "0")}:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`;
			db.sqlite
				.prepare(
					"INSERT INTO instance_runtime_task_events (id, instance_id, user_id, task_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					`ev-${taskId}-${i}`,
					INSTANCE,
					USER,
					taskId,
					"job.progress",
					JSON.stringify({ id: `ev-${taskId}-${i}`, taskId, type: "job.progress", message: `event ${i}`, createdAt: at }),
					at,
				);
		}
	}

	const messages = (events: unknown[]) => events.map((e) => (e as { message: string }).message);

	it("G1 — the fixture really holds more than the cap, before any claim about which end is kept", () => {
		seedEvents(250);
		const row = db.sqlite.prepare("SELECT COUNT(*) n FROM instance_runtime_task_events WHERE task_id = ?").get(TASK) as { n: number };
		// ADR 0002: a read that silently returned nothing would satisfy every ordering claim below
		// by vacuity, and a fixture under the cap would satisfy them by being small.
		expect(row.n).toBe(250);
	});

	it("keeps the LAST 200 of a 250-event ticket", async () => {
		seedEvents(250);
		const events = await mirroredTaskEvents(env, INSTANCE, USER, TASK);
		expect(events).toHaveLength(200);
		expect(messages(events)[199]).toBe("event 249");
		expect(messages(events)[0]).toBe("event 50");
	});

	it("returns them oldest→newest, which is the order the thread renders and the model reads", async () => {
		seedEvents(250);
		const events = await mirroredTaskEvents(env, INSTANCE, USER, TASK);
		const stamps = events.map((e) => (e as { createdAt: string }).createdAt);
		expect(stamps).toEqual([...stamps].sort());
	});

	it("the newest turn is visible to the thread — the question just asked is not dropped", async () => {
		seedEvents(250);
		// The exact production sequence: the route persists the owner's question, THEN reads the
		// thread for the model. Before this fix the question fell outside the window it had just
		// been appended to, and the answer was built as though it had never been asked.
		db.sqlite
			.prepare("INSERT INTO instance_runtime_task_events (id, instance_id, user_id, task_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(
				"ticketq_new",
				INSTANCE,
				USER,
				TASK,
				"ticket.question",
				JSON.stringify({ id: "ticketq_new", taskId: TASK, type: "ticket.question", message: "why did you skip the second repo?", createdAt: "2026-08-17T00:00:00.000Z" }),
				"2026-08-17T00:00:00.000Z",
			);
		const events = await mirroredTaskEvents(env, INSTANCE, USER, TASK);
		const thread = ticketThreadFromEvents(events);
		expect(thread.map((t) => t.text)).toContain("why did you skip the second repo?");
	});

	it("a ticket under the cap is unchanged — every event, oldest→newest", async () => {
		seedEvents(5);
		const events = await mirroredTaskEvents(env, INSTANCE, USER, TASK);
		expect(messages(events)).toEqual(["event 0", "event 1", "event 2", "event 3", "event 4"]);
	});

	it("stays scoped to its own ticket and tenant", async () => {
		seedEvents(10);
		seedEvents(10, "other-task");
		const events = await mirroredTaskEvents(env, INSTANCE, USER, TASK);
		expect(events).toHaveLength(10);
		expect(messages(events).every((m) => m.startsWith("event"))).toBe(true);
		// A different user sees nothing, even naming the right task.
		expect(await mirroredTaskEvents(env, INSTANCE, "someone-else", TASK)).toHaveLength(0);
	});

	it("honours an explicit smaller limit, still from the newest end", async () => {
		seedEvents(50);
		const events = await mirroredTaskEvents(env, INSTANCE, USER, TASK, 5);
		expect(messages(events)).toEqual(["event 45", "event 46", "event 47", "event 48", "event 49"]);
	});
});
