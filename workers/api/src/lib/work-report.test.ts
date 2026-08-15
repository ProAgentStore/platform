import { describe, expect, it } from "vitest";
import { RUN_HEALTH_LEGEND, RUN_HEALTH_STATES, STALLED_AFTER_MS, describeLoopRun, describeWorkCheck, engineClause, isStalled, recentWorkPrompt, runHealth } from "./work-report.js";
import { statusFor, type LoopRunStatus, type LoopStopReason } from "./agent-loop.js";
import type { LoopRunView } from "./agent-loop-store.js";
import type { TerminalView } from "./terminal-label.js";

const NOW = 1_700_000_000_000;

function run(over: Partial<LoopRunView> = {}): LoopRunView {
	return {
		runId: "run-1",
		instanceId: "inst-1",
		objective: "Run `git pull` in ~/dev/stores/fas/platform",
		status: "completed",
		stopReason: "done",
		detail: "Already up to date on branch main.",
		iteration: 1,
		maxIterations: 10,
		cancelRequested: false,
		budgetId: null,
		startedAt: NOW - 60_000,
		finishedAt: NOW - 30_000,
		lastProgressAt: NOW - 40_000,
		// The default run is HEALTHY: liveness tracks progress and nothing is parked. Every case
		// below that means otherwise says so, which keeps the three states (#580) explicit per case
		// rather than implied by an omission.
		lastAliveAt: NOW - 40_000,
		waitingUntil: null,
		waitingReason: null,
		interruptions: 0,
		delegatedBy: null,
		sessionId: null,
		...over,
	};
}

function tv(kind: TerminalView["kind"]): TerminalView {
	return { kind, text: kind === "live-active" ? "some terminal output" : "" };
}

describe("run times in the owner's zone (#329)", () => {
	it("adds a formatted wall clock beside the relative time when a zone is known", () => {
		// FORMATTED here, not converted by the model: #329's symptom was a Lead reporting "completed
		// at 22:34:19 UTC", which is a different claim from the one its reader hears.
		const s = describeLoopRun(run(), NOW, "Australia/Sydney");
		expect(s).toContain("1m ago");
		expect(s).toMatch(/AE[SD]T|GMT\+1[01]/);
	});

	it("says nothing absolute when the zone is unset — the pre-#329 output, unchanged", () => {
		// Relative times were always safe: they carry no zone, so they cannot be wrong about one. An
		// account that never set a timezone must keep exactly what it had rather than gain a
		// wall-clock in a zone nobody chose.
		expect(describeLoopRun(run(), NOW)).toBe(describeLoopRun(run(), NOW, undefined));
		expect(describeLoopRun(run(), NOW)).not.toMatch(/\d{2}:\d{2}/);
	});

	it("degrades to relative-only rather than failing a turn on an unresolvable zone", () => {
		// A stored zone can outlive the tz database that knew it. Losing the wall clock is a far
		// smaller failure than losing the chat turn it was decorating.
		const s = describeLoopRun(run(), NOW, "Australia/Melbourn");
		expect(s).toContain("1m ago");
	});

	it("reaches both the tool result and the prompt block, so the two agree", () => {
		// `work-report.ts`'s own contract: one rendering serves `check_work` and the automatic recent-
		// work block precisely so they can never tell different stories about one run.
		const zone = "Australia/Sydney";
		expect(describeWorkCheck([run()], NOW, { timeZone: zone })).toMatch(/AE[SD]T|GMT\+1[01]/);
		expect(recentWorkPrompt([run()], NOW, { timeZone: zone })).toMatch(/AE[SD]T|GMT\+1[01]/);
	});
});

