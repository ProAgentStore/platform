/**
 * A failure class marked `retryable` has a CONSUMER on every driver (#583 AC5).
 *
 * ── The property, and why it is stated over drivers rather than over classes
 *
 * #583's defect was never "the Pilot does not retry". It was that `retryable` was computed,
 * recorded on every death, and read by nobody — a verdict written for a reader that does not exist,
 * with `coding-failure.ts` saying so in a comment on every row it wrote. `03762fd` closed it for one
 * driver and explicitly did not claim the rest, because a cross-driver guard needs a shared
 * classification and there was none.
 *
 * There is one now, and building it turned up the thing the issue could not have known: the
 * classification was NEVER coding-specific. A provider transport failure, a runner that went away, a
 * Cloudflare per-invocation ceiling and an isolate reset are facts about the PLATFORM, and every one
 * of them kills an apply, a browser task, a pipeline or a chat loop identically. Only the first
 * consumer was the Pilot. So the decision function is `driverResumePlan`, not `codingResumePlan`,
 * and `agent-loop.ts` calls it rather than growing a fourth copy of the rule.
 *
 * ── What the sweep found, which is the reason this guard is worth having
 *
 * Five durable drivers. Four consumed the verdict in some form; `agent-loop.ts` consumed NOTHING —
 * its catch turned every death, including our own deploy resetting the isolate, into
 * `stop = { reason: "failed" }`. Its four peers all re-threw and resumed. Nobody had checked,
 * because nobody had asked the question as a SET, which is the same reason `coding-session.ts` sat
 * at zero `logEvent` calls against 6/6/7/3 in its peers until `workflow-trace.test.ts` asked.
 *
 * ── ADR 0002: the denominator is an assertion, not a by-product
 *
 * The driver set is read from `workflows/` on disk, never hand-listed, and a file that is not a
 * driver has to be NAMED with its reason. A rename or a moved directory therefore fails as "this
 * guard has stopped measuring" rather than passing as a clean tree. The consumer each driver is
 * credited with is likewise checked against that file's source, so a registry entry cannot claim a
 * consumer the driver does not reach.
 *
 * ── What this guard does NOT claim
 *
 * That every driver resumes. Three of the five (`job-apply`, `browser-task`, `pipeline-run`) consume
 * the verdict through the narrower `isTransientInfraError` predicate and rethrow UNBOUNDED, because
 * they have no durable run row to count interruptions against — `job-apply` and `browser-task` carry
 * a task id, and `pipeline_runs` has no `interruptions` column. That asymmetry is recorded in
 * {@link CONSUMERS} rather than smoothed over, and bounding them is a migration and a separate
 * decision. What is guarded is that no driver computes this verdict and hands it to nobody.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DRIVER_RESUME_POLICY, MAX_PLATFORM_RESUMES } from "../lib/coding-failure.js";

const DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Files in `workflows/` that are NOT durable drivers, each with the reason it is exempt.
 *
 * Deliberately the same named-list shape, and the same two entries, as `workflow-trace.test.ts`:
 * two guards over the same set must not be able to disagree about what the set IS.
 */
const NOT_A_DRIVER: Record<string, string> = {
	"coding-session-params.ts": "a params type — no run() and no I/O",
	"coding-watch.ts": "a mode of CodingSessionWorkflow, dispatched from its run(); its host owns the catch",
};

interface Consumer {
	/** The symbol in the driver's own source that READS the retryable verdict. */
	reads: string;
	/** What stops an interruption loop, or the reason nothing does. */
	bound: string;
}

/**
 * Who consumes the verdict, per driver — and every `reads` value is checked against that file.
 *
 * A registry alone would be a second hand-maintained list, which is the defect this repo keeps
 * paying for. It is only worth anything because the two arms below make it non-vacuous: the KEYS
 * must equal the drivers found on disk, and each `reads` must appear in the file it names.
 */
const CONSUMERS: Record<string, Consumer> = {
	"coding-session.ts": {
		reads: "driverResumePlan",
		bound: `durable — agent_loop_runs.interruptions, capped at MAX_PLATFORM_RESUMES (${MAX_PLATFORM_RESUMES})`,
	},
	"agent-loop.ts": {
		reads: "driverResumePlan",
		bound: "durable — the same counter; this driver has an agent_loop_runs row, so it can be bounded",
	},
	"job-apply.ts": {
		reads: "isTransientInfraError",
		bound: "UNBOUNDED — no durable run row to count against; it carries a task id (#579)",
	},
	"browser-task.ts": {
		reads: "isTransientInfraError",
		bound: "UNBOUNDED — no durable run row either; it shares job-apply's task-id shape and its apply-loop machinery",
	},
	"pipeline-run.ts": {
		reads: "isTransientInfraError",
		bound: "UNBOUNDED — pipeline_runs has no interruptions column; bounding it is a migration",
	},
};

