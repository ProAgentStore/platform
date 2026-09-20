/**
 * Which run a resume note is ABOUT, against the real schema (#806).
 *
 * `coding-resume-note.test.ts` pins what the note says, with the predecessor lookup stubbed. That
 * stub answered whatever row it was given, so it could not see the defect this file exists for: the
 * lookup asked `session_id = ?`, and the successor of an agent-started run is on a DIFFERENT session.
 * A run that opens its own session closes it when it ends (`shouldEndSessionAfterRun` → `endSession`),
 * so the next run on that repo opens a new one — and was briefed about nothing.
 *
 * Driven end to end through `pendingCodingResumeNote` on an in-memory SQLite built from every
 * migration, so the join, the repo subquery and the act window all really execute.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { CONTINUE_RESUME_LOOKBACK_MS } from "./agent-loop-store.js";
import { LEARNED_PREFIX } from "./coding-loop.js";
import { pendingCodingResumeCheckpoint, pendingCodingResumeNote } from "./coding-resume-note.js";
import type { Env } from "../types.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

let d1: RealSchemaD1;
let env: Env;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function repo(id: string, user = "u1", instance = "inst-1") {
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES (${q(id)}, ${q(instance)}, ${q(user)}, ${q(id)})`);
}

function session(id: string, repoId: string, status: "active" | "ended" | "error", user = "u1", instance = "inst-1") {
	d1.exec(
		`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status) VALUES (${q(id)}, ${q(instance)}, ${q(repoId)}, ${q(user)}, ${q(status)})`,
	);
}

function run(id: string, sessionId: string, opts: { startedAt: number; finishedAt: number | null; stopReason: string | null; user?: string }) {
	const user = opts.user ?? "u1";
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id)
		  VALUES (${q(id)}, ${q(user)}, 'inst-1', 'Work through the open issues', ${q(opts.finishedAt === null ? "running" : "failed")},
		          ${opts.stopReason === null ? "NULL" : q(opts.stopReason)}, 10, ${opts.startedAt}, ${opts.finishedAt ?? "NULL"}, ${q(sessionId)})`,
	);
}

function pushAct(id: string, ts: number, sessionId: string, user = "u1") {
	// `sessionId` is on every real act (`engine-acts.ts`), and the window is read by it (#809).
	const context = JSON.stringify({ act: "push.trunk", ok: true, irreversible: true, command: "git push origin main", sessionId });
	d1.exec(
		`INSERT INTO agent_events (id, ts, user_id, instance_id, trace_id, source, event, message, context)
		  VALUES (${q(id)}, ${ts}, ${q(user)}, 'inst-1', 'sess', 'coding', 'act.consequential', 'pushed directly to the trunk origin main', ${q(context)})`,
	);
}

/** A timeline row at a given instant — `created_at` is SQLite's own `datetime`, as `appendTimeline` leaves it. */
function timeline(sessionId: string, type: string, content: string, atMs: number) {
	d1.exec(
		`INSERT INTO coding_timeline (session_id, instance_id, user_id, type, content, created_at)
		  VALUES (${q(sessionId)}, 'inst-1', 'u1', ${q(type)}, ${q(content)}, datetime(${Math.floor(atMs / 1000)}, 'unixepoch'))`,
	);
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	env = { DB: d1.DB } as unknown as Env;
	repo("repo-r");
	repo("repo-other");
	// Run A opened S1 on repo R, landed a push, spent its step budget, and — being run-opened — had
	// S1 closed behind it. This is the #523 shape: a delegated run, `status: error`.
	session("s1", "repo-r", "error");
	run("run-a", "s1", { startedAt: NOW - 90 * MIN, finishedAt: NOW - 30 * MIN, stopReason: "max_iterations" });
	pushAct("act-1", NOW - 60 * MIN, "s1");
});

afterEach(() => d1.close());

