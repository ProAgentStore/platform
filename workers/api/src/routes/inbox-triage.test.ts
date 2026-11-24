import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Env } from "../types.js";

const session = vi.hoisted(() => ({ uid: "u1" }));
vi.mock("../lib/auth.js", () => ({ requireUser: async () => ({ uid: session.uid }) }));

import { inboxRoutes } from "./inbox.js";

/**
 * Owner triage on the Needs you inbox (#1697), EXECUTED against real SQLite for inbox_triage. The source tables are a
 * small stand-in: coder_questions and agent_loop_runs return the rows listed here for the bound owner, nothing else.
 */
const MIGRATION = join(__dirname, "../../migrations/0349_inbox_triage.sql");

type Row = Record<string, unknown>;
interface World {
	questions: Array<Row & { user_id: string }>;
	runs: Array<Row & { user_id: string }>;
}

function env(db: DatabaseSync, w: World): Env {
	return {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						const rows = (): Row[] => {
							if (sql.includes("FROM coder_questions r")) return w.questions.filter((r) => r.user_id === args[0]);
							if (sql.includes("FROM agent_loop_runs r")) return w.runs.filter((r) => r.user_id === args[0]);
							return [];
						};
						const real = sql.includes("inbox_triage");
						return {
							async run() {
								const r = db.prepare(sql).run(...(args as never[]));
								return { meta: { changes: Number(r.changes) } };
							},
							async first() {
								return { n: rows().length };
							},
							async all() {
								return { results: real ? (db.prepare(sql).all(...(args as never[])) as Row[]) : rows() };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
}

const inst = { instance_id: "i1", icfg: null, aname: "Coder", aslug: "coder-repo" };
const question = (id: string, session_id: string, user_id = "u1") => ({ id, session_id, task_id: null, question: `Q ${id}`, why: "", asked_at: Date.now() - 1000, expires_at: Date.now() + 3_600_000, user_id, ...inst });
const run = (id: string) => ({ id, session_id: "s9", objective: "Connect Slack OAuth", waiting_reason: "human", waiting_until: null, parked_since: Date.now() - 500, started_at: Date.now() - 900, user_id: "u1", ...inst });

let db: DatabaseSync;
let world: World;
const app = () => {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1", inboxRoutes);
	return a;
};
const call = (e: Env, path: string, body?: unknown) => app().request(`/v1${path}`, body === undefined ? {} : { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, e);
const list = async (e: Env, qs = "") => ((await (await call(e, `/inbox${qs}`)).json()) as { items: Array<{ id: string; triage?: { status: string; needsComputer: boolean; deferUntil: string | null } }>; counts: { total: number; byTriage: Record<string, number> } });
const ids = (r: { items: Array<{ id: string }> }) => r.items.map((i) => i.id).sort();

beforeEach(() => {
	session.uid = "u1";
	db = new DatabaseSync(":memory:");
	db.exec(readFileSync(MIGRATION, "utf8"));
	world = { questions: [question("q1", "sess1"), question("q2", "sess1")], runs: [run("r1")] };
});

describe("inbox triage (#1697)", () => {
	it("default review shows New items; discussed, deferred and desktop items surface on demand and keep counting", async () => {
		const e = env(db, world);
		expect(ids(await list(e))).toEqual(["coder_question:q1", "coder_question:q2", "run_parked:r1"]);
		expect((await call(e, "/inbox/triage", { item_id: "coder_question:q1", status: "discussed" })).status).toBe(200);
		expect((await call(e, "/inbox/triage", { item_id: "run_parked:r1", status: "deferred", needs_computer: true })).status).toBe(200);

		const review = await list(e);
		expect(ids(review)).toEqual(["coder_question:q2"]);
		// triage never hides it from the whole-set counts, nor from the nav badge predicate
		expect(review.counts.total).toBe(3);
		expect(review.counts.byTriage).toMatchObject({ new: 1, discussed: 1, deferred: 1, needsComputer: 1 });
		expect(ids(await list(e, "?triage=discussed"))).toEqual(["coder_question:q1"]);
		expect(ids(await list(e, "?triage=deferred"))).toEqual(["run_parked:r1"]);
		expect(ids(await list(e, "?triage=all"))).toHaveLength(3);
		// Needs computer spans every status, so a deferred desktop question is still found
		const desk = await list(e, "?needs_computer=1");
		expect(ids(desk)).toEqual(["run_parked:r1"]);
		expect(desk.items[0].triage).toMatchObject({ status: "deferred", needsComputer: true });
	});

	it("undo returns an item to New; the question itself is untouched", async () => {
		const e = env(db, world);
		await call(e, "/inbox/triage", { item_id: "coder_question:q1", status: "deferred" });
		expect(ids(await list(e))).not.toContain("coder_question:q1");
		await call(e, "/inbox/triage", { item_id: "coder_question:q1", status: "new" });
		expect(ids(await list(e))).toContain("coder_question:q1");
	});

	it("a deferral with defer_until comes back as New once it passes, and shows the date meanwhile", async () => {
		const e = env(db, world);
		const until = new Date(Date.now() + 3_600_000).toISOString();
		const res = await call(e, "/inbox/triage", { item_id: "coder_question:q1", defer_until: until });
		expect(((await res.json()) as { triage: { status: string; deferUntil: string } }).triage).toMatchObject({ status: "deferred", deferUntil: until });
		expect((await list(e, "?triage=deferred")).items[0].triage?.deferUntil).toBe(until);
		db.prepare("UPDATE inbox_triage SET defer_until = ?1").run(Date.now() - 1);
		expect(ids(await list(e))).toContain("coder_question:q1");
		expect((await call(e, "/inbox/triage", { item_id: "coder_question:q1", status: "deferred", defer_until: new Date(Date.now() - 5000).toISOString() })).status).toBe(400);
	});

	it("a new question in the same session starts New, and triage survives a restart", async () => {
		await call(env(db, world), "/inbox/triage", { item_id: "coder_question:q1", status: "deferred" });
		world.questions = [question("q1", "sess1"), question("q3", "sess1")];
		const restarted = env(db, world); // fresh env, same database
		const r = await list(restarted, "?triage=all");
		expect(r.items.find((i) => i.id === "coder_question:q1")?.triage?.status).toBe("deferred");
		expect(r.items.find((i) => i.id === "coder_question:q3")?.triage?.status).toBe("new");
	});

	it("is owner-scoped: another user's item is a 404 and nothing is written", async () => {
		world.questions.push(question("q9", "sess9", "u2"));
		const e = env(db, world);
		const res = await call(e, "/inbox/triage", { item_id: "coder_question:q9", status: "discussed" });
		expect(res.status).toBe(404);
		expect(db.prepare("SELECT COUNT(*) AS n FROM inbox_triage").get()).toEqual({ n: 0 });
		session.uid = "u2";
		expect(ids(await list(e))).toEqual(["coder_question:q9"]);
		expect((await call(e, "/inbox/triage", { item_id: "coder_question:q9", status: "discussed" })).status).toBe(200);
		session.uid = "u1";
		expect(ids(await list(e))).not.toContain("coder_question:q9");
	});

	it("rejects kinds that are not triaged and bad bodies", async () => {
		const e = env(db, world);
		expect((await call(e, "/inbox/triage", { item_id: "task:t1", status: "discussed" })).status).toBe(400);
		expect((await call(e, "/inbox/triage", { item_id: "coder_question:q1", status: "later" })).status).toBe(400);
		expect((await call(e, "/inbox/triage", { item_id: "coder_question:q1" })).status).toBe(400);
	});
});