const files = readdirSync(DIR)
	.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
	.sort();
const drivers = files.filter((f) => !NOT_A_DRIVER[f]);

describe("every driver consumes the retryable verdict", () => {
	it("measures the whole workflows/ directory, and says how much", () => {
		// The denominator. Seven files today, five of them drivers — and the guard fails if it finds
		// fewer, so a split that halves the set reports itself instead of halving the measurement.
		expect(files.length, `workflows/ holds ${files.length} source files`).toBeGreaterThanOrEqual(7);
		expect(drivers.length, `of which ${drivers.length} are durable drivers`).toBeGreaterThanOrEqual(5);
		for (const f of Object.keys(NOT_A_DRIVER)) expect(files, `exemption for a missing file: ${f}`).toContain(f);
	});

	it("the registry covers exactly the drivers on disk — no more, no fewer", () => {
		// Both directions. A driver missing from the registry is the #583 defect returning; a
		// registry entry with no file is a consumer credited to code that no longer exists.
		expect(Object.keys(CONSUMERS).sort(), "registry keys vs workflows/ on disk").toEqual([...drivers].sort());
	});

	it.each(drivers)("%s reaches the consumer the registry credits it with", (file) => {
		// `agent-loop.ts` is the case this was written for: it read NOTHING, and turned a deploy
		// resetting the isolate into a permanently failed run while its four peers resumed.
		const src = readFileSync(join(DIR, file), "utf8");
		const { reads } = CONSUMERS[file];
		const uses = src.split("\n").filter((l) => l.includes(`${reads}(`) && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"));
		expect(uses.length, `${file} never calls ${reads}() — the registry credits it with a consumer it does not reach`).toBeGreaterThan(0);
	});

	it("a driver that resumes without a durable bound has to SAY so", () => {
		// The honest half. Bounding the three unbounded drivers is a migration and a separate
		// decision; what must not happen is the asymmetry going unrecorded, because an unbounded
		// replay is the failure mode #583 AC3 rejected in the same breath as it chose to resume.
		const bounded = drivers.filter((f) => !CONSUMERS[f].bound.startsWith("UNBOUNDED"));
		const unbounded = drivers.filter((f) => CONSUMERS[f].bound.startsWith("UNBOUNDED"));
		expect(bounded.length + unbounded.length, `${drivers.length} drivers, all with a stated bound`).toBe(drivers.length);
		// Every driver that reaches the SHARED decision function is bounded by it, by construction:
		// `driverResumePlan` refuses to resume a run with no loop-run row.
		for (const f of bounded) expect(CONSUMERS[f].reads, `${f} claims a bound without using the bounded path`).toBe("driverResumePlan");
		for (const f of unbounded) expect(CONSUMERS[f].bound.length, `${f} says UNBOUNDED without saying why`).toBeGreaterThan(30);
	});

	it("the shared policy is total, so a new class cannot reach a driver undecided", () => {
		// `coding-resume.test.ts` asserts the table's own denominator; this asserts the LINK — that
		// what the drivers consume is that table and not a per-driver opinion. A class added to the
		// union without a rule fails to compile; this catches the other direction.
		const classes = Object.keys(DRIVER_RESUME_POLICY);
		expect(classes.length, `${classes.length} failure classes, each with a stated resume rule`).toBeGreaterThanOrEqual(11);
		// Two since #758. Asserted as the exact set rather than a count, so a class flipped to
		// `resume: true` somewhere else fails here as well as in `coding-resume.test.ts`.
		expect(classes.filter((c) => DRIVER_RESUME_POLICY[c as keyof typeof DRIVER_RESUME_POLICY].resume).sort()).toEqual([
			"infra_transient",
			"provider_stall",
		]);
	});
});

/**
 * The new consumer has to CONSUME, not merely reference — #518's standard, applied to #583 AC5.
 *
 * A call to `driverResumePlan` whose verdict then falls through to `stop = failed` would satisfy the
 * registry arm above and change nothing, which is exactly the shape #583 is about. `coding-resume.test.ts`
 * pins the Pilot's wiring the same way and for the same reason: the property is about control flow the
 * workflow reaches only inside a Cloudflare Workflow, so it is asserted structurally rather than by
 * inspection — which is how #442 shipped correct and unreachable.
 */
describe("agent-loop's resume is wired, not decorative", () => {
	const src = readFileSync(join(DIR, "agent-loop.ts"), "utf8");

	it("rethrows inside the resume branch — rethrowing IS the resume", () => {
		const branch = src.slice(src.indexOf("if (plan?.resume) {"));
		expect(branch.slice(0, branch.indexOf("}\n\t\t\t// A step that exhausted"))).toContain("throw e;");
	});

	it("the terminal `failed` is unreachable once the branch is taken", () => {
		// Order, not presence: the rethrow must come BEFORE the line that turns the death into a
		// closed, failed run. Reversed, the run would be recorded failed and then resumed anyway.
		expect(src.indexOf("throw e;")).toBeLessThan(src.indexOf('stop = { reason: "failed"'));
	});

	it("the budget settle is skipped while resuming, so one iteration cannot be charged twice", () => {
		// The money half. The `finally`'s settle and the loop's own `settle-${iteration}` are
		// different step ids: settling on the way out and then replaying into an un-journalled
		// `settle-${iteration}` charges the shared tree pool twice for one iteration — worse than
		// the leak the surrounding comment already calls out.
		expect(src).toContain("if (budgetId && outstanding && !resuming) {");
	});

	it("only the resume branch may set `resuming`", () => {
		expect(src.match(/\bresuming = true\b/g) ?? []).toHaveLength(1);
	});
});

/**
 * A driver that RESUMES must not have already filed the run as dead (#546).
 *
 * ── The defect, over the denominator ADR 0002 asks for
 *
 * Both drivers that reach {@link DRIVER_RESUME_POLICY} do the same two things on a death: they write
 * a durable record of it, and they decide whether to replay. The ORDER of those two is the whole
 * property, and the two drivers disagreed about it.
 *
 * `agent-loop.ts` decides first and then records what it decided — `loop.interrupted`, `warn`, "resuming".
 * `coding-session.ts` recorded first: an `error_log` row reading `coding run failed (<class>)`, and
 * only afterwards asked whether to resume. So a run the platform was about to replay had already
 * been filed as a death, and the driver's very next act posted "⏸ Interrupted by a platform update
 * … nothing is needed from you" into the owner's chat. Two durable accounts of one event,
 * disagreeing, with the log the wrong one.
 *
 * Measured: run `b9d9c051` filed `infra_transient` at 00:25:19 and `provider_stall` at 00:28:27 under
 * one `runId`. Only the second ended it. Both rows said "coding run failed", so the owner's
 * `list_errors` view showed a run that died twice — which is the shape #546 named and the shape
 * `03762fd` made ROUTINE by resuming `infra_transient` on purpose.
 *
 * ── Why this is structural
 *
 * Both call sites live inside a Cloudflare Workflow's catch, which vitest cannot construct
 * (`cloudflare:workers` does not resolve). It is the same reason `coding-failure.test.ts`'s #529 arm
 * reads the catch region off disk. What is asserted is ORDER and DISPOSITION, the two things an
 * inspection reliably gets wrong — #442 shipped correct and unreachable by being read rather than run.
 */
describe("no driver files a run as dead before deciding to resume it (#546)", () => {
	/** Derived, never hand-listed: the drivers the registry credits with the SHARED decision. */
	const resuming = Object.keys(CONSUMERS).filter((f) => CONSUMERS[f].reads === "driverResumePlan");

	it("measures both of them — a driver dropping out of this set is the guard going quiet", () => {
		expect(resuming.sort(), "drivers reaching driverResumePlan").toEqual(["agent-loop.ts", "coding-session.ts"]);
	});

	it.each(resuming)("%s asks driverResumePlan BEFORE it writes its terminal account of the run", (file) => {
		const src = readFileSync(join(DIR, file), "utf8");
		// The terminal write differs per driver — one files an error row, the other sets the stop
		// reason the run is closed with — so the marker is named per driver rather than assumed.
		const terminal = file === "coding-session.ts" ? "recordCodingFailure(env, {" : 'stop = { reason: "failed"';
		const decide = src.indexOf("driverResumePlan(");
		expect(decide, `${file} never calls driverResumePlan`).toBeGreaterThan(-1);
		expect(decide, `${file} writes "${terminal}" before it knows whether the run is resumed`).toBeLessThan(src.indexOf(terminal));
	});

	it("the Pilot's record is TOLD which of the two it is, rather than inferring it", () => {
		// Order alone is not enough: deciding first and then writing the same row regardless would
		// satisfy the arm above and change nothing in production. The disposition has to reach the
		// record, and it has to come from the plan — a literal would pass a naive `toContain`.
		const src = readFileSync(join(DIR, "coding-session.ts"), "utf8");
		expect(src).toContain('disposition: plan.resume ? "resumed" : "ended"');
	});

	it("agent-loop's interruption is recorded as an interruption, at warn", () => {
		// The peer that already had this right, pinned so it stays the reference the arm above is
		// measured against. If this driver regresses to filing a death, the property is gone even
		// though the ordering arm would still pass.
		const branch = readFileSync(join(DIR, "agent-loop.ts"), "utf8");
		const resume = branch.slice(branch.indexOf("if (plan?.resume) {"), branch.indexOf('stop = { reason: "failed"'));
		expect(resume).toContain('event: "loop.interrupted"');
		expect(resume).toContain('level: "warn"');
		expect(resume, "an interruption must not be filed as a failure").not.toContain('reason: "failed"');
	});
});