describe("the successor of a run-opened session is on a NEW session (#806)", () => {
	it("run B on a new session S2 of the SAME repo is briefed about run A", async () => {
		session("s2", "repo-r", "active");
		const note = await pendingCodingResumeNote(env, { userId: "u1", instanceId: "inst-1", sessionId: "s2" }, NOW);
		expect(note, "run B got no note — the lookup is still keyed on the session, not the repo").not.toBeNull();
		expect(note).toContain("a previous run on this repository used up its step limit");
		expect(note).toContain("pushed directly to the trunk origin main");
	});

	it("briefs run B about a predecessor that pushed NOTHING, when the tree it starts on is dirty (#806)", async () => {
		// #806's own shape: the run was cut off with a partial fix on disk and no act on the record.
		d1.exec("DELETE FROM agent_events");
		session("s2", "repo-r", "active");
		const params = { userId: "u1", instanceId: "inst-1", sessionId: "s2" };
		expect(await pendingCodingResumeNote(env, params, NOW), "a clean tree and no acts is still nothing to say").toBeNull();
		const note = await pendingCodingResumeNote(env, { ...params, uncommittedFiles: 3 }, NOW);
		expect(note).toContain("a previous run on this repository used up its step limit");
		expect(note).toContain("The working tree holds 3 uncommitted files right now.");
	});

	it("a dirty tree alone briefs nobody — without an unfinished predecessor it is just REPOSITORY STATE's job", async () => {
		session("s3", "repo-other", "active");
		expect(await pendingCodingResumeNote(env, { userId: "u1", instanceId: "inst-1", sessionId: "s3", uncommittedFiles: 5 }, NOW)).toBeNull();
	});

	it("a session on a DIFFERENT repo is briefed about nothing, though run A is in the window", async () => {
		session("s3", "repo-other", "active");
		expect(await pendingCodingResumeNote(env, { userId: "u1", instanceId: "inst-1", sessionId: "s3" }, NOW)).toBeNull();
	});

	it("still briefs only the IMMEDIATE predecessor — a verdict on any session of the repo ends the note's job", async () => {
		// Run B picked the note up on S2 and finished the work. Run C, on yet another session, must not
		// be re-briefed on A's already-consumed checkpoint.
		session("s2", "repo-r", "ended");
		run("run-b", "s2", { startedAt: NOW - 20 * MIN, finishedAt: NOW - 5 * MIN, stopReason: "done" });
		session("s4", "repo-r", "active");
		expect(await pendingCodingResumeNote(env, { userId: "u1", instanceId: "inst-1", sessionId: "s4" }, NOW)).toBeNull();
	});

	it("never briefs a run about itself — the caller's own unfinished row is skipped, and A is still found", async () => {
		// The schema allows one ACTIVE session per repo, so the only unfinished run the repo can hold
		// beside finished history is the caller's own. Its row exists by the time it asks (the run row
		// is opened before the Workflow starts), and it is newer than A.
		session("s2", "repo-r", "active");
		run("run-b", "s2", { startedAt: NOW - MIN, finishedAt: null, stopReason: null });
		const note = await pendingCodingResumeNote(env, { userId: "u1", instanceId: "inst-1", sessionId: "s2" }, NOW);
		expect(note).toContain("used up its step limit");
	});

	it("resolves the caller's repo only within its own tenant — another user's session id briefs nothing", async () => {
		seedTenant(d1, { userId: "u2", instanceIds: [] });
		session("s-foreign", "repo-r", "active", "u2");
		expect(await pendingCodingResumeNote(env, { userId: "u1", instanceId: "inst-1", sessionId: "s-foreign" }, NOW)).toBeNull();
	});

	it("is not told about ANOTHER repo's push that landed inside run A's window (#809)", async () => {
		// Repo O's run pushed on this same instance while run A was working on R. The note used to read
		// the whole instance over A's window and hand that push to R's successor as A's own work —
		// "already done, do NOT do these again", about a repository it never touched.
		session("s-other", "repo-other", "active");
		d1.exec(
			`INSERT INTO agent_events (id, ts, user_id, instance_id, trace_id, source, event, message, context)
			  VALUES ('act-o', ${NOW - 45 * MIN}, 'u1', 'inst-1', 's-other', 'coding', 'act.consequential',
			          'deleted a repository other/repo', ${q(JSON.stringify({ act: "repo.delete", ok: true, irreversible: true, command: "gh repo delete other/repo", sessionId: "s-other" }))})`,
		);
		session("s2", "repo-r", "active");
		const note = await pendingCodingResumeNote(env, { userId: "u1", instanceId: "inst-1", sessionId: "s2" }, NOW);
		expect(note).toContain("pushed directly to the trunk origin main");
		expect(note, "repo O's act reached repo R's resume note — the window is not scoped to run A's session").not.toContain("deleted a repository");
	});

	it("keeps the 6-hour floor — a run A older than the lookback is not a checkpoint", async () => {
		session("s2", "repo-r", "active");
		expect(await pendingCodingResumeNote(env, { userId: "u1", instanceId: "inst-1", sessionId: "s2" }, NOW + 7 * 60 * MIN)).toBeNull();
	});
});

