/**
 * The Pilot's run, RUN (#915).
 *
 * The invariants below used to be "guard tests" that read `workflow-run.ts` as text and asserted it
 * contained particular lines. They said nothing about whether the run behaved, and #912's file move
 * turned ~30 of them red without a single behavioural change. Each is now stated as what the run
 * DOES: the real `runCodingSessionWorkflow`, over the real D1 schema, with only its two edges faked —
 * the machine (`runner-client`) and the BYOK brain (`decideCodingAction`). Every test names the
 * issue whose invariant it carries.
 *
 * The workflow `step` is a faithful in-memory journal: `do` runs a callback once and records its
 * result, `sleep` records and resolves. Passing a journal from an earlier run REPLAYS it the way
 * Cloudflare does — a journalled step returns its recorded value and its callback never runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callRunner, decideCodingAction } = vi.hoisted(() => ({ callRunner: vi.fn(), decideCodingAction: vi.fn() }));
vi.mock("../../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/runner-client.js")>("../../lib/runner-client.js");
	const conn = { kind: "relay", instanceId: "i1", runnerNode: "n1", relayName: "i1:node:n1" };
	return {
		...actual,
		callRunner: (...a: unknown[]) => callRunner(...a),
		getRunnerConnIgnoringLiveness: async () => conn,
		getBoundRunnerConn: async () => conn,
		relayConnected: async () => true,
	};
});
vi.mock("../../lib/coding-loop.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/coding-loop.js")>("../../lib/coding-loop.js");
	return { ...actual, decideCodingAction: (...a: unknown[]) => decideCodingAction(...a) };
});

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { runCodingSessionWorkflow } from "./workflow-run.js";
import type { CodingSessionParams } from "../coding-session-params.js";
import type { CodingDecision, CodingGoal } from "../../lib/coding-loop.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../lib/d1-sqlite.js";
import type { Env } from "../../types.js";

// ── The harness ─────────────────────────────────────────────────────────────────────────────────

interface Journal {
	done: Map<string, unknown>;
	order: string[];
	sleeps: { name: string; ms: number }[];
	/** Called as each sleep starts — a test's window onto what the run looks like while it waits. */
	onSleep?: (name: string, ms: number) => void;
}
const newJournal = (): Journal => ({ done: new Map(), order: [], sleeps: [] });

function fakeStep(journal: Journal): WorkflowStep {
	const step = {
		async do(name: string, a: unknown, b?: unknown) {
			const cb = (typeof a === "function" ? a : b) as () => Promise<unknown>;
			if (journal.done.has(name)) return journal.done.get(name);
			journal.order.push(name);
			const value = await cb();
			journal.done.set(name, value);
			return value;
		},
		async sleep(name: string, ms: number) {
			journal.sleeps.push({ name, ms });
			journal.onSleep?.(name, ms);
		},
	};
	return step as unknown as WorkflowStep;
}

/** What the machine answers. Each test overrides only the paths it is about. */
type RunnerRoute = (body: Record<string, unknown>) => unknown;
let runner: Record<string, RunnerRoute>;
let runnerCalls: { path: string; body: Record<string, unknown> }[];
const IDLE = { pane: "$ ", runState: "idle", ready: true, alive: true };
const IN_SYNC = { checked: true, branch: "main", upstream: "origin/main", localHead: "aaaaaaaa1", remoteHead: "aaaaaaaa1", ahead: 0, behind: 0, fetched: true };

/** The brain: one scripted decision per call, the last repeated. */
let decisions: CodingDecision[];
let decided: { goal: CodingGoal }[];

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'owner/repo', '/w/repo', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude')`);
	env = { DB: d1.DB } as unknown as Env;
	runnerCalls = [];
	runner = {
		"/coding/start": () => ({ ok: true, sessionId: "s1" }),
		"/coding/capture": () => IDLE,
		"/coding/act": () => IDLE,
		// A clean checkout, level with its upstream — the state a run is allowed to start from.
		"/coding/git": () => ({ output: "## main...origin/main\n" }),
		"/coding/sync": () => IN_SYNC,
	};
	callRunner.mockReset();
	callRunner.mockImplementation(async (_conn: unknown, path: string, body: Record<string, unknown> = {}) => {
		runnerCalls.push({ path, body });
		const route = runner[path];
		return route ? route(body) : {};
	});
	decisions = [{ finish: { status: "done", detail: "all green" } }];
	decided = [];
	decideCodingAction.mockReset();
	decideCodingAction.mockImplementation(async (_env: unknown, _uid: unknown, p: { goal: CodingGoal }) => {
		decided.push({ goal: structuredClone(p.goal) });
		return decisions.length > 1 ? decisions.shift() : decisions[0];
	});
});
afterEach(() => d1.close());

