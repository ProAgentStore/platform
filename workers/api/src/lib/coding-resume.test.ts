/**
 * The `retryable` verdict has a consumer, and every class has a stated decision (#583, #758).
 *
 * The defect was not a missing retry. It was a verdict computed on every death, recorded in every
 * error row, and read by nobody — `coding-failure.ts:364` said so in a comment and treated it as an
 * observation. A test that only proved "infra_transient resumes" would leave the shape of that
 * defect intact for the next class; the denominator assertion is what does not.
 *
 * ── The next class arrived (#758), and the denominator is why this file changed rather than grew
 *
 * `provider_stall` sat at `resume: false` on a reason that was wrong about the MECHANISM — that a
 * resume would "re-drive the engine from where it stood", which describes re-dispatching a run and
 * not replaying a journal. Nine days and at least three killed runs later it was still false. The
 * arms below therefore assert the resuming set as a LIST and assert what the widening must NOT
 * imply, because "one more class resumes" is the shape that quietly becomes "everything resumes".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DRIVER_RESUME_POLICY,
	classifyCodingFailure,
	driverResumePlan,
	MAX_PLATFORM_RESUMES,
	type CodingFailure,
	type CodingFailureClass,
} from "./coding-failure.js";
import { autoResumableRoundOf, isRetryableFailure } from "./resumable-round.js";
import { AI_STALL_TIMEOUT_MS, AI_TOTAL_TIMEOUT_MS, deadlineMessage } from "./ai-deadlines.js";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { Env } from "../types.js";

/** The production message, verbatim from run `b9d9c051`'s `agent_trace` row. */
const DO_RESET = "Durable Object reset because its code was updated.";