/**
 * The floor a CONTINUE moves, and the rule it does not (#806 item 3(c), item 4).
 *
 * The default six hours is right for an ordinary start, which has no reason to think the last run
 * is related to it. A continue has the one thing that default cannot have: a human looked at a
 * specific stopped run and asked for it. #806 item 4 is explicit that this must work "even hours
 * later", and the test above is what that requirement fails against today.
 */
describe("a CONTINUE reaches further back for its predecessor", () => {
	const NEXT_MORNING = NOW + 14 * 60 * MIN;

	it("briefs a run continued the next morning, which the default floor would not", async () => {
		session("s2", "repo-r", "active");
		const params = { userId: "u1", instanceId: "inst-1", sessionId: "s2" };
		expect(await pendingCodingResumeNote(env, params, NEXT_MORNING), "the default floor should still refuse this").toBeNull();
		const note = await pendingCodingResumeNote(env, { ...params, lookbackMs: CONTINUE_RESUME_LOOKBACK_MS }, NEXT_MORNING);
		expect(note, "the widened lookback never reached the query").not.toBeNull();
		expect(note).toContain("a previous run on this repository used up its step limit");
		expect(note).toContain("pushed directly to the trunk origin main");
	});

	it("widens the SEARCH and nothing else — a verdict in between still ends the note's job", async () => {
		// The rule that makes pinning-to-a-run-id wrong (see `loop-continue-routes.ts`). Run B
		// consumed A's checkpoint and finished; a continue pressed the next morning must not be
		// re-briefed on work that is already on the trunk, however far back it is willing to look.
		session("s2", "repo-r", "ended");
		run("run-b", "s2", { startedAt: NOW - 20 * MIN, finishedAt: NOW - 5 * MIN, stopReason: "done" });
		session("s4", "repo-r", "active");
		const note = await pendingCodingResumeNote(env, { userId: "u1", instanceId: "inst-1", sessionId: "s4", lookbackMs: CONTINUE_RESUME_LOOKBACK_MS }, NEXT_MORNING);
		expect(note).toBeNull();
	});

	it("does not widen it for anyone who did not ask — the default is unchanged", async () => {
		// Byte-for-byte the pre-#806-slice-(ii) behaviour for every ordinary start: the note exists
		// inside six hours and does not exist outside it, with no `lookbackMs` passed at all.
		session("s2", "repo-r", "active");
		const params = { userId: "u1", instanceId: "inst-1", sessionId: "s2" };
		expect(await pendingCodingResumeNote(env, params, NOW)).toContain("used up its step limit");
		expect(await pendingCodingResumeNote(env, params, NOW + 7 * 60 * MIN)).toBeNull();
	});
});

/**
 * The checkpoint the REVIEW surface reads (#806 item 2), against the same real schema.
 *
 * `pendingCodingResumeNote` is now a projection of `pendingCodingResumeCheckpoint`, and that is
 * the property worth holding: the page an owner reads before pressing Continue must describe the
 * briefing the run will actually receive, not a second estimate of it. Two computations of "what
 * carries forward" is how a surface comes to promise work the run then re-does — which is #806's
 * opening complaint, arrived at from the other direction.
 */