describe("describeLoopRun", () => {
	it("states the outcome so a challenged agent can quote it", () => {
		const s = describeLoopRun(run(), NOW);
		expect(s).toContain("run-1");
		expect(s).toContain("completed");
		expect(s).toContain("git pull");
		expect(s).toContain("Already up to date");
		// "step 1/10" until #459 — it read as a progress bar and is a count of instructions sent.
		expect(s).toContain("instruction 1 of up to 10");
		expect(s).not.toMatch(/step \d+\/\d+/);
	});

	it("#459 — a healthy run states that it is NOT stalled, rather than saying nothing", () => {
		// The defect was silence. A live agent read "step 3/50 after 9 minutes" as a stuck progress
		// bar, called a working run stalled, and followed it with "nothing I can do" — with the
		// contradicting evidence in the same sentence. Liveness was only ever stated negatively, so
		// the model had to infer the positive case, and it inferred wrong.
		const s = describeLoopRun(run({ status: "running", finishedAt: null, iteration: 3, maxIterations: 50, startedAt: NOW - 9 * 60_000, lastProgressAt: NOW - 9 * 60_000 }), NOW);
		expect(s).toContain("NOT stalled");
		expect(s).not.toContain("STALLED");
		// The step counter carries how long THIS instruction has been running, so a long step reads
		// as a long step instead of as no progress.
		expect(s).toContain("instruction 3 of up to 50 (this one has been running 9m)");
	});

	it("#459 — the positive claim is about the RUN, never about an engine it cannot see", () => {
		// `lastProgressAt` is the orchestrator's last iteration, not the engine's last output. The
		// live `runState` is behind `/capture` on the coding surface, and this module describes loop
		// runs that may have no engine at all — asserting "engine: working" from this column would
		// replace a false stall with a false all-clear.
		const s = describeLoopRun(run({ status: "running", finishedAt: null, lastProgressAt: NOW - 1000 }), NOW);
		expect(s).not.toMatch(/engine/i);
	});

	/** A run that has neither ticked nor advanced since `ms` ago — the shape of a dead Workflow. */
	const silentFor = (ms: number) => run({ status: "running", finishedAt: null, lastProgressAt: NOW - ms, lastAliveAt: NOW - ms });

	it("#459 — a finished run makes no liveness claim in either direction", () => {
		for (const status of ["completed", "failed", "cancelled"]) {
			const s = describeLoopRun(run({ ...silentFor(STALLED_AFTER_MS + 1), status, finishedAt: NOW - 30_000 }), NOW);
			expect(s, status).not.toContain("stalled");
			expect(s, status).not.toContain("STALLED");
			expect(s, status).not.toContain("has been running");
		}
	});

	it("reports a silent `running` run as STALLED rather than as live work", () => {
		// A Workflow that dies mid-step leaves status='running' forever, so "running" alone is not
		// evidence anything is happening — reporting it as live would be the same over-claim in a
		// new place.
		expect(describeLoopRun(silentFor(STALLED_AFTER_MS + 1), NOW)).toContain("STALLED");
	});

	it("a run that just reported progress is plainly running", () => {
		const s = describeLoopRun(run({ status: "running", finishedAt: null, lastProgressAt: NOW - 1000, lastAliveAt: NOW - 1000 }), NOW);
		expect(s).toContain("running");
		expect(s).not.toContain("STALLED");
	});

	it("#580 — a run mid-instruction is NOT stalled just because the instruction is long", () => {
		// The behaviour change, stated as a case. `lastProgressAt` counts INSTRUCTIONS, and one
		// instruction is a whole engine turn: reading files, editing, running a test suite. Before
		// 0127 that was the only column, so a healthy 20-minute step crossed the 15-minute line and
		// the report told the owner the run had probably died — #459's own incident, re-armed.
		// Liveness is what separates a long step from a dead orchestrator, and only liveness.
		const longStep = run({ status: "running", finishedAt: null, lastProgressAt: NOW - 4 * 60 * 60_000, lastAliveAt: NOW - 30_000 });
		expect(isStalled(longStep, NOW)).toBe(false);
		expect(describeLoopRun(longStep, NOW)).toContain("NOT stalled");
	});

	it("#459 — a run one second under the threshold is NOT stalled; one second over it is", () => {
		// The boundary is the whole claim. `isStalled` is the platform's verdict and the prompt now
		// tells the agent to quote it, so the report and the predicate must never disagree.
		const under = silentFor(STALLED_AFTER_MS - 1000);
		const over = silentFor(STALLED_AFTER_MS + 1000);
		expect(isStalled(under, NOW)).toBe(false);
		expect(describeLoopRun(under, NOW)).toContain("NOT stalled");
		expect(isStalled(over, NOW)).toBe(true);
		expect(describeLoopRun(over, NOW)).toContain("STALLED");
		// The stalled branch must not also carry the reassurance — that would be both verdicts at once.
		expect(describeLoopRun(over, NOW)).not.toContain("NOT stalled");
	});

	it("falls back through progress to startedAt when a run has never ticked", () => {
		// A pre-0127 row has a null `lastAliveAt`, and a run that died before its first tick has one
		// too. Absence must never read as death — it reads as whatever the older columns say.
		const never = (ms: number) => run({ status: "running", lastProgressAt: null, lastAliveAt: null, startedAt: NOW - ms });
		expect(isStalled(never(STALLED_AFTER_MS + 1), NOW)).toBe(true);
		expect(isStalled(never(1000), NOW)).toBe(false);
		// …and through `lastProgressAt` when only THAT was written, which is every in-flight run at
		// the moment 0127 deploys.
		expect(isStalled(run({ status: "running", lastProgressAt: NOW - 1000, lastAliveAt: null }), NOW)).toBe(false);
		expect(isStalled(run({ status: "running", lastProgressAt: NOW - STALLED_AFTER_MS - 1, lastAliveAt: null }), NOW)).toBe(true);
	});

	it("only a running run can be stalled", () => {
		expect(isStalled(run({ status: "completed", lastProgressAt: 0, lastAliveAt: 0 }), NOW)).toBe(false);
	});

	/**
	 * #588 — measured live 2026-08-15: `health` was `"working"` on ALL 89 runs across 7 instances,
	 * including runs that failed days earlier. The intent (a closed run carries no liveness claim)
	 * was right; the enum simply had no member for it, so "no claim" was folded onto the member
	 * that reads as the strongest possible positive claim.
	 *
	 * The denominator is the whole status domain and it is COMPILE-TIME EXHAUSTIVE, per ADR 0002:
	 * a run row holds `"running"` or one of `LoopRunStatus`, and adding a member to either type
	 * fails to typecheck here rather than quietly shrinking what this test measures. That matters
	 * specifically for this bug, which is a missing enum member — a hand-listed set of statuses
	 * would have been written from the same three-member assumption that produced it.
	 */
	describe("#588 — a finished run carries no liveness claim", () => {
		/** Every terminal status a run row can hold, plus the in-flight one. */
		const DOMAIN: Record<LoopRunStatus | "running", true> = {
			running: true,
			completed: true,
			failed: true,
			needs_human: true,
			cancelled: true,
		};
		/** Every stop reason, so the closed set below is derived from `statusFor`, not asserted. */
		const REASONS: Record<LoopStopReason, true> = {
			done: true,
			escalated: true,
			failed: true,
			max_iterations: true,
			budget: true,
			cancelled: true,
			no_progress: true,
			engine_limit: true,
			interrupted: true,
		};
		const statuses = Object.keys(DOMAIN) as Array<LoopRunStatus | "running">;
		const closed = statuses.filter((s) => s !== "running");

		it("measures the whole status domain, and every terminal status is reachable", () => {
			// G1/G2: state the size of the set, and prove the closed half is not an invention —
			// each of these is what `statusFor` returns for at least one real stop reason.
			expect(statuses.length).toBe(5);
			expect(closed.length).toBe(4);
			const reached = new Set((Object.keys(REASONS) as LoopStopReason[]).map((r) => statusFor(r)));
			expect([...reached].sort()).toEqual([...closed].sort());
		});

		it("reports `ended`, never `working`, for every closed status", () => {
			for (const status of closed) {
				// Silent for hours and parked at the moment it closed — `finishLoopRun` does not
				// clear the park columns, so this is the state a real failed run is left in.
				const finished = run({ status, finishedAt: NOW - 3 * 60 * 60_000, lastProgressAt: NOW - 4 * 60 * 60_000, lastAliveAt: NOW - 4 * 60 * 60_000, waitingReason: "engine_limit" });
				expect(runHealth(finished, NOW), `status=${status}`).toBe("ended");
				expect(runHealth(finished, NOW), `status=${status}`).not.toBe("working");
			}
		});

		it("still classifies the three LIVE states, which the 89-run sample never exercised", () => {
			// Stated because the measurement could not: 0 of 89 runs were `running`, so two thirds
			// of the rule was unobserved in production and is confirmed only here.
			expect(runHealth(run({ status: "running", lastProgressAt: NOW - 1000, lastAliveAt: NOW - 1000 }), NOW)).toBe("working");
			expect(runHealth(run({ status: "running", waitingReason: "engine_limit", lastAliveAt: NOW - 1000 }), NOW)).toBe("waiting");
			expect(runHealth(run({ status: "running", lastProgressAt: NOW - STALLED_AFTER_MS - 1, lastAliveAt: NOW - STALLED_AFTER_MS - 1 }), NOW)).toBe("stalled");
		});

		it("says what it does and does not claim, in the payload the model reads", () => {
			// #588 AC2. The legend ships beside the verdict, so a client is not left inferring the
			// inference — every member is named and the engine caveat travels with it.
			//
			// The domain is the ENUM ITSELF, not the hand-written list this assertion shipped with.
			// That list was `["working","waiting","stalled","ended"]` — correct, and unable to notice
			// a fifth member, which is the identical shape as the bug: #588 IS a missing enum member,
			// and a guard whose denominator is retyped from the enum it guards can only ever confirm
			// the members someone remembered.
			//
			// A RUNTIME list, deliberately, and not `Record<RunHealth, true>`. Measured while fixing
			// this: `workers/api/tsconfig.json` and `workers/mcp/tsconfig.json` both carry
			// `exclude: ["src/**\/*.test.ts"]`, and vitest transpiles without typechecking — so NO CI
			// gate typechecks a Worker test, and a compile-time exhaustiveness trick in one of these
			// files is inert. `RUN_HEALTH_STATES` is a value, so this loop actually grows when the
			// enum does. (The `Record<LoopRunStatus | "running", true>` arms above are the inert
			// shape and are left as-is: making them real means turning those unions into const arrays
			// in `agent-loop.ts`, which is a separate change to a much hotter file.)
			expect(RUN_HEALTH_STATES.length, "the domain is empty — the guard has stopped measuring").toBeGreaterThanOrEqual(4);
			for (const member of RUN_HEALTH_STATES) expect(RUN_HEALTH_LEGEND).toContain(`\`${member}\``);
			expect(RUN_HEALTH_LEGEND).toMatch(/engine/i);
		});
	});

	describe("#580 — a parked run is neither working nor stalled, and says which", () => {
		/**
		 * Run 70ea298e, as the record held it: `status:"running"`, `iteration:1/30`, a fresh
		 * timestamp, 4.35 hours after it started, while the engine sat idle on "You've hit your
		 * weekly limit · resets Aug 17 at 4pm".
		 *
		 * Reconstructed with the columns 0127 adds: the heartbeat IS fresh (the five-minute
		 * engine-wait tick was beating), progress is 4.35h stale (nothing advanced), and the park is
		 * now named. Nothing about the run's behaviour was wrong — `coding-wait.ts` permits a
		 * six-hour park — and no field could say so.
		 */
		const reported = run({
			status: "running",
			finishedAt: null,
			stopReason: null,
			detail: null,
			iteration: 1,
			maxIterations: 30,
			startedAt: NOW - 4.35 * 60 * 60_000,
			lastProgressAt: NOW - 4.35 * 60 * 60_000,
			lastAliveAt: NOW - 3.5 * 60_000,
			waitingReason: "engine_limit",
			waitingUntil: NOW + 60 * 60_000,
		});

		it("classifies it as waiting", () => {
			expect(runHealth(reported, NOW)).toBe("waiting");
			expect(isStalled(reported, NOW)).toBe(false);
		});

		it("names what it is waiting for and when it should resume", () => {
			const s = describeLoopRun(reported, NOW);
			expect(s).toContain("PARKED");
			expect(s).toContain("usage limit");
			expect(s).toContain("1h");
		});

		it("does NOT also say 'NOT stalled', which is the all-clear that hid this", () => {
			// Both sentences are true of a parked run, and printing them together is what the owner
			// read as "it is fine and working". The park clause replaces the reassurance.
			expect(describeLoopRun(reported, NOW)).not.toContain("NOT stalled");
		});

		it("a park OUTRANKS a dead heartbeat, so a mid-resume run is not reported as failed", () => {
			// #583: a run interrupted by our own deploy is parked with nothing ticking BY DESIGN
			// while Cloudflare replays its journal. Reading that silence as death would report a
			// recovery in progress as a failure.
			const resuming = run({
				status: "running",
				finishedAt: null,
				lastAliveAt: NOW - 60 * 60_000,
				lastProgressAt: NOW - 60 * 60_000,
				waitingReason: "platform_interrupt",
				waitingUntil: null,
			});
			expect(runHealth(resuming, NOW)).toBe("waiting");
			expect(describeLoopRun(resuming, NOW)).toContain("platform update");
		});

		it("a human handoff is a park too, and says so in the second person", () => {
			const handoff = run({ status: "running", finishedAt: null, waitingReason: "human", waitingUntil: null, lastAliveAt: NOW - 60_000 });
			expect(describeLoopRun(handoff, NOW)).toContain("waiting for YOU");
		});

		it("says nothing about the engine — the caveat this file has always carried", () => {
			// `waitClause` describes the ORCHESTRATOR's own state. The live `runState` is behind
			// `/capture`; claiming it from a run row is the false all-clear facing the other way.
			expect(describeLoopRun(reported, NOW)).not.toMatch(/engine:/i);
		});
	});

	it("surfaces a pending cancel", () => {
		expect(describeLoopRun(run({ status: "running", finishedAt: null, cancelRequested: true, lastProgressAt: NOW }), NOW)).toContain("cancel");
	});
});