/** An env with a real `agent_loop_runs` row, so the interruption bound is counted for real. */
function envWithRun(runId = "run-1") {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at)
		 VALUES ('${runId}', 'u1', 'i1', 'ship it', 'running', 1, 30, 1)`,
	);
	return { env: { DB: d1.DB } as unknown as Env, close: () => d1.close() };
}

describe("every failure class has a stated resume decision — the denominator (ADR 0002)", () => {
	/**
	 * The full union, written out. Duplicating it here is the point: `Record<CodingFailureClass, …>`
	 * already fails to compile on a missing key, but a `as` cast or a widened index signature would
	 * silently reopen the hole, and this list is what a reader diffs the union against.
	 */
	const ALL: CodingFailureClass[] = [
		"runner_gone",
		"runner_unreachable",
		"provider_stall",
		"provider_overrun",
		"provider_credentials",
		"provider_rate_limit",
		"provider_error",
		"platform_ceiling",
		"infra_transient",
		"workflow_internal",
		"unknown",
	];

	it("covers all 11 classes, and each decision carries its reason", () => {
		const keys = Object.keys(DRIVER_RESUME_POLICY).sort();
		expect(keys.length, `policy covers ${keys.length} classes`).toBe(ALL.length);
		expect(keys).toEqual([...ALL].sort());
		for (const cls of ALL) {
			// A boolean with no sentence is how "retryable" became unreadable in the first place.
			expect(DRIVER_RESUME_POLICY[cls].why.length, `${cls} has no stated reason`).toBeGreaterThan(20);
		}
	});

	it("exactly two classes resume, and both replay a journal rather than re-dispatch a run", () => {
		// The denominator, restated as a LIST rather than a count: a class flipped to `resume: true`
		// without a decision recorded here is the thing this arm exists to catch. `provider_stall`
		// joined `infra_transient` in #758 — see the table's entry for the mechanism, and the arm
		// below for the claim it is NOT allowed to imply.
		const resuming = ALL.filter((c) => DRIVER_RESUME_POLICY[c].resume);
		expect(resuming.sort()).toEqual(["infra_transient", "provider_stall"]);
	});

	it("retryable does NOT imply resumable — the two claims the table keeps apart", () => {
		// `workflow_internal` is classified `retryable: true` and must never re-dispatch the run:
		// Cloudflare has already retried the attempt, and a fresh run has no journal, so acts that
		// were already committed — two of the five recorded occurrences had pushed to `origin main` —
		// would repeat. It is the arm that keeps "#758 made stalls resumable" from being read as
		// "retryable now means resumable".
		expect(classifyCodingFailure(new Error("Attempt failed due to internal workflows error")).retryable).toBe(true);
		expect(DRIVER_RESUME_POLICY.workflow_internal.resume).toBe(false);
		// …and the other direction is real too: `provider_rate_limit` and `provider_overrun` are
		// provider failures that are NOT retryable, and widening the stall must not have widened them.
		for (const cls of ["provider_overrun", "provider_credentials", "provider_rate_limit", "provider_error"] as const) {
			expect(DRIVER_RESUME_POLICY[cls].resume, `${cls} must stay terminal`).toBe(false);
		}
	});
});

describe("driverResumePlan — a run cut off by something other than its objective is resumed", () => {
	it("resumes the measured production failure", async () => {
		const { env, close } = envWithRun();
		try {
			const f = classifyCodingFailure(new Error(DO_RESET));
			expect(f.class).toBe("infra_transient");
			expect(f.retryable).toBe(true);
			const plan = await driverResumePlan(env, f, "run-1");
			expect(plan.resume, "a DO reset from a deploy must not end an hours-long run").toBe(true);
			expect(plan.attempts).toBe(1);
		} finally {
			close();
		}
	});

	it("bounds the resumes, and the bound is DURABLE across replays", async () => {
		// The counter has to survive the very mechanism it bounds: the resume works by letting the
		// error escape `run()` so Cloudflare replays the journal, and everything outside `step.do`
		// re-executes on that replay. An in-memory counter would reset on each interruption and
		// never reach its own limit.
		const { env, close } = envWithRun();
		try {
			const f = classifyCodingFailure(new Error(DO_RESET));
			for (let i = 1; i <= MAX_PLATFORM_RESUMES; i++) {
				const p = await driverResumePlan(env, f, "run-1");
				expect(p.resume, `interruption ${i} of ${MAX_PLATFORM_RESUMES}`).toBe(true);
				expect(p.attempts).toBe(i);
			}
			const past = await driverResumePlan(env, f, "run-1");
			expect(past.resume).toBe(false);
			expect(past.why).toContain("defect");
		} finally {
			close();
		}
	});

	it("refuses to resume what it cannot bound", async () => {
		// A run with no loop-run row cannot be counted. Terminating is the honest failure; an
		// unbounded replay is the worse one.
		const { env, close } = envWithRun();
		try {
			const plan = await driverResumePlan(env, classifyCodingFailure(new Error(DO_RESET)), null);
			expect(plan.resume).toBe(false);
			expect(plan.why).toContain("bounded");
		} finally {
			close();
		}
	});

	it("resumes the mid-reply transport drop that killed run 16d3defd at iteration 1 (#758)", async () => {
		// The production sentence, composed by the function that raises it rather than retyped — so a
		// reworded deadline fails this test instead of silently making the fix unreachable. This is the
		// message #758 quotes: the platform TELLS the owner to send it again and then did not.
		const { env, close } = envWithRun();
		try {
			const stall = new Error(deadlineMessage("stall", AI_STALL_TIMEOUT_MS));
			const f = classifyCodingFailure(stall);
			expect(f.class).toBe("provider_stall");
			expect(f.retryable, "the site that knows says a retry could work").toBe(true);
			const plan = await driverResumePlan(env, f, "run-1");
			expect(plan.resume, "a dropped socket must not be the end of a run that was working").toBe(true);
			expect(plan.attempts).toBe(1);
			// The reason names the MECHANISM, because the entry it replaces was wrong about exactly
			// that: it said a retry would re-drive the engine, which describes re-dispatching a run.
			expect(plan.why).toContain("journal");
		} finally {
			close();
		}
	});

	it("bounds a stall on the SAME durable counter a deploy uses — three replays total, not three each", async () => {
		// One counter for both classes, deliberately (see MAX_PLATFORM_RESUMES). Per-class budgets
		// would let three deploys plus three drops replay one run six times.
		const { env, close } = envWithRun();
		try {
			const deploy = classifyCodingFailure(new Error(DO_RESET));
			const stall = classifyCodingFailure(new Error(deadlineMessage("stall", AI_STALL_TIMEOUT_MS)));
			expect((await driverResumePlan(env, deploy, "run-1")).attempts).toBe(1);
			expect((await driverResumePlan(env, stall, "run-1")).attempts).toBe(2);
			expect((await driverResumePlan(env, stall, "run-1")).resume).toBe(true);
			const past = await driverResumePlan(env, stall, "run-1");
			expect(past.resume, `past ${MAX_PLATFORM_RESUMES} interruptions this is a defect, not weather`).toBe(false);
			expect(past.why).toContain("defect");
		} finally {
			close();
		}
	});

	it("does not resume the deadline that is DETERMINISTIC — an overrun repeats identically", async () => {
		// The boundary the widening must not cross. Both are `ai-deadlines.ts` sentences and both are
		// provider failures; only one of them can be fixed by trying again, and its own message says so.
		const { env, close } = envWithRun();
		try {
			const overrun = classifyCodingFailure(new Error(deadlineMessage("total", AI_TOTAL_TIMEOUT_MS)));
			expect(overrun.class).toBe("provider_overrun");
			expect((await driverResumePlan(env, overrun, "run-1")).resume).toBe(false);
		} finally {
			close();
		}
	});

	it("does not resume an unclassifiable death", async () => {
		const { env, close } = envWithRun();
		try {
			expect((await driverResumePlan(env, null, "run-1")).resume).toBe(false);
		} finally {
			close();
		}
	});

	it("an infra class marked NOT retryable still does not resume", async () => {
		// Belt and braces, and it is the rule rather than the belt: the gate is the shared predicate,
		// so a future classifier that stops marking this retryable stops the resume with it.
		const { env, close } = envWithRun();
		try {
			const f: CodingFailure = { class: "infra_transient", retryable: false, upstreamStatus: null };
			const plan = await driverResumePlan(env, f, "run-1");
			expect(plan.resume).toBe(false);
			expect(plan.why).toContain("not marked retryable");
		} finally {
			close();
		}
	});
});

describe("the Pilot CONSUMES the verdict — the property #518 was written to prove", () => {
	/**
	 * Read as source, deliberately, and the limitation is stated rather than hidden.
	 *
	 * #518 made consumption provable by writing `thinkWithAutoResume` as a function OVER `think`,
	 * *"because the property worth proving is that the stored round is consumed, and a branch inside
	 * a DO method can only be proved by inspection — which is how #442 shipped correct and
	 * unreachable"*. The same argument applies here and the same trick does not: the Pilot's resume
	 * is not a wrapper around a call, it is the ABSENCE of a teardown and the presence of a rethrow
	 * inside a Cloudflare Workflow's own try/finally. There is no seam to inject.
	 *
	 * So the decision was extracted instead — `driverResumePlan` is unit-tested above against real
	 * rows — and what remains in the workflow is three structural facts. These assertions are what
	 * stops #442's failure mode: a correct decision that nothing reaches. `probe-outside-steps` in
	 * `coding-failure.test.ts` guards its invariant the same way and for the same reason.
	 */
	const workflow = readFileSync(fileURLToPath(new URL("../workflows/coding-session.ts", import.meta.url).href), "utf8");

	it("rethrows on a resume, so Cloudflare replays the journal", () => {
		const branch = workflow.slice(workflow.indexOf("if (plan.resume) {"));
		expect(branch.slice(0, branch.indexOf("\n\t\t\t}"))).toContain("throw e;");
	});

	it("skips the whole teardown while resuming, so the run is not torn down under the replay", () => {
		// The one that matters most. Without it the `finally` ends the session, releases the driver
		// claim, closes the board card and posts "**Loop stopped**" — and the replay then carries on
		// working inside a run every surface has already reported as failed.
		expect(workflow).toContain("if (!resuming) {");
		const teardown = workflow.slice(workflow.indexOf("if (!resuming) {"));
		for (const terminal of ["repo-state-end", "acts-final-drain", 'step.do("end"', "notify-end", "closeDelegation(result)"]) {
			expect(teardown, `${terminal} must sit inside the !resuming guard`).toContain(terminal);
		}
		// …and nothing terminal sits BEFORE the guard, which is what the containment above assumes.
		const before = workflow.slice(0, workflow.indexOf("if (!resuming) {"));
		expect(before).not.toContain("closeDelegation(result)");
	});

	it("only the resume branch may set `resuming`", () => {
		// A second writer would decouple "we decided to replay" from "we skipped the teardown",
		// which is the pair this whole mechanism rests on.
		expect(workflow.match(/\bresuming = true\b/g) ?? []).toHaveLength(1);
	});

	it("marks the run as WAITING while it is being replayed", () => {
		// A replay has nothing ticking by design. Without this the run looks silent, and `isStalled`
		// would report a recovery in progress as a death — the false stall #459 is about.
		const branch = workflow.slice(workflow.indexOf("if (plan.resume) {"));
		expect(branch.slice(0, branch.indexOf("\n\t\t\t}"))).toContain('reason: "platform_interrupt"');
	});
});

describe("one retryable rule, two drivers", () => {
	it("the chat path and the Pilot gate on the SAME predicate", () => {
		// #583 AC2 asks for `autoResumableRoundOf` rather than a second rule. Literally reusing it on
		// the Pilot is a no-op — it requires a stored `ResumableRound` that only `runAgentThink`
		// attaches, which is why every Pilot failure records `resumableRound: false`. What generalises
		// is the predicate, and this asserts both readers see one implementation of it.
		const withRound = Object.assign(new Error("stall"), {
			retryable: true,
			resumableRound: { prompt: "p", savedAt: Date.now(), roundsUsed: 1, executed: [], mutations: 0, executedTools: ["t"], toolLog: [], messages: [{ role: "assistant", content: "x" }] },
		});
		expect(autoResumableRoundOf(withRound)).not.toBeNull();
		expect(isRetryableFailure(withRound)).toBe(true);

		// The Pilot's carrier is the CLASSIFICATION, not the error — a DO reset arrives as a plain
		// message with no structural fields at all, and `classifyCodingFailure` is the site that
		// knows. The same predicate reads both.
		const plainReset = new Error(DO_RESET);
		expect(isRetryableFailure(plainReset), "the raw error carries no verdict").toBe(false);
		expect(isRetryableFailure(classifyCodingFailure(plainReset)), "the classification does").toBe(true);
		expect(autoResumableRoundOf(plainReset), "and it has no round to resume from").toBeNull();
	});
});