describe("the checkpoint behind the note (#806 item 2)", () => {
	it("reports WHICH run the briefing is about, not just the prose", async () => {
		// The fact the note cannot carry and the console cannot derive: an owner looking at run A
		// needs to know whether the briefing is A's.
		session("s2", "repo-r", "active");
		const cp = await pendingCodingResumeCheckpoint(env, { userId: "u1", instanceId: "inst-1", sessionId: "s2" }, NOW);
		expect(cp?.predecessorRunId).toBe("run-a");
		expect(cp?.predecessorSessionId).toBe("s1");
		expect(cp?.endedBy).toBe("max_iterations");
		expect(cp?.landed.map((a) => a.summary)).toEqual(["pushed directly to the trunk origin main"]);
	});

	it("its note is EXACTLY what the projection returns — one computation, not two", async () => {
		session("s2", "repo-r", "active");
		const params = { userId: "u1", instanceId: "inst-1", sessionId: "s2" };
		const cp = await pendingCodingResumeCheckpoint(env, params, NOW);
		expect(cp?.note).toBe(await pendingCodingResumeNote(env, params, NOW));
	});

	it("carries the uncommitted count into its note, the same as the run would be given", async () => {
		// Slice (iii): a dirty tree changes what the note says. The preview reads the tree itself
		// and passes the count here, so the text it shows is the text the run gets.
		session("s2", "repo-r", "active");
		const cp = await pendingCodingResumeCheckpoint(env, { userId: "u1", instanceId: "inst-1", sessionId: "s2", uncommittedFiles: 4 }, NOW);
		expect(cp?.uncommittedFiles).toBe(4);
		expect(cp?.note).toContain("4 uncommitted files");
	});

	it("returns a checkpoint with a NULL note when the predecessor left nothing worth saying", async () => {
		// The state the projection cannot express. Run C is unfinished and resumable but landed
		// nothing, and the tree is clean — so there is no briefing, yet there IS a predecessor.
		// "No predecessor" and "a predecessor that had not done anything yet" are different things
		// for an owner to read, and only the checkpoint can tell them apart.
		repo("repo-quiet");
		session("s-quiet", "repo-quiet", "error");
		run("run-c", "s-quiet", { startedAt: NOW - 50 * MIN, finishedAt: NOW - 40 * MIN, stopReason: "max_iterations" });
		session("s-quiet-2", "repo-quiet", "active");
		const params = { userId: "u1", instanceId: "inst-1", sessionId: "s-quiet-2" };
		const cp = await pendingCodingResumeCheckpoint(env, params, NOW);
		expect(cp, "the row is real — only its note is empty").not.toBeNull();
		expect(cp?.predecessorRunId).toBe("run-c");
		expect(cp?.note).toBeNull();
		expect(await pendingCodingResumeNote(env, params, NOW), "the projection collapses both to null").toBeNull();
	});

	it("is null outright when a verdict run ended the note's job", async () => {
		session("s2", "repo-r", "ended");
		run("run-b", "s2", { startedAt: NOW - 20 * MIN, finishedAt: NOW - 5 * MIN, stopReason: "done" });
		session("s4", "repo-r", "active");
		expect(await pendingCodingResumeCheckpoint(env, { userId: "u1", instanceId: "inst-1", sessionId: "s4" }, NOW)).toBeNull();
	});

	it("honours the continue lookback, so the review surface and the button agree", async () => {
		session("s2", "repo-r", "active");
		const params = { userId: "u1", instanceId: "inst-1", sessionId: "s2" };
		const nextMorning = NOW + 14 * 60 * MIN;
		expect(await pendingCodingResumeCheckpoint(env, params, nextMorning)).toBeNull();
		const cp = await pendingCodingResumeCheckpoint(env, { ...params, lookbackMs: CONTINUE_RESUME_LOOKBACK_MS }, nextMorning);
		expect(cp?.predecessorRunId).toBe("run-a");
	});
});

