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
import { pendingCodingResumeNote } from "./coding-resume-note.js";
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

function pushAct(id: string, ts: number, user = "u1") {
	const context = JSON.stringify({ act: "push.trunk", ok: true, irreversible: true, command: "git push origin main" });
	d1.exec(
		`INSERT INTO agent_events (id, ts, user_id, instance_id, trace_id, source, event, message, context)
		  VALUES (${q(id)}, ${ts}, ${q(user)}, 'inst-1', 'sess', 'coding', 'act.consequential', 'pushed directly to the trunk origin main', ${q(context)})`,
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
	pushAct("act-1", NOW - 60 * MIN);
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

	it("keeps the 6-hour floor — a run A older than the lookback is not a checkpoint", async () => {
		session("s2", "repo-r", "active");
		expect(await pendingCodingResumeNote(env, { userId: "u1", instanceId: "inst-1", sessionId: "s2" }, NOW + 7 * 60 * MIN)).toBeNull();
	});
});