describe("describeWorkCheck — the answer to 'did you actually do that?'", () => {
	it("no runs is a real answer, not an error", () => {
		// An error would read as "could not tell", which is the state that produces a guess. This
		// has to be usable to CONTRADICT the agent's own earlier claim.
		const s = describeWorkCheck([], NOW);
		expect(s).toMatch(/have not started any work/);
		expect(s).toMatch(/that was wrong/);
	});

	it("tells the agent not to soften the record", () => {
		const s = describeWorkCheck([run()], NOW);
		expect(s).toContain("Already up to date");
		expect(s).toMatch(/do not soften or retract/);
	});

	it("lists several runs newest-first as given", () => {
		const s = describeWorkCheck([run({ runId: "a" }), run({ runId: "b" })], NOW);
		expect(s.indexOf("a")).toBeLessThan(s.indexOf("b"));
		expect(s).toContain("2 most recent runs");
	});

	// ── #318 ──────────────────────────────────────────────────────────────
	describe("a delegator's work is not on its own instance", () => {
		const delegated = run({ runId: "d1", instanceId: "sub-1", delegatedBy: "lead-1" });

		it("reports delegated runs as work the supervisor started", () => {
			const s = describeWorkCheck([], NOW, { delegated: [delegated] });
			expect(s).toContain("d1");
			// Named with the agent it ran on, so the supervisor can cite both halves of the fact.
			expect(s).toContain("sub-1");
			expect(s).toMatch(/do not soften or retract/);
		});

		it("does NOT accuse a supervisor of misleading the user when it has run nothing itself", () => {
			// The live failure: a Lead that had delegated 90 seconds earlier, and said so truthfully,
			// was told "if you told the user you did something, that was wrong; say so" — and
			// complied. Whether the user was misled is not something this record can see for an
			// agent whose work lives elsewhere.
			const s = describeWorkCheck([], NOW, { supervises: true });
			expect(s).not.toMatch(/that was wrong/);
			expect(s).toMatch(/check_delegation/);
		});

		it("leaves #254's correction exactly as it was for a non-delegator", () => {
			// The guard earns its place there — an agent that ran nothing and claimed it did.
			expect(describeWorkCheck([], NOW, { supervises: false })).toMatch(/that was wrong; say so/);
			expect(describeWorkCheck([], NOW)).toMatch(/that was wrong; say so/);
		});

		it("reports own runs and delegated runs together, separately labelled", () => {
			const s = describeWorkCheck([run({ runId: "own-1" })], NOW, { delegated: [delegated] });
			expect(s).toContain("own-1");
			expect(s).toContain("d1");
			expect(s.indexOf("own-1")).toBeLessThan(s.indexOf("delegating"));
		});
	});
});

