/**
 * #1185: a run's published verdict is reconciled with its session, and a repin names the runs it leaves parked.
 * Real schema, real rows; nothing is faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parkedDecisionRuns, reconcileRunWithSession, repinNote, repinParkedWarning, SESSION_END_GRACE_MS, sessionFactsFor, sessionIsGone } from "./coding-run-session.js";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";

let d1: RealSchemaD1;
const NOW = Date.parse("2026-10-22T12:00:00Z");

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a1', 'u1', 't1185-coder', 'Coder', '{}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'a1', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'demo')`);
});
afterEach(() => d1.close());

const session = (id: string, status: string, node: string | null, endedAt: string | null = null, user = "u1") =>
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, runner_node, ended_at) VALUES ('${id}', 'i1', 'r1', '${user}', '${status}', ${node ? `'${node}'` : "NULL"}, ${endedAt ? `'${endedAt}'` : "NULL"})`);
const parkedRun = (runId: string, sid: string) =>
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at, session_id, waiting_reason, waiting_ask, parked_since) VALUES ('${runId}','u1','i1','x','running',1,10,1,'${sid}','decision','{"question":"Which one?"}',2)`,
	);
const view = (over: Record<string, unknown> = {}) => ({ status: "running", sessionId: "s1", health: "waiting", waitNote: null as string | null, ...over });

describe("sessionFactsFor / sessionIsGone", () => {
	it("reads the owner's sessions in one batch and parses ended_at as UTC", async () => {
		session("s1", "ended", "mac", "2026-10-22 11:00:00");
		session("s2", "active", "pc");
		session("s3", "ended", "mac", "2026-10-22 11:00:00", "u2");
		const facts = await sessionFactsFor({ DB: d1.DB }, "u1", ["s1", "s2", "s3", "nope", ""]);
		expect([...facts.keys()].sort()).toEqual(["s1", "s2"]);
		expect(facts.get("s1")).toMatchObject({ status: "ended", endedAt: Date.parse("2026-10-22T11:00:00Z"), node: "mac" });
		expect(facts.get("s2")).toMatchObject({ status: "active", endedAt: null });
	});

	it("an ended session is gone only after the grace window; a live one never is", () => {
		const f = (status: string, endedAt: number | null) => ({ id: "s", status, endedAt, node: null });
		expect(sessionIsGone(f("ended", NOW - SESSION_END_GRACE_MS - 1), NOW)).toBe(true);
		expect(sessionIsGone(f("ended", NOW - 1000), NOW)).toBe(false);
		expect(sessionIsGone(f("ended", null), NOW)).toBe(true);
		expect(sessionIsGone(f("suspended", null), NOW)).toBe(false);
		expect(sessionIsGone(f("active", null), NOW)).toBe(false);
		expect(sessionIsGone(undefined, NOW)).toBe(false);
	});
});

describe("reconcileRunWithSession — stale waiting runs", () => {
	const gone = new Map([["s1", { id: "s1", status: "ended", endedAt: NOW - 10 * 60_000, node: "mac" }]]);

	it("a running run whose session ended is stalled and says what to do", () => {
		const r = reconcileRunWithSession(view({ waitNote: "Waiting on a decision." }), gone, NOW);
		expect(r).toMatchObject({ health: "stalled", sessionEnded: true, session: { id: "s1", status: "ended" } });
		expect(r.waitNote).toMatch(/^Waiting on a decision\. Its session s1 has ended/);
		expect(r.waitNote).toMatch(/coding_loop_stop.*coding_loop_start/);
	});

	it("keeps its verdict inside the grace window, a live session, a closed run, and a run with no session", () => {
		const fresh = new Map([["s1", { id: "s1", status: "ended", endedAt: NOW - 1000, node: null }]]);
		expect(reconcileRunWithSession(view(), fresh, NOW)).toMatchObject({ health: "waiting", session: { status: "ended" } });
		expect(reconcileRunWithSession(view(), fresh, NOW)).not.toHaveProperty("sessionEnded");
		const live = new Map([["s1", { id: "s1", status: "suspended", endedAt: null, node: "mac" }]]);
		expect(reconcileRunWithSession(view(), live, NOW).health).toBe("waiting");
		const closed = view({ status: "done", health: "ended" });
		expect(reconcileRunWithSession(closed, gone, NOW)).toBe(closed);
		const none = view({ sessionId: null });
		expect(reconcileRunWithSession(none, gone, NOW)).toBe(none);
		const unknown = view({ sessionId: "zz" });
		expect(reconcileRunWithSession(unknown, gone, NOW)).toBe(unknown);
	});
});

describe("repin with a parked decision run", () => {
	it("finds the parked runs with their machine and question", async () => {
		session("s1", "suspended", "mac");
		parkedRun("run1", "s1");
		expect(await parkedDecisionRuns({ DB: d1.DB }, "i1", "u1")).toEqual([{ runId: "run1", sessionId: "s1", node: "mac", question: "Which one?" }]);
		expect(await parkedDecisionRuns({ DB: d1.DB }, "i1", "u2")).toEqual([]);
	});

	it("warns that the run stays on its parked machine, and says nothing when it is already on the new one", async () => {
		session("s1", "suspended", "mac");
		parkedRun("run1", "s1");
		const away = await repinNote({ DB: d1.DB }, "i1", "u1", "laptop");
		expect(away.parkedRuns).toHaveLength(1);
		expect(away.warning).toMatch(/parked on a question on mac, not on laptop/);
		expect(away.warning).toMatch(/only there/);
		expect(await repinNote({ DB: d1.DB }, "i1", "u1", "MAC")).toEqual({});
	});

	it("says nothing without parked runs, and a failed read never fails the repin", async () => {
		expect(await repinNote({ DB: d1.DB }, "i1", "u1", "laptop")).toEqual({});
		expect(await repinNote({ DB: {} as never }, "i1", "u1", "laptop")).toEqual({});
		expect(repinParkedWarning([], "laptop")).toBeNull();
	});

	it("pluralises for several runs", () => {
		const w = repinParkedWarning([{ runId: "a", sessionId: "s", node: "mac", question: null }, { runId: "b", sessionId: "t", node: null, question: null }], "laptop");
		expect(w?.warning).toMatch(/^2 runs are parked/);
	});
});
