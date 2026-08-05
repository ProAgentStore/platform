import { describe, expect, it } from "vitest";
import { closeWorkCards, setWorkCardProgress, upsertWorkCard } from "./work-card.js";
import { delegationTaskRecord } from "./delegation.js";
import { recentWorkForInstances } from "./instance-work.js";
import type { Env } from "../types.js";

function stubEnv(rows: unknown[] = []) {
	const writes: Array<{ sql: string; args: unknown[] }> = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
							async all() { return { results: rows }; },
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, writes };
}

describe("setWorkCardProgress — the live progress line", () => {
	it("refuses to touch a card that is no longer running", async () => {
		// The load-bearing guard. A progress write racing the terminal write would otherwise flip a
		// completed card back to running, and a supervisor would keep waiting on finished work —
		// exactly the failure the board exists to prevent. An upsert here would be a bug.
		const { env, writes } = stubEnv();
		await setWorkCardProgress(env, "i1", "u1", "deleg-1", "reading the failing test");
		expect(writes[0].sql).toContain("status = 'running'");
		expect(writes[0].sql).not.toContain("INSERT");
	});

	it("writes only the description — it cannot rebuild the card wrong", async () => {
		const { env, writes } = stubEnv();
		await setWorkCardProgress(env, "i1", "u1", "deleg-1", "reading the failing test");
		expect(writes[0].sql).toContain("'$.description'");
		expect(writes[0].sql).not.toContain("'$.status'");
		expect(writes[0].args).toEqual(["reading the failing test", "deleg-1", "i1", "u1"]);
	});

	it("skips an empty or whitespace-only line rather than blanking the field", async () => {
		const { env, writes } = stubEnv();
		await setWorkCardProgress(env, "i1", "u1", "deleg-1", "   ");
		expect(writes).toHaveLength(0);
	});

	it("bounds the line so a rambling model can't bloat a supervisor's prompt", async () => {
		const { env, writes } = stubEnv();
		await setWorkCardProgress(env, "i1", "u1", "deleg-1", "x".repeat(900));
		expect((writes[0].args[0] as string).length).toBe(300);
	});

	it("scopes to the owner as well as the instance", async () => {
		const { env, writes } = stubEnv();
		await setWorkCardProgress(env, "i1", "u1", "deleg-1", "hi");
		expect(writes[0].sql).toContain("instance_id = ?3 AND user_id = ?4");
	});
});

describe("the progress line actually reaches a supervisor", () => {
	it("a card's description is what recentWorkForInstances reports as detail", async () => {
		// End to end for #207B: the Pilot writes `$.description`, and that is the field the
		// supervisor's reader takes its one-line detail from. If these two ever disagree the
		// feature is silently dead while every individual piece still passes.
		const { env } = stubEnv([{
			instance_id: "i1",
			id: "deleg-1",
			type: "delegation",
			status: "running",
			payload: JSON.stringify({ title: "Delegated: green the suite", description: "reading the failing test" }),
			updated_at: "2026-08-05T10:00:00.000Z",
		}]);
		const [w] = await recentWorkForInstances(env, "u1", ["i1"]);
		expect(w.detail).toBe("reading the failing test");
	});

	it("a delegation's OUTCOME also lands in description, not only in reasoning", async () => {
		// `reasoning` is in neither generic reader's fallback chain, so before this the finished
		// delegation's outcome text reached the console and nothing else — a supervisor saw a
		// completed card with a blank detail.
		const done = delegationTaskRecord({
			id: "deleg-1", targetLabel: "fws/platform", objective: "green the suite",
			status: "completed", now: "2026-08-05T12:00:00.000Z", note: "outcome: done — 3 tests fixed",
		});
		expect(done.description).toBe("outcome: done — 3 tests fixed");
		const open = delegationTaskRecord({
			id: "deleg-1", targetLabel: "fws/platform", objective: "green the suite",
			status: "running", now: "2026-08-05T12:00:00.000Z",
		});
		// Nothing while it is running — that field belongs to the live progress line until close.
		expect(open).not.toHaveProperty("description");
	});
});

describe("upsertWorkCard / closeWorkCards — the shared writes", () => {
	it("upserts on id conflict", async () => {
		const { env, writes } = stubEnv();
		await upsertWorkCard(env, { instanceId: "i", userId: "u", id: "c1", task: { type: "t", status: "running" } });
		expect(writes[0].sql).toContain("ON CONFLICT(id) DO UPDATE");
		expect(writes[0].args[0]).toBe("c1");
	});

	it("issues no query for an empty close", async () => {
		const { env, writes } = stubEnv();
		await closeWorkCards(env, "i", "u", [], "completed");
		expect(writes).toHaveLength(0);
	});
});