// ── #465 — engine liveness in the run report ──────────────────────────────────────────────────

describe("engineClause (#465)", () => {
	it("live-active → working", () => {
		expect(engineClause(tv("live-active"))).toContain("working");
	});

	it("live-idle → idle, not working", () => {
		const c = engineClause(tv("live-idle"));
		expect(c).toContain("idle");
		expect(c).not.toContain("working");
	});

	it("capture-failed → do NOT infer idle or finished", () => {
		const c = engineClause(tv("capture-failed"));
		expect(c).toMatch(/could not be read/i);
		// The wording says "do NOT infer idle or finished" — the word "idle" appears in the
		// negation, which is correct. What must NOT appear is a positive claim of idleness.
		expect(c).toMatch(/do NOT infer/i);
		expect(c).not.toContain("working");
		expect(c).not.toMatch(/engine.*is idle/i);
	});

	it("runner-offline → machine is offline", () => {
		const c = engineClause(tv("runner-offline"));
		expect(c).toMatch(/offline/i);
		expect(c).not.toContain("working");
	});

	it("empty-pane → null (not enough signal)", () => {
		expect(engineClause(tv("empty-pane"))).toBeNull();
	});

	it("none → null", () => {
		expect(engineClause(tv("none"))).toBeNull();
	});

	it("absent → null", () => {
		expect(engineClause(null)).toBeNull();
		expect(engineClause(undefined)).toBeNull();
	});
});

