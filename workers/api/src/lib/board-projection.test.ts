/**
 * The shared card projection and its four lanes (#1698). Real schema (`realSchemaD1`), so owner and instance isolation and the
 * queue handoff are exercised by the same SQL the board reads, and the Needs You badge is checked against the owner inbox itself.
 *
 * COVERED: one resumed/parked session; distinct attempts at one application; the pre-session objective and its handoff (pending,
 * claimed, started with a session, started without one); the four lanes for mixed coding / application / scan / queued records;
 * identical classification from the one pure function; Waiting to Resume (a recorded answer the run has not applied) is not Needs
 * You; two successive questions in one session; owner and instance isolation; agreement with the inbox (#1640).
 *
 * NOT COVERED (follow-up): the old `buildInstanceBoard` and its console, MCP and iOS consumers are not yet cut over to this projection,
 * and #1697's New / Discussed / Deferred triage does not exist, so nothing here models it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOARD_LANE_IDS, type CardFacts, classifyCard, groupIntoLanes, readBoardProjection, type ProjectedCard } from "./board-projection.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { readInbox } from "./inbox.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const T = 1_800_000_000_000;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder", "coder-2"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'coder', 'u1', 'app')`);
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

// One active session per repo is a real rule (`idx_coding_sessions_one_active`), so each session gets its own repo.
const session = (id: string, status = "active", instance = "coder", user = "u1", issue = "") => {
	d1.exec(`INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES (${q(`r-${id}`)}, ${q(instance)}, ${q(user)}, ${q(id)})`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status${issue ? ", issue_title" : ""}) VALUES (${q(id)}, ${q(instance)}, ${q(`r-${id}`)}, ${q(user)}, ${q(status)}${issue ? `, ${q(issue)}` : ""})`);
};
const run = (id: string, sessionId: string | null, status: string, over: { wait?: string; entry?: string; at?: number; instance?: string; user?: string } = {}) =>
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, queue_entry_id, waiting_reason)
		 VALUES (${q(id)}, ${q(over.user ?? "u1")}, ${q(over.instance ?? "coder")}, ${q(`objective of ${id}`)}, ${q(status)}, 10, ${over.at ?? T}, ${sessionId ? q(sessionId) : "NULL"}, ${over.entry ? q(over.entry) : "NULL"}, ${over.wait ? q(over.wait) : "NULL"})`,
	);
const question = (id: string, runId: string, sessionId: string, state: string, over: { answered?: boolean; applied?: boolean; at?: number } = {}) =>
	d1.exec(
		`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, question, state, asked_at, expires_at, answered_at, applied_at)
		 VALUES (${q(id)}, 'coder', 'u1', ${q(sessionId)}, ${q(runId)}, ${q(`question ${id}?`)}, ${q(state)}, ${over.at ?? T}, ${T + 86_400_000}, ${over.answered ? T + 1 : "NULL"}, ${over.applied ? T + 2 : "NULL"})`,
	);
const entry = (id: string, status: string, runId: string | null = null, instance = "coder", user = "u1") =>
	d1.exec(`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, run_id, created_at) VALUES (${q(id)}, ${q(instance)}, 'r1', ${q(user)}, ${q(`objective ${id}`)}, ${q(status)}, ${runId ? q(runId) : "NULL"}, ${T})`);
const apply = (id: string, app: string, status: string, instance = "coder", user = "u1") =>
	d1.exec(`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, created_at, updated_at) VALUES (${q(id)}, ${q(instance)}, ${q(user)}, ${q(app)}, ${q(`req-${id}`)}, ${q(status)}, '{}', ${T}, ${T})`);
const scan = (id: string, status: string, instance = "coder", user = "u1") =>
	d1.exec(`INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, status, policy, created_at, updated_at) VALUES (${q(id)}, ${q(instance)}, ${q(user)}, ${q(`req-${id}`)}, ${q(`scan ${id}`)}, ${q(status)}, '{}', ${T}, ${T})`);

const read = (instance = "coder", user = "u1") => readBoardProjection(env, instance, user);
const byId = (cards: ProjectedCard[], id: string) => cards.find((c) => c.cardId === id);

describe("classifyCard: one pure function for every board", () => {
	const lane = (f: CardFacts) => classifyCard(f).lane;
	it("waiting a turn, and awaiting the first session, are Queued, not Blocked", () => {
		expect(lane({ kind: "queued-objective", status: "pending" })).toBe("queued");
		expect(lane({ kind: "queued-objective", status: "running" })).toBe("queued"); // claimed by a drain, no session yet
		expect(lane({ kind: "coding-session", status: "active", runStatus: "running", waitingReason: "platform_interrupt" })).toBe("queued");
		expect(lane({ kind: "application-attempt", status: "queued" })).toBe("queued");
	});
	it("only an actual blocker is Blocked, with what blocks it and who acts next", () => {
		const parked = classifyCard({ kind: "coding-session", status: "active", runStatus: "running", waitingReason: "engine_limit" });
		expect(parked).toMatchObject({ lane: "blocked", needsYou: false, blocker: { nextOwner: "platform" } });
		expect(parked.blocker?.what).toMatch(/usage limit/);
		const human = classifyCard({ kind: "coding-session", status: "active", runStatus: "running", waitingReason: "human" });
		expect(human).toMatchObject({ lane: "blocked", needsYou: true, blocker: { nextOwner: "owner" } });
		expect(classifyCard({ kind: "scan", status: "paused" })).toMatchObject({ lane: "blocked", needsYou: true });
	});
	it("a terminal outcome is its own field, and Done holds all three", () => {
		expect(classifyCard({ kind: "coding-session", status: "ended", runStatus: "completed" })).toMatchObject({ lane: "done", outcome: "succeeded" });
		expect(classifyCard({ kind: "coding-session", status: "ended", runStatus: "failed" })).toMatchObject({ lane: "done", outcome: "failed" });
		expect(classifyCard({ kind: "coding-session", status: "ended", runStatus: "cancelled" })).toMatchObject({ lane: "done", outcome: "stopped" });
		expect(classifyCard({ kind: "application-attempt", status: "submitted" })).toMatchObject({ lane: "done", outcome: "succeeded" });
	});
	it("is deterministic: the same facts give the same answer, whichever board asks", () => {
		const f: CardFacts = { kind: "coding-session", status: "active", runStatus: "running", waitingReason: "decision", openQuestion: true, question: "Which branch?" };
		expect(classifyCard(f)).toEqual(classifyCard({ ...f }));
		expect(classifyCard(f).blocker?.what).toContain("Which branch?");
	});
});

describe("a parked, answered and resumed session is one card, and Waiting to Resume is not Needs You", () => {
	it("the same card moves Blocked (needs you) -> Queued (waiting to resume) -> In Progress, and never duplicates", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "decision" });
		question("q1", "run-1", "s1", "waiting_human");
		let cards = await read();
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ cardId: "csess-s1", lane: "blocked", needsYou: true, waitingToResume: false, blocker: { nextOwner: "owner" } });

		// The owner answered; the run has not applied it yet: waiting on the RUN, not a renewed owner action.
		d1.exec(`UPDATE coder_questions SET state = 'answered_human', answered_at = ${T + 1} WHERE id = 'q1'`);
		cards = await read();
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ cardId: "csess-s1", lane: "queued", needsYou: false, waitingToResume: true });
		expect(cards[0].blocker).toBeUndefined();

		// Applied and running again: same card.
		d1.exec(`UPDATE coder_questions SET applied_at = ${T + 2} WHERE id = 'q1'`);
		d1.exec(`UPDATE agent_loop_runs SET waiting_reason = NULL WHERE run_id = 'run-1'`);
		cards = await read();
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ cardId: "csess-s1", lane: "in_progress", needsYou: false, waitingToResume: false });
	});

	it("two successive questions in one session: the second is the owner's action, the first (answered, unapplied) is not, and it is one card", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "decision" });
		question("q1", "run-1", "s1", "answered_human", { answered: true, at: T });
		question("q2", "run-1", "s1", "waiting_human", { at: T + 5 });
		const cards = await read();
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ lane: "blocked", needsYou: true });
		expect(cards[0].blocker?.what).toContain("q2");
	});

	it("an unresolved question whose answer is pending is also waiting on the run", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "decision" });
		question("q1", "run-1", "s1", "unresolved");
		expect((await read())[0]).toMatchObject({ lane: "queued", waitingToResume: true, needsYou: false });
	});

	it("a finished run is Done with its outcome kept apart, and its native status stays available", async () => {
		session("s1", "ended");
		run("run-1", "s1", "failed");
		const [c] = await read();
		expect(c).toMatchObject({ lane: "done", outcome: "failed", nativeStatus: "ended" });
		expect(c.native).toMatchObject({ status: "ended", runId: "run-1", sessionId: "s1" });
	});

	it("a later run in the same session is the same card (a resume), and a new session is a new card", async () => {
		session("s1");
		run("run-1", "s1", "completed", { at: T });
		run("run-2", "s1", "running", { at: T + 100 });
		session("s2");
		const cards = await read();
		expect(cards.map((c) => c.cardId).sort()).toEqual(["csess-s1", "csess-s2"]);
		expect(byId(cards, "csess-s1")).toMatchObject({ lane: "in_progress" });
		expect(byId(cards, "csess-s1")?.attempts).toEqual(["run-2", "run-1"]);
	});

	it("the GitHub issue is metadata: it changes neither identity nor lane, and is not on the card", async () => {
		session("s1", "active", "coder", "u1", "Fix login #12");
		const [c] = await read();
		expect(c.cardId).toBe("csess-s1");
		expect(c).not.toHaveProperty("githubIssue");
		expect(c).not.toHaveProperty("issueRun");
	});
});

describe("distinct attempts against one application", () => {
	it("each fill or tailor run is its own card, at the same application", async () => {
		apply("f1", "app-1", "failed");
		apply("f2", "app-1", "running");
		d1.exec(`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, lead, created_at, updated_at) VALUES ('app-1', 'coder', 'u1', 'coder', 'lead-1', 1, 'k1', '{}', ${T}, ${T})`);
		d1.exec(`INSERT INTO local_artifact_runs (id, instance_id, user_id, application_id, request_id, status, policy, created_at, updated_at) VALUES ('t1', 'coder', 'u1', 'app-1', 'req-t1', 'completed', '{}', ${T}, ${T})`);
		const cards = (await read()).filter((c) => c.kind === "application-attempt");
		expect(cards.map((c) => c.cardId).sort()).toEqual(["app-attempt-fill-f1", "app-attempt-fill-f2", "app-attempt-tailor-t1"]);
		expect(byId(cards, "app-attempt-fill-f1")).toMatchObject({ lane: "done", outcome: "failed" });
		expect(byId(cards, "app-attempt-fill-f2")).toMatchObject({ lane: "in_progress" });
		expect(byId(cards, "app-attempt-tailor-t1")).toMatchObject({ lane: "done", outcome: "succeeded" });
		expect(byId(cards, "app-attempt-fill-f1")?.native.applicationId).toBe("app-1");
	});

	it("a review the owner must give is Blocked and Needs You; a submitted attempt is Done", async () => {
		apply("f1", "app-1", "awaiting_review");
		apply("f2", "app-2", "submitted");
		const cards = await read();
		expect(byId(cards, "app-attempt-fill-f1")).toMatchObject({ lane: "blocked", needsYou: true });
		expect(byId(cards, "app-attempt-fill-f2")).toMatchObject({ lane: "done", outcome: "succeeded" });
	});
});

describe("the pre-session objective and its handoff", () => {
	it("pending and drain-claimed entries are cards in Queued, distinct from any session: no gap while the drain starts it", async () => {
		entry("e1", "pending");
		entry("e2", "running");
		const cards = await read();
		expect(cards.map((c) => c.cardId).sort()).toEqual(["objective:e1", "objective:e2"]);
		for (const c of cards) expect(c).toMatchObject({ kind: "queued-objective", lane: "queued", needsYou: false });
	});

	it("once its run has a session, the session card replaces the objective card: never both, never neither", async () => {
		entry("e1", "started", "run-1");
		expect((await read()).map((c) => c.cardId)).toEqual(["objective:e1"]); // started, run not yet linked to a session

		session("s1");
		run("run-1", "s1", "running", { entry: "e1" });
		const cards = await read();
		expect(cards.map((c) => c.cardId)).toEqual(["csess-s1"]);
		expect(cards[0].lane).toBe("in_progress");
	});

	it("an entry that started a run with no session (a non-coding run) stays visible and is classified from that run", async () => {
		entry("e1", "started", "run-x");
		run("run-x", null, "completed", { entry: "e1" });
		entry("e2", "started", "run-y");
		run("run-y", null, "failed", { entry: "e2" });
		const cards = await read();
		expect(byId(cards, "objective:e1")).toMatchObject({ lane: "done", outcome: "succeeded" });
		expect(byId(cards, "objective:e2")).toMatchObject({ lane: "done", outcome: "failed" });
	});

	it("a drain that could not start an entry leaves a Done/failed card, not a vanished one", async () => {
		entry("e1", "failed");
		expect((await read())[0]).toMatchObject({ cardId: "objective:e1", lane: "done", outcome: "failed" });
	});
});

describe("mixed records land in the four lanes", () => {
	it("coding, application, scan and queued records are placed correctly, with no duplicate card", async () => {
		session("s-run");
		run("r-run", "s-run", "running");
		session("s-wait");
		run("r-wait", "s-wait", "running", { wait: "human" });
		session("s-done", "ended");
		run("r-done", "s-done", "completed");
		apply("a1", "app-1", "queued");
		apply("a2", "app-2", "running");
		scan("sc1", "paused");
		scan("sc2", "completed");
		entry("e1", "pending");
		const cards = await read();
		const lanes = groupIntoLanes(cards);
		expect(Object.keys(lanes)).toEqual([...BOARD_LANE_IDS]);
		const ids = (l: ProjectedCard[]) => l.map((c) => c.cardId).sort();
		expect(ids(lanes.queued)).toEqual(["app-attempt-fill-a1", "objective:e1"]);
		expect(ids(lanes.in_progress)).toEqual(["app-attempt-fill-a2", "csess-s-run"]);
		expect(ids(lanes.blocked)).toEqual(["csess-s-wait", "scan-sc1"]);
		expect(ids(lanes.done)).toEqual(["csess-s-done", "scan-sc2"]);
		expect(new Set(cards.map((c) => c.cardId)).size).toBe(cards.length);
		// Needs You is a badge on the blocked cards, not a lane:
		expect(cards.filter((c) => c.needsYou).map((c) => c.cardId).sort()).toEqual(["csess-s-wait", "scan-sc1"]);
	});
});

describe("owner and instance isolation", () => {
	beforeEach(() => {
		seedTenant(d1, { userId: "u2", instanceIds: ["theirs"] });
	});

	it("another owner's cards, on any instance, never appear; another instance of the same owner does not leak in", async () => {
		session("mine");
		session("sibling", "active", "coder-2");
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('rt', 'theirs', 'u2', 'x')`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('theirs-s', 'theirs', 'rt', 'u2')`);
		apply("their-apply", "app-9", "running", "theirs", "u2");
		scan("their-scan", "running", "theirs", "u2");
		entry("their-entry", "pending", null, "theirs", "u2");
		const mine = await read("coder", "u1");
		expect(mine.map((c) => c.cardId)).toEqual(["csess-mine"]);
		expect((await read("coder-2", "u1")).map((c) => c.cardId)).toEqual(["csess-sibling"]);
		// u1 asking for u2's instance, and u2 asking for u1's, both get nothing.
		expect(await read("theirs", "u1")).toEqual([]);
		expect(await read("coder", "u2")).toEqual([]);
	});

	it("the same raw ids on two owners' instances stay separate", async () => {
		session("same");
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('rt', 'theirs', 'u2', 'x')`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status) VALUES ('same2', 'theirs', 'rt', 'u2', 'ended')`);
		expect((await read("coder", "u1")).map((c) => c.cardId)).toEqual(["csess-same"]);
		expect((await read("theirs", "u2")).map((c) => c.cardId)).toEqual(["csess-same2"]);
	});
});

describe("Needs You is the owner inbox's own rule (#1640)", () => {
	const inboxIds = async () => (await readInbox(env, "u1", T + 10)).items.filter((i) => i.kind === "coder_question" || i.kind === "run_parked").map((i) => i.id).sort();

	it("an open question: the card badges Needs You and the inbox lists exactly that question", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "decision" });
		question("q1", "run-1", "s1", "waiting_human");
		expect((await read())[0].needsYou).toBe(true);
		expect(await inboxIds()).toEqual(["coder_question:q1"]);
	});

	it("a recorded, unapplied answer: not Needs You on the card, and not in the inbox either", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "decision" });
		question("q1", "run-1", "s1", "answered_human", { answered: true });
		expect((await read())[0]).toMatchObject({ needsYou: false, waitingToResume: true });
		expect(await inboxIds()).toEqual([]);
	});

	it("a run parked on the owner: badge on the card, listed once in the inbox", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "human" });
		expect((await read())[0].needsYou).toBe(true);
		expect(await inboxIds()).toEqual(["run_parked:run-1"]);
	});

	it("a run waiting on a usage limit is Blocked but not Needs You, and not in the inbox", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "engine_limit" });
		expect((await read())[0]).toMatchObject({ lane: "blocked", needsYou: false });
		expect(await inboxIds()).toEqual([]);
	});
});