describe("the stopped Pilot's own notes carry to its successor (#822 → #806)", () => {
	const params = { userId: "u1", instanceId: "inst-1", sessionId: "s2" };

	it("run B is handed what run A's Pilot recorded — read from rows that already exist, oldest first", async () => {
		timeline("s1", "brain", `${LEARNED_PREFIX}Issue wants the retry in relay-client.ts`, NOW - 80 * MIN);
		timeline("s1", "brain", `${LEARNED_PREFIX}Fix written, tests green. Next: rebase and push.`, NOW - 35 * MIN);
		session("s2", "repo-r", "active");
		const cp = await pendingCodingResumeCheckpoint(env, params, NOW);
		expect(cp?.learned).toEqual(["Issue wants the retry in relay-client.ts", "Fix written, tests green. Next: rebase and push."]);
		expect(cp?.note).toContain("- Fix written, tests green. Next: rebase and push.");
		expect(cp?.note).toContain("They are ITS words, not something the platform checked");
	});

	it("a run that landed NOTHING on a clean tree still briefs its successor when it had worked something out", async () => {
		d1.exec("DELETE FROM agent_events");
		session("s2", "repo-r", "active");
		expect(await pendingCodingResumeNote(env, params, NOW)).toBeNull();
		timeline("s1", "brain", `${LEARNED_PREFIX}The flaky test is order-dependent, not a race.`, NOW - 40 * MIN);
		expect(await pendingCodingResumeNote(env, params, NOW)).toContain("- The flaky test is order-dependent, not a race.");
	});

	it("takes only `learned` rows — not the run's other brain rows, and not the engine's output", async () => {
		timeline("s1", "brain", "AI run started — objective: Work through the open issues", NOW - 90 * MIN);
		timeline("s1", "command", `${LEARNED_PREFIX}an instruction that happens to start the same way`, NOW - 50 * MIN);
		timeline("s1", "terminal", `${LEARNED_PREFIX}terminal text`, NOW - 50 * MIN);
		session("s2", "repo-r", "active");
		expect((await pendingCodingResumeCheckpoint(env, params, NOW))?.learned).toEqual([]);
	});

	it("takes only the STOPPED RUN's notes off a session that outlived several runs", async () => {
		// A human-opened session: an earlier run on it reached its verdict, and its notes are not
		// run A's to hand on. Nor is anything written after A stopped.
		timeline("s1", "brain", `${LEARNED_PREFIX}from an earlier run that finished`, NOW - 200 * MIN);
		timeline("s1", "brain", `${LEARNED_PREFIX}run A's own`, NOW - 45 * MIN);
		timeline("s1", "brain", `${LEARNED_PREFIX}written after run A stopped`, NOW - 10 * MIN);
		session("s2", "repo-r", "active");
		expect((await pendingCodingResumeCheckpoint(env, params, NOW))?.learned).toEqual(["run A's own"]);
	});

	it("keeps a note written in the run's FIRST second — the window opens at the second, not after it", async () => {
		// `created_at` has whole-second resolution and the run's start is in milliseconds: a run that
		// started at :00.600 and noted something at :00.800 has a row stamped :00, BEFORE its own start.
		d1.exec(`UPDATE agent_loop_runs SET started_at = ${NOW - 90 * MIN + 600} WHERE run_id = 'run-a'`);
		timeline("s1", "brain", `${LEARNED_PREFIX}the first thing it worked out`, NOW - 90 * MIN + 800);
		session("s2", "repo-r", "active");
		expect((await pendingCodingResumeCheckpoint(env, params, NOW))?.learned).toEqual(["the first thing it worked out"]);
	});

	it("another session's notes are not this predecessor's", async () => {
		session("s9", "repo-other", "error");
		timeline("s9", "brain", `${LEARNED_PREFIX}about a different repository`, NOW - 45 * MIN);
		session("s2", "repo-r", "active");
		expect((await pendingCodingResumeCheckpoint(env, params, NOW))?.learned).toEqual([]);
	});
});