describe("describeLoopRun engine clause (#465)", () => {
	const coding = run({ status: "running", finishedAt: null, sessionId: "sess-1", lastProgressAt: NOW - 1000 });

	it("live-active → 'engine: working' appears in a running coding run", () => {
		const s = describeLoopRun(coding, NOW, undefined, tv("live-active"));
		expect(s).toMatch(/engine.*working/i);
	});

	it("capture-failed → unreadable wording, never a positive idle or working claim", () => {
		const s = describeLoopRun(coding, NOW, undefined, tv("capture-failed"));
		expect(s).toMatch(/could not be read/i);
		// The clause wording says "do NOT infer idle" — the word appears in the negation, not as a
		// positive claim. What must NOT appear is "engine: idle" (the engineClause for live-idle).
		expect(s).not.toMatch(/engine: idle/i);
		expect(s).not.toMatch(/engine.*working/i);
	});

	it("runner-offline → offline wording, never 'working'", () => {
		const s = describeLoopRun(coding, NOW, undefined, tv("runner-offline"));
		expect(s).toMatch(/offline/i);
		expect(s).not.toMatch(/engine.*working/i);
	});

	it("no engineView → no engine clause (non-coding or pending view)", () => {
		// Existing test preserved verbatim: the positive claim must never come from lastProgressAt.
		const s = describeLoopRun(coding, NOW);
		expect(s).not.toMatch(/engine/i);
	});

	it("a completed run renders no engine clause even if a view is passed", () => {
		// The engine is no longer running once the run is done.
		const done = run({ status: "completed", sessionId: "sess-1" });
		const s = describeLoopRun(done, NOW, undefined, tv("live-active"));
		expect(s).not.toMatch(/engine/i);
	});

	it("a non-coding run (no sessionId) renders no engine clause", () => {
		// chat/pipeline driver: sessionId is null, engineView will never be resolved for it.
		const chat = run({ status: "running", finishedAt: null, sessionId: null, lastProgressAt: NOW - 1000 });
		expect(describeLoopRun(chat, NOW)).not.toMatch(/engine/i);
	});
});