function params(over: Partial<CodingSessionParams> = {}, goal: Partial<CodingGoal> = {}): CodingSessionParams {
	return {
		instanceId: "i1",
		userId: "u1",
		sessionId: "s1",
		repoId: "r1",
		runnerNode: "n1",
		goal: { objective: "make the tests pass", repo: "owner/repo", clientType: "claude", ...goal },
		...over,
	} as CodingSessionParams;
}

async function run(p: CodingSessionParams = params(), journal: Journal = newJournal()) {
	const result = await runCodingSessionWorkflow(env, { payload: p } as WorkflowEvent<CodingSessionParams>, fakeStep(journal));
	return { result, journal };
}

const rows = <T>(sql: string) => d1.sqlite.prepare(sql).all() as T[];

const one = <T>(sql: string) => d1.sqlite.prepare(sql).get() as T;

/** The board card the session owns (#553), as the previous run left it. */
function seedCard(status = "failed") {
	d1.exec(`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
	  VALUES ('csess-s1', 'i1', 'u1', 'coding', '${status}', '{"status":"${status}"}', datetime('now'), datetime('now'))`);
}
const cardStatus = () => one<{ status: string }>("SELECT status FROM instance_runtime_tasks WHERE id = 'csess-s1'").status;

/** The loop-run row a delegated/owner-started run is opened with before the workflow starts. */
function seedLoopRun(runId = "run-1") {
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id)
	  VALUES ('${runId}', 'u1', 'i1', 'make the tests pass', 'running', 10, ${Date.now()}, 's1')`);
}
const loopRun = (runId = "run-1") =>
	one<{ status: string; stop_reason: string | null; detail: string | null; last_alive_at: number | null; waiting_reason: string | null; waiting_until: number | null }>(
		`SELECT status, stop_reason, detail, last_alive_at, waiting_reason, waiting_until FROM agent_loop_runs WHERE run_id = '${runId}'`,
	);
const timeline = () => rows<{ type: string; content: string }>("SELECT type, content FROM coding_timeline WHERE session_id = 's1' ORDER BY seq");
const errors = () =>
	rows<{ message: string; context: string }>("SELECT message, context FROM error_log WHERE source = 'coding:session' ORDER BY id").map((r) => ({
		message: r.message,
		context: JSON.parse(r.context) as Record<string, unknown>,
	}));
const events = (event: string) => rows<{ message: string; context: string | null }>(`SELECT message, context FROM agent_events WHERE event = '${event}'`);

/** A handoff the owner answers on the first poll. */
function ownerAnswers(value?: string) {
	runner["/coding/takeover-status"] = () => ({ resolved: true, value });
}

const DO_RESET = "Durable Object reset because its code was updated.";

// ── The tests ───────────────────────────────────────────────────────────────────────────────────

describe("the harness runs the real workflow", () => {
	it("starts the engine, asks the brain, and ends done", async () => {
		const { result, journal } = await run();
		expect(result).toMatchObject({ outcome: "done" });
		expect(runnerCalls.map((c) => c.path)).toContain("/coding/start");
		expect(decided).toHaveLength(1);
		expect(journal.order).toContain("end");
	});
});

describe("the Pilot moves its card at all three points of a run (#553)", () => {
	it("claims the card at the start, so a second run on one session is not born Failed", async () => {
		seedCard("failed");
		let atFirstDecision = "";
		decideCodingAction.mockImplementationOnce(async () => {
			atFirstDecision = cardStatus();
			return { finish: { status: "done", detail: "ok" } };
		});
		await run();
		expect(atFirstDecision).toBe("running");
	});

	it("is in Needs you while the run waits on the owner, and back to running once answered", async () => {
		seedCard("running");
		const seen: string[] = [];
		runner["/coding/takeover-status"] = () => {
			seen.push(cardStatus());
			return { resolved: true };
		};
		decisions = [{ stuck: { why: "a captcha" } }, { finish: { status: "done", detail: "ok" } }];
		decideCodingAction.mockImplementation(async () => {
			seen.push(cardStatus());
			return decisions.length > 1 ? decisions.shift() : decisions[0];
		});
		await run();
		expect(seen).toEqual(["running", "needs_human", "running"]);
	});

	it("writes the run's verdict at the end — also when a HUMAN opened the session, which the run does not end", async () => {
		seedCard("running");
		decisions = [{ finish: { status: "failed", detail: "tests still red" } }];
		await run(params({ sessionOpenedByRun: false, driverId: "drv-1" }));
		expect(cardStatus()).toBe("failed");
		expect(one<{ status: string }>("SELECT status FROM coding_sessions WHERE id = 's1'").status).toBe("active");
	});

	it("gives the delegation card the same status as the run's own card and loop-run row", async () => {
		seedCard("running");
		seedLoopRun();
		d1.exec(`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
		  VALUES ('task-1', 'i1', 'u1', 'delegation', 'running', '{}', datetime('now'), datetime('now'))`);
		decisions = [{ stuck: { why: "needs a decision" } }];
		runner["/coding/takeover-status"] = () => ({ resolved: false });
		await run(params({ loopRunId: "run-1", boardTaskId: "task-1" }));
		const task = one<{ status: string }>("SELECT status FROM instance_runtime_tasks WHERE id = 'task-1'").status;
		expect(task).toBe("needs_human");
		expect(cardStatus()).toBe("needs_human");
		expect(loopRun().stop_reason).toBe("escalated");
	});
});

describe("the owner-turn counter the report stamp reads (#505)", () => {
	const CLAIM = "Bumped the version per explicit user instruction.";

	it("stamps a report that speaks for an owner who never spoke", async () => {
		seedLoopRun();
		decisions = [{ finish: { status: "done", detail: CLAIM } }];
		await run(params({ loopRunId: "run-1" }));
		expect(loopRun().detail).toContain("You sent no message to this run");
	});

	it("counts an answered handoff, so the next round sees it and the report is left alone", async () => {
		seedLoopRun();
		ownerAnswers("424242");
		decisions = [{ needsInput: { field: "otp", why: "2FA" } }, { finish: { status: "done", detail: CLAIM } }];
		await run(params({ loopRunId: "run-1" }));
		expect(decided[1].goal).toMatchObject({ ownerTurns: 1, userHint: "otp: 424242" });
		expect(loopRun().detail).toContain(CLAIM);
		expect(loopRun().detail).not.toContain("You sent no message");
	});
});

describe("a crash is recorded, diagnosably, and the run still ends (#529, #546)", () => {
	it("files the failure with where it was, how far it got, and when it started — and tears down", async () => {
		seedCard("running");
		seedLoopRun();
		decisions = [{ action: { kind: "message", text: "run the tests" } }];
		let calls = 0;
		decideCodingAction.mockImplementation(async (_e: unknown, _u: unknown, p: { goal: CodingGoal }) => {
			decided.push({ goal: p.goal });
			if (++calls === 2) throw new Error("brain exploded");
			return decisions[0];
		});
		const { result, journal } = await run(params({ loopRunId: "run-1" }));
		expect(result.outcome).toBe("failed");
		const [row] = errors();
		expect(row.context).toMatchObject({ disposition: "ended", sessionId: "s1", runId: "run-1", steps: 1 });
		// The probe names the step it died in — the decide step, by its journal name.
		expect(String(row.context.phase)).toMatch(/^s\d+-decide$/);
		expect(journal.done.has(String(row.context.phase)), "the step it died in recorded no result").toBe(false);
		expect(typeof row.context.elapsedMs).toBe("number");
		// …and the teardown still ran.
		for (const s of ["repo-state-end", "repo-sync-end", "acts-final-drain", "end", "notify-end"]) expect(journal.order).toContain(s);
		expect(loopRun().status).not.toBe("running");
	});

	it("re-measures a journalled pane on REPLAY, and still knows the instruction it drove", async () => {
		// The defect: the probe measured inside the snapshot callback, which a replay never runs, so a
		// resumed attempt filed `paneChars: 0` — "it died on an empty pane".
		const BIG = "x".repeat(4_096);
		runner["/coding/capture"] = () => ({ ...IDLE, pane: BIG });
		runner["/coding/act"] = () => ({ ...IDLE, pane: BIG });
		const crashOnCall = (n: number) => {
			let calls = 0;
			decideCodingAction.mockImplementation(async () => {
				if (++calls === n) throw new Error("brain exploded");
				return { action: { kind: "message", text: "run the tests" } };
			});
		};
		crashOnCall(2);
		const { journal } = await run();
		// Replay: every journalled step returns its record, and the machine now shows an empty pane.
		runner["/coding/capture"] = () => ({ ...IDLE, pane: "" });
		runner["/coding/act"] = () => ({ ...IDLE, pane: "" });
		// The first decision is journalled, so the first LIVE one is the decide that died.
		crashOnCall(1);
		await run(params(), journal);
		// The same death of the same run collapses into one row; the attempt that just died is its
		// `last_context`.
		const row = one<{ repeat_count: number; last_context: string }>("SELECT repeat_count, last_context FROM error_log WHERE source = 'coding:session'");
		expect(row.repeat_count).toBe(2);
		const replayed = JSON.parse(row.last_context) as Record<string, unknown>;
		expect(replayed.paneChars).toBe(4_096);
		expect(replayed.instructionChars).toBe("run the tests".length);
	});
});

describe("a platform interruption is resumed in the workflow, not rethrown (#855, #546)", () => {
	it("records it as resumed, parks with the instant it retries, sleeps durably, and runs the round again", async () => {
		seedLoopRun();
		let calls = 0;
		decideCodingAction.mockImplementation(async () => {
			if (++calls === 1) throw new Error(DO_RESET);
			return { finish: { status: "done", detail: "ok" } };
		});
		const journal = newJournal();
		let parked: ReturnType<typeof loopRun> | null = null;
		journal.onSleep = (name) => {
			if (!/waitidle/.test(name)) parked ??= loopRun();
		};
		const { result } = await run(params({ loopRunId: "run-1" }), journal);
		expect(result.outcome).toBe("done");
		expect(errors().map((e) => e.context.disposition)).toEqual(["resumed"]);
		expect(journal.order).toContain("interrupt-1");
		// The park while it backs off: a SCHEDULED resume, stating when — not "being resumed" with
		// nothing behind it.
		expect(parked).toMatchObject({ waiting_reason: "platform_interrupt" });
		expect(parked!.waiting_until).toBeGreaterThan(Date.now() - 1_000);
	});

	it("does not count an interruption twice when its bookkeeping step is replayed", async () => {
		seedLoopRun();
		let calls = 0;
		decideCodingAction.mockImplementation(async () => {
			if (++calls === 1) throw new Error(DO_RESET);
			return { finish: { status: "done", detail: "ok" } };
		});
		const { journal } = await run(params({ loopRunId: "run-1" }));
		const before = errors().length;
		// Replay the whole run from its journal: the decide that threw is re-run, but `interrupt-1` is not.
		calls = 0;
		journal.done.delete("end");
		await run(params({ loopRunId: "run-1" }), journal);
		expect(errors().length).toBe(before);
	});
});

describe("the resume note reaches the brain (#523, #806)", () => {
	const predecessor = (finishedAgoMs: number) => {
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status) VALUES ('s0', 'i1', 'r1', 'u1', 'error')`);
		const end = Date.now() - finishedAgoMs;
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id)
		  VALUES ('run-0', 'u1', 'i1', 'earlier', 'failed', 'max_iterations', 10, ${end - 60_000}, ${end}, 's0')`);
		const ctx = JSON.stringify({ act: "push.trunk", ok: true, irreversible: true, command: "git push origin main", sessionId: "s0" });
		d1.exec(`INSERT INTO agent_events (id, ts, user_id, instance_id, trace_id, source, event, message, context)
		  VALUES ('act-0', ${end - 30_000}, 'u1', 'i1', 'run-0', 'coding', 'act.consequential', 'pushed directly to the trunk origin main', '${ctx}')`);
	};

	it("puts the predecessor's note on goal.resumeNote for the FIRST decision only, and on the timeline", async () => {
		predecessor(30 * 60_000);
		decisions = [{ stuck: { why: "check" } }, { finish: { status: "done", detail: "ok" } }];
		ownerAnswers();
		await run();
		expect(decided[0].goal.resumeNote).toContain("pushed directly to the trunk origin main");
		// Platform voice, never the owner's.
		expect(decided[0].goal.userHint).toBeUndefined();
		// Cleared after round 0.
		expect(decided[1].goal.resumeNote).toBeUndefined();
		expect(timeline().some((t) => t.type === "brain" && t.content.includes("pushed directly to the trunk origin main"))).toBe(true);
	});

	it("honours the run's own lookback, so a CONTINUE reaches a predecessor older than the default window", async () => {
		predecessor(8 * 60 * 60_000);
		await run();
		expect(decided[0].goal.resumeNote).toBeUndefined();
		decided = [];
		await run(params({ resumeLookbackMs: 24 * 60 * 60_000 }));
		expect(decided[0].goal.resumeNote).toContain("used up its step limit");
	});

	it("counts the tree the run STARTS on, and tells a repair run nothing about it", async () => {
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status) VALUES ('s0', 'i1', 'r1', 'u1', 'error')`);
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id)
		  VALUES ('run-0', 'u1', 'i1', 'earlier', 'failed', 'max_iterations', 10, ${Date.now() - 120_000}, ${Date.now() - 60_000}, 's0')`);
		runner["/coding/git"] = () => ({ output: "## main...origin/main\n M a.ts\n M b.ts\n?? c.ts\n" });
		await run();
		expect(decided[0].goal.resumeNote).toContain("3 uncommitted files");
		decided = [];
		await run(params({}, { repairCheckout: true }));
		expect(decided[0].goal.resumeNote ?? "").not.toContain("uncommitted files");
	});
});

describe("the sync gate: a run on an unconfirmed base never reaches the loop (#801, #802, #804)", () => {
	it("stops the run before the first decision, without throwing, and says so on every surface", async () => {
		seedLoopRun();
		runner["/coding/sync"] = () => ({ checked: false, error: "not a git repository" });
		const { result } = await run(params({ loopRunId: "run-1" }));
		expect(decided).toHaveLength(0);
		expect(result).toMatchObject({ outcome: "failed", steps: 0 });
		expect(result.detail).toContain("could not be confirmed");
		expect(errors()).toEqual([]); // a refusal, not a crash
		expect(timeline().some((t) => t.content.includes("could not be confirmed"))).toBe(true);
		expect(events("coding.run.blocked")).toHaveLength(1);
	});

	it("fast-forwards a clean checkout that is behind, gates on the RE-READ, and tells the owner with the undo", async () => {
		let synced = 0;
		runner["/coding/sync"] = () => (synced++ === 0 ? { ...IN_SYNC, behind: 2, remoteHead: "bbbbbbbb2" } : { ...IN_SYNC, localHead: "bbbbbbbb2", remoteHead: "bbbbbbbb2" });
		runner["/coding/fast-forward"] = () => ({ ok: true, from: "aaaaaaaa1", to: "bbbbbbbb2", commits: 2 });
		const { result } = await run();
		expect(result.outcome).toBe("done");
		expect(decided).toHaveLength(1);
		expect(events("coding.run.self_heal")).toHaveLength(1);
	});

	it("gives a repair run the platform's brief INSTEAD of its objective, and lets it through the gate", async () => {
		runner["/coding/sync"] = () => ({ ...IN_SYNC, ahead: 1, behind: 3 });
		await run(params({}, { repairCheckout: true, objective: "owner note" }));
		expect(decided).toHaveLength(1);
		expect(decided[0].goal.objective).not.toBe("owner note");
		expect(decided[0].goal.specialInstructions ?? "").not.toContain("UPSTREAM SYNC");
	});
});

describe("the run's lifecycle is on the trace and its report derives from its stop reason (#580, #523)", () => {
	it("records a start and an end, so a run that never crashed is still accounted for", async () => {
		await run();
		expect(events("coding.run.start")).toHaveLength(1);
		expect(events("coding.run.end")).toHaveLength(1);
	});

	it("finishes the loop-run row with the reason its outcome word is derived from — an interruption never reads `failed`", async () => {
		// The placeholder every death carries is `outcome: "failed"`; an interrupted run's card leading
		// with it is how a platform restart read as the objective failing. Interrupted past the resume
		// bound, the run ends — and the row and the report must say the same thing about why.
		seedLoopRun();
		decideCodingAction.mockImplementation(async () => {
			throw new Error(DO_RESET);
		});
		await run(params({ loopRunId: "run-1" }));
		const row = loopRun();
		expect(row.stop_reason).toBe("interrupted");
		expect(row.detail ?? "").toMatch(/^outcome: interrupted\b/);
	});
});

describe("the idle wait (#814)", () => {
	const continueOnce = () => {
		decisions = [{ action: { kind: "message", text: "go" } }, { finish: { status: "done", detail: "ok" } }];
	};

	it("takes durable steps by default, and one step when the flag is off — with the SAME step names after it", async () => {
		continueOnce();
		const durable = await run();
		expect(durable.journal.order.some((n) => /-waitidle-c0$/.test(n))).toBe(true);
		expect(durable.journal.sleeps.some((s) => /-waitidle-z/.test(s.name))).toBe(true);

		continueOnce();
		decided = [];
		(env as unknown as { CODING_IDLE_DURABLE: string }).CODING_IDLE_DURABLE = "0";
		const oneStep = await run();
		expect(oneStep.journal.order.some((n) => /^s\d+-waitidle$/.test(n))).toBe(true);
		// The counter does not depend on which wait ran: every later step lines up.
		const later = (j: Journal) => j.order.filter((n) => /^s\d+-(decide|snapshot|act|event)$/.test(n));
		expect(later(oneStep.journal)).toEqual(later(durable.journal));
	});
});

describe("every turn the Pilot sends is composed through the turn replay (#693)", () => {
	it("carries the platform's record to an engine with no memory of its own", async () => {
		d1.exec(`UPDATE coding_sessions SET client_type = 'grok' WHERE id = 's1'`);
		d1.exec(`INSERT INTO coding_timeline (session_id, instance_id, user_id, type, content, created_at) VALUES ('s1', 'i1', 'u1', 'command', 'EARLIER-INSTRUCTION', datetime('now'))`);
		decisions = [{ action: { kind: "message", text: "go on" } }, { finish: { status: "done", detail: "ok" } }];
		await run(params({}, { clientType: "grok" }));
		const act = runnerCalls.find((c) => c.path === "/coding/act");
		expect(JSON.stringify(act?.body)).toContain("EARLIER-INSTRUCTION");
	});
});

describe("liveness: a working run clears its park, a waiting one states when it ends (#580, #591)", () => {
	it("a capturing run is alive and parked on nothing — WHILE it works, not only once it ends", async () => {
		seedLoopRun();
		// A stale park from an earlier wait: capturing again means the run is no longer waiting.
		d1.exec(`UPDATE agent_loop_runs SET waiting_reason = 'human', waiting_until = ${Date.now() + 60_000} WHERE run_id = 'run-1'`);
		let atDecision: ReturnType<typeof loopRun> | null = null;
		decideCodingAction.mockImplementationOnce(async () => {
			atDecision = loopRun();
			return { finish: { status: "done", detail: "ok" } };
		});
		await run(params({ loopRunId: "run-1" }));
		expect(atDecision).toMatchObject({ waiting_reason: null, waiting_until: null });
		expect(atDecision!.last_alive_at).not.toBeNull();
	});

	it("a run waiting on the owner parks with a reason AND an until", async () => {
		seedLoopRun();
		let parked: { waiting_reason: string | null; waiting_until: number | null } | null = null;
		runner["/coding/takeover-status"] = () => {
			parked = loopRun();
			return { resolved: true };
		};
		decisions = [{ stuck: { why: "captcha" } }, { finish: { status: "done", detail: "ok" } }];
		await run(params({ loopRunId: "run-1" }));
		expect(parked).toMatchObject({ waiting_reason: "human" });
		expect(parked!.waiting_until).toBeGreaterThan(Date.now());
	});
});