describe("describeWorkCheck engine views (#465)", () => {
	it("threads engineViews map into each run description", () => {
		const r = run({ runId: "r1", status: "running", finishedAt: null, sessionId: "sess-1", lastProgressAt: NOW - 1000 });
		const views = new Map([["r1", tv("live-active")]]);
		const s = describeWorkCheck([r], NOW, { engineViews: views });
		expect(s).toMatch(/engine.*working/i);
	});

	it("a missing key in engineViews → no engine clause for that run", () => {
		const r = run({ runId: "r1", status: "running", finishedAt: null, sessionId: "sess-1", lastProgressAt: NOW - 1000 });
		const s = describeWorkCheck([r], NOW, { engineViews: new Map() });
		expect(s).not.toMatch(/engine/i);
	});

	it("capture-failed in engineViews → unreadable wording, never a positive idle claim", () => {
		const r = run({ runId: "r1", status: "running", finishedAt: null, sessionId: "sess-1", lastProgressAt: NOW - 1000 });
		const views = new Map([["r1", tv("capture-failed")]]);
		const s = describeWorkCheck([r], NOW, { engineViews: views });
		expect(s).toMatch(/could not be read/i);
		// "do NOT infer idle" is the correct wording — must not render "engine: idle" as a claim.
		expect(s).not.toMatch(/engine: idle/i);
	});
});

describe("recentWorkPrompt — the context block that removes the tool-call decision", () => {
	it("is empty when there is no work, so a quiet agent's prompt gains nothing", () => {
		expect(recentWorkPrompt([], NOW)).toBe("");
	});

	it("presents the runs as fact and points at check_work for more", () => {
		const p = recentWorkPrompt([run()], NOW);
		expect(p).toContain("## Your recent work");
		expect(p).toContain("check_work");
		expect(p).toContain("git pull");
	});

	it("carries a supervisor's delegations, which are the only work it ever has (#318)", () => {
		// The stronger half of the fix: the Lead in #318 DID call check_work and still recanted, so
		// the answer belongs in the prompt before the challenge arrives.
		const p = recentWorkPrompt([], NOW, { delegated: [run({ runId: "d1", instanceId: "sub-1", delegatedBy: "lead-1" })] });
		expect(p).toContain("## Your recent work");
		expect(p).toContain("d1");
		expect(p).toMatch(/Never deny one of these/);
	});
});
