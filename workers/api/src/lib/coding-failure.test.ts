import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionLostMessage, deadlineMessage } from "./ai-deadlines.js";
import { classifyCodingFailure, CodingRunProbe, codingFailureLevel, recordCodingFailure, splitCfReference } from "./coding-failure.js";
import { RunnerGoneError, RunnerUnreachableError } from "./runner-unreachable.js";
import type { Env } from "../types.js";

// `logError` takes a 2% probabilistic DELETE branch and its trace mirror takes a 1% one. Pin the
// draw so nothing in this file rides on a coin toss (the same reason error-log.test.ts does).
beforeEach(() => {
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
	vi.restoreAllMocks();
});

function mockDb() {
	const inserts: { sql: string; args: unknown[] }[] = [];
	const db = {
		prepare(sql: string) {
			return {
				run: async () => ({}),
				bind(...args: unknown[]) {
					return {
						// No `meta.changes`, so the collapse UPDATE reports nothing absorbed and the
						// INSERT below is reached — which is what these assertions read.
						run: async () => {
							if (sql.startsWith("INSERT")) inserts.push({ sql, args });
							return {};
						},
						all: async () => ({ results: [] }),
						first: async () => null,
					};
				},
			};
		},
	};
	return { env: { DB: db } as unknown as Env, inserts };
}

/**
 * A failure that has crossed a Cloudflare Workflow step boundary.
 *
 * The engine hands the receiving side a MESSAGE, not a prototype — so every classification that
 * matters has to survive with nothing but the string. Each provider case below is asserted twice:
 * once on the rich error, once through this.
 */
const serialized = (err: Error) => new Error(err.message);

describe("classifyCodingFailure — the three classes that used to read identically (#529)", () => {
	it("reads the platform's own deadline sentences, and keeps reading them", () => {
		// Fed the REAL output of ai-deadlines.ts rather than a copy of its wording: reword a message
		// there and this fails, instead of silently degrading every future stall to `unknown`.
		for (const kind of ["first-token", "stall"] as const) {
			const err = new Error(deadlineMessage(kind, 20_000));
			expect(classifyCodingFailure(err).class, kind).toBe("provider_stall");
			expect(classifyCodingFailure(serialized(err)).class, `${kind} (serialized)`).toBe("provider_stall");
		}
		// The one deterministic deadline: too LONG, so an identical retry ends identically.
		const overrun = classifyCodingFailure(new Error(deadlineMessage("total", 180_000)));
		expect(overrun.class).toBe("provider_overrun");
		expect(overrun.retryable).toBe(false);
		expect(classifyCodingFailure(new Error(connectionLostMessage())).class).toBe("provider_stall");
	});

	it("separates an exhausted balance from a stall — the question nobody could answer", () => {
		// The live pair, verbatim: a `credit balance is too low` 400 at 07:07 and a `20s of silence`
		// stall at 07:18, on one instance, reported identically. They are not the same failure and
		// they do not have the same remedy.
		const credit = Object.assign(new Error("Anthropic (400): Your credit balance is too low to access the API."), {
			upstreamStatus: 400,
			retryable: false,
		});
		expect(classifyCodingFailure(credit).class).toBe("provider_credentials");
		expect(classifyCodingFailure(serialized(credit)).class).toBe("provider_credentials");
		expect(classifyCodingFailure(credit).retryable).toBe(false);

		const stall = Object.assign(new Error(deadlineMessage("stall", 20_000)), { retryable: true });
		expect(classifyCodingFailure(stall).class).toBe("provider_stall");
		expect(classifyCodingFailure(stall).retryable).toBe(true);
	});

	it("names an invalid key, a throttled one, and a platform ceiling", () => {
		const key = new Error("Anthropic (401): invalid x-api-key — Invalid API key. Update it in Profile → API Keys");
		expect(classifyCodingFailure(key).class).toBe("provider_credentials");
		expect(classifyCodingFailure(new Error("Anthropic (429): rate_limit_error")).class).toBe("provider_rate_limit");
		expect(classifyCodingFailure(new Error("Add an API key in Profile → API Keys (Anthropic or Cloudflare Workers AI).")).class).toBe(
			"provider_credentials",
		);
		// #523's run: two hours of real work cut off by a per-invocation limit, reported as the
		// objective failing with a link to Cloudflare's docs.
		expect(
			classifyCodingFailure(
				new Error(
					"Too many API requests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits",
				),
			).class,
		).toBe("platform_ceiling");
		expect(classifyCodingFailure(new Error("Worker exceeded CPU time limit")).class).toBe("platform_ceiling");
	});

	it("keeps the runner classes the guard already established (#341)", () => {
		expect(classifyCodingFailure(new RunnerGoneError("waited 10 minutes; the machine did not come back")).class).toBe("runner_gone");
		expect(classifyCodingFailure(new RunnerGoneError("gone")).retryable).toBe(false);
		expect(classifyCodingFailure(new RunnerUnreachableError("the relay has no live socket")).class).toBe("runner_unreachable");
		// The marker survives serialisation even though the prototype does not.
		expect(classifyCodingFailure(new Error("relay refused: the relay has no live socket")).class).toBe("runner_unreachable");
	});

	it("does not count a deploy resetting an isolate as a bug", () => {
		const reset = classifyCodingFailure(new Error("Durable Object reset because its code was updated"));
		expect(reset.class).toBe("infra_transient");
		expect(codingFailureLevel(reset.class)).toBe("warn");
	});

	it("classifies a truncated stream, and leaves a genuine unknown as unknown", () => {
		const stream = Object.assign(new Error("Anthropic: the reply ended mid-stream, so it is not the whole answer"), { retryable: true });
		expect(classifyCodingFailure(stream).class).toBe("provider_stall");
		// An unclassified death stays `error` level — the whole point is that it gets looked at.
		const junk = classifyCodingFailure(new Error("Cannot read properties of undefined (reading 'pane')"));
		expect(junk.class).toBe("unknown");
		expect(junk.retryable).toBeNull();
		expect(codingFailureLevel("unknown")).toBe("error");
	});

	it("is total — a string, null and undefined are inputs, not crashes", () => {
		for (const junk of [null, undefined, "boom", 7, {}]) {
			expect(() => classifyCodingFailure(junk)).not.toThrow();
			expect(classifyCodingFailure(junk).class).toBe("unknown");
		}
	});
});

describe("recordCodingFailure — the durable record itself", () => {
	const probe = () => {
		const p = new CodingRunProbe();
		p.at("s7-decide");
		p.saw("x".repeat(5_800));
		p.drove("read the full contents of both files");
		return p;
	};

	it("writes one error_log row carrying the class, the step and the payload sizes", async () => {
		const { env, inserts } = mockDb();
		const failure = await recordCodingFailure(env, {
			err: Object.assign(new Error(deadlineMessage("stall", 20_000)), { retryable: true }),
			userId: "u1",
			instanceId: "f8ddc272",
			sessionId: "csess_1",
			disposition: "ended",
			repo: "heartfull",
			node: "RLs-MacBook-Air.local",
			runId: "run_9",
			taskId: null,
			steps: 4,
			probe: probe(),
			startedAt: Date.now() - 61_000,
		});
		expect(failure.class).toBe("provider_stall");

		const row = inserts.find((i) => i.sql.includes("error_log"));
		expect(row, "no error_log row was written").toBeDefined();
		const [, userId, source, , message, context, level] = row!.args;
		expect(userId).toBe("u1");
		// Filterable in `list_errors`; the trace bridge splits at the colon, so agent_trace files it
		// under `coding` beside the acts of the same run.
		expect(source).toBe("coding:session");
		expect(level).toBe("error");
		// The run token (first 8 chars of runId) appears between "coding run" and the verb (#612).
		expect(message).toContain("run_9 failed (provider_stall) at s7-decide after 4 steps");
		const ctx = JSON.parse(context as string);
		expect(ctx.failureClass).toBe("provider_stall");
		expect(ctx.retryable).toBe(true);
		// Correlation: run id, session id, trace id (AC 3).
		expect(ctx.traceId).toBe("run_9");
		expect(ctx.runId).toBe("run_9");
		expect(ctx.sessionId).toBe("csess_1");
		expect(ctx.instanceId).toBe("f8ddc272");
		// Enough to diagnose the failure rather than its existence: where it was, and how big the
		// thing it was carrying (AC 2 + the payload question the three live deaths could not answer).
		expect(ctx.phase).toBe("s7-decide");
		expect(ctx.steps).toBe(4);
		expect(ctx.instructionChars).toBe("read the full contents of both files".length);
		expect(ctx.paneChars).toBe(5_800);
		expect(ctx.elapsedMs).toBeGreaterThanOrEqual(61_000);
		expect(ctx.node).toBe("RLs-MacBook-Air.local");
		// The Pilot has no auto-resume (#518 is chat-only) — recorded, so that stays an observation.
		expect(ctx.resumableRound).toBe(false);
	});

	it("writes events and lastEvent when the error carries stream state (#734)", async () => {
		// AC 5: a stall that carries eventsSeen + lastEventType (set by readAnthropicStream) must
		// write events + lastEvent into context so a reader can tell whether the silence began before
		// or after real content had arrived.
		const { env, inserts } = mockDb();
		const err = Object.assign(new Error(deadlineMessage("stall", 20_000)), {
			retryable: true,
			eventsSeen: 3,
			lastEventType: "content_block_delta",
		});
		await recordCodingFailure(env, {
			err,
			userId: "u2",
			instanceId: "inst-1",
			sessionId: "csess_3",
			disposition: "ended",
			repo: null,
			node: null,
			runId: null,
			taskId: null,
			steps: 0,
			probe: probe(),
			startedAt: Date.now() - 1_000,
		});
		const row = inserts.find((i) => i.sql.includes("error_log"));
		expect(row, "no error_log row").toBeDefined();
		const [, , , , , context] = row!.args;
		const ctx = JSON.parse(context as string);
		expect(ctx.events).toBe(3);
		expect(ctx.lastEvent).toBe("content_block_delta");
	});

	it("omits events and lastEvent for non-deadline failures (#734)", async () => {
		// A runner-gone error carries no stream state — the context must not have those keys at all
		// so they don't pollute unrelated rows with always-null fields.
		const { env, inserts } = mockDb();
		await recordCodingFailure(env, {
			err: new (await import("./runner-unreachable.js").then((m) => m.RunnerGoneError))("gone"),
			userId: "u3",
			instanceId: "inst-2",
			sessionId: "csess_4",
			disposition: "ended",
			repo: null,
			node: null,
			runId: null,
			taskId: null,
			steps: 0,
			probe: probe(),
			startedAt: Date.now(),
		});
		const row = inserts.find((i) => i.sql.includes("error_log"));
		expect(row, "no error_log row").toBeDefined();
		const [, , , , , context] = row!.args;
		const ctx = JSON.parse(context as string);
		expect(ctx.events).toBeUndefined();
		expect(ctx.lastEvent).toBeUndefined();
	});

	it("falls back to the session id as the trace key when no loop run started it", async () => {
		const { env, inserts } = mockDb();
		// A chat-initiated `start_work` carries no loopRunId and no board card. It still has to be
		// findable, or the exact run this ticket was filed about would still be unreadable.
		await recordCodingFailure(env, {
			err: new RunnerGoneError("the machine did not come back"),
			userId: "u1",
			instanceId: "i1",
			sessionId: "csess_2",
			disposition: "ended",
			steps: 0,
			probe: new CodingRunProbe(),
			startedAt: Date.now(),
		});
		const row = inserts.find((i) => i.sql.includes("error_log"))!;
		const ctx = JSON.parse(row.args[5] as string);
		expect(ctx.traceId).toBe("csess_2");
		expect(ctx.runId).toBeNull();
		// A machine that went offline is EXPLAINED, so it is recorded without being counted a bug.
		expect(row.args[6]).toBe("warn");
	});

	it("mirrors into the unified trace, so /trace?trace_id= joins the death to its run", async () => {
		const { env, inserts } = mockDb();
		await recordCodingFailure(env, {
			err: new Error("boom"),
			userId: "u1",
			instanceId: "i1",
			sessionId: "csess_3",
			disposition: "ended",
			runId: "run_3",
			steps: 1,
			probe: new CodingRunProbe(),
			startedAt: Date.now(),
		});
		const trace = inserts.find((i) => i.sql.includes("agent_events"));
		expect(trace, "no agent_events mirror row").toBeDefined();
		// (id, ts, user_id, instance_id, trace_id, source, …)
		expect(trace!.args[3]).toBe("i1");
		expect(trace!.args[4]).toBe("run_3");
		expect(trace!.args[5]).toBe("coding");
	});

	it("never throws — it runs on a path that is already failing", async () => {
		// Spy so the `[error-log] failed to persist: …` line is captured as a positive assertion
		// rather than printed as noise — the same technique on-error.test.ts uses.
		const errors: unknown[][] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
		try {
			const env = {
				DB: {
					prepare() {
						throw new Error("db down");
					},
				},
			} as unknown as Env;
			await expect(
				recordCodingFailure(env, {
					err: new Error("boom"),
					userId: "u1",
					instanceId: "i1",
					sessionId: "s1",
					disposition: "ended",
					steps: 0,
					probe: new CodingRunProbe(),
					startedAt: Date.now(),
				}),
			).resolves.toMatchObject({ class: "unknown" });
			expect(errors.some((a) => String(a[0]).includes("failed to persist"))).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("the CODING_SESSION throw path writes it (#529 AC 4)", () => {
	const source = readFileSync(join(__dirname, "../workflows/coding-session.ts"), "utf8");

	it("records the failure inside the catch block, not only on the happy path", () => {
		// The measurement the ticket was filed on was `grep -c logError … → 0` while every peer
		// workflow had 3-5. Asserted over the SOURCE because the workflow class cannot be
		// constructed here — it imports `cloudflare:workers`, which vitest does not resolve — and a
		// test that only exercised `recordCodingFailure` would prove the writer works while the
		// crash path still called nobody, which is exactly the state this ticket describes.
		const region = /\}\s*catch\s*\(e\)\s*\{([\s\S]*?)\n\t\t\} finally \{/.exec(source);
		expect(region, "the run's try/catch/finally shape changed — re-check this guard").not.toBeNull();
		expect(region![1]).toContain("recordCodingFailure(env, {");
		// The four fields that make a record diagnosable rather than merely present.
		for (const field of ["probe", "steps: pilotSteps", "sessionId", "startedAt: runStartedAt"]) {
			expect(region![1], `catch block does not pass ${field}`).toContain(field);
		}
	});

	it("names the step it is about to run, so a death reports where it happened", () => {
		// `probe.at(name)` returns the name, so the step wrapper is the single place this is
		// recorded — every guarded runner call and the decide step go through it.
		expect(source).toContain("(step.do as unknown as LooseDo)(probe.at(name), opts, fn)");
		// Assembled rather than written out: a literal `${…}` inside a plain string trips
		// `noTemplateCurlyInString`, and the placeholder is the part that has to match.
		expect(source).toContain(["step.do(probe.at(`s$", "{n++}-decide`)"].join(""));
	});
});

describe("WorkflowInternalError — the largest live class, and it was `unknown` (#546)", () => {
	// The two wordings, verbatim from production. The first is what five `agent_loop_runs.detail`
	// rows carry (a step exhausting its retries); the second is what three post-#529 `error_log`
	// rows carry (the runtime's own error, at phase `s6-decide`, on instance a1d3522f). Both are
	// the same event through different surfaces, and a reworded Cloudflare message must fail HERE
	// rather than silently degrade the class back to `unknown`.
	const PRODUCTION_WORDINGS = [
		"WorkflowInternalError: Attempt failed due to internal workflows error",
		"internal error; reference = 4f2c8a1b9de04c6fa1e2b3c4d5e6f708",
	];

	it("classifies both wordings, as `warn`, and says which retry it means", () => {
		expect(PRODUCTION_WORDINGS.length, "the population this class was measured on").toBe(2);
		for (const wording of PRODUCTION_WORDINGS) {
			const f = classifyCodingFailure(new Error(wording));
			expect(f.class, wording).toBe("workflow_internal");
			// TRUE of the ATTEMPT — which Cloudflare has already retried, journalled, on its own.
			// It is not a licence to re-dispatch the run; see the branch comment for why.
			expect(f.retryable, wording).toBe(true);
			// Explained, so it stops being counted as an unexplained bug. It only earns that
			// because `splitCfReference` makes it countable — see the collapse test below.
			expect(codingFailureLevel(f.class), wording).toBe("warn");
		}
	});

	it("is not read from `unknown` any more — which is the measurement the ticket was filed on", () => {
		// Before this, 3 of the 4 `coding:session` rows that existed since #529 were this, and all
		// three fell through to `at("unknown")`. Re-deleting the branch turns this red.
		for (const wording of PRODUCTION_WORDINGS) {
			expect(classifyCodingFailure(new Error(wording)).class).not.toBe("unknown");
		}
		// …and a genuine unknown is still unknown, so the class did not simply swallow the bucket.
		expect(classifyCodingFailure(new Error("Cannot read properties of undefined")).class).toBe("unknown");
	});

	/**
	 * The three references Cloudflare has ACTUALLY emitted, read off the production rows that carry
	 * one: 2026-08-12 15:05:34 and 15:13:35 (run `82739cb6`) and 2026-08-15 08:37:34 (`32d09ed1`).
	 *
	 * The first version of this test invented `aaaa1111bbbb2222` to match a `[0-9a-f-]` regex it was
	 * testing, so it confirmed the pattern instead of measuring it. Every real handle below has a
	 * letter past `f`, none of the three ever matched, and a sweep of all 124 rows in the error log
	 * found `cfReference` in the context of exactly zero of them. A fixture drawn from the code it
	 * tests can only agree with it.
	 */
	const PRODUCTION_REFERENCES = ["ta78s8dpekde3apmplf351m0", "hknsjlipbemc1fi7lsn13vak", "v5t1f9uth3ba0so067pi9qq5"];

	it("reads the reference Cloudflare emits, which is base36 and not hex", () => {
		// The arm the shipped version failed. Stated as a property of the DATA — a handle with a
		// letter past `f` — so a regex narrowed back to hex fails here rather than in production.
		expect(PRODUCTION_REFERENCES.every((r) => /[g-z]/.test(r)), "no fixture exercises the non-hex case").toBe(true);
		for (const ref of PRODUCTION_REFERENCES) {
			const split = splitCfReference(`internal error; reference = ${ref}`);
			expect(split.reference, ref).toBe(ref);
			expect(split.message, ref).not.toContain(ref);
		}
	});

	it("collapses two occurrences whose only difference is Cloudflare's reference id", () => {
		// AC 3. `collapseRepeat` keys on the exact message, so a per-occurrence `reference = <id>`
		// made every row unique and all three production rows read `repeat_count: 1` — the repeat
		// machinery #522/#538 built was inert for the one class that most needed a count.
		const [refA, refB] = PRODUCTION_REFERENCES;
		const a = splitCfReference(`internal error; reference = ${refA}`);
		const b = splitCfReference(`internal error; reference = ${refB}`);
		expect(a.message).toBe(b.message);
		expect(a.reference).toBe(refA);
		expect(b.reference).toBe(refB);
		// Every OTHER message is untouched, which is what keeps the collapse lossless for them.
		for (const other of ["run error: boom", "Anthropic (400): Your credit balance is too low", ""]) {
			expect(splitCfReference(other)).toEqual({ message: other, reference: null });
		}
	});

	it("carries the reference into the row's context, so moving it out of the headline loses nothing", async () => {
		const { env, inserts } = mockDb();
		await recordCodingFailure(env, {
			// The literal message from run `82739cb6`'s first row, reference and all.
			err: new Error("internal error; reference = ta78s8dpekde3apmplf351m0"),
			userId: "u1",
			instanceId: "a1d3522f",
			sessionId: "csess_2dd3124c",
			disposition: "ended",
			runId: "82739cb6",
			steps: 6,
			probe: new CodingRunProbe(),
			startedAt: Date.now(),
		});
		const row = inserts.find((i) => i.sql.includes("error_log"))!;
		expect(row.args[4], "the reference must not stay in the collapse key").not.toContain("ta78s8dp");
		const ctx = JSON.parse(row.args[5] as string);
		expect(ctx.cfReference).toBe("ta78s8dpekde3apmplf351m0");
		expect(ctx.failureClass).toBe("workflow_internal");
		// `warn`, because it is explained — and countable, because of the two lines above.
		expect(row.args[6]).toBe("warn");
	});

	it("adds no key at all when there is no reference to carry", async () => {
		const { env, inserts } = mockDb();
		await recordCodingFailure(env, {
			err: new Error("WorkflowInternalError: Attempt failed due to internal workflows error"),
			userId: "u1",
			instanceId: "i1",
			sessionId: "csess_1",
			disposition: "ended",
			steps: 0,
			probe: new CodingRunProbe(),
			startedAt: Date.now(),
		});
		const ctx = JSON.parse(inserts.find((i) => i.sql.includes("error_log"))!.args[5] as string);
		expect("cfReference" in ctx).toBe(false);
	});
});

/**
 * One run, one DEATH — the half of #546 that survived `c64d9f5` (#546).
 *
 * `c64d9f5` classified `workflow_internal` and stopped calling an interruption a failed objective in
 * the OWNER's sentence. It left the durable record alone, and then `03762fd` (#583) made the problem
 * routine rather than occasional: an `infra_transient` death is now resumed on purpose, so a run that
 * is interrupted and later dies writes two rows that read identically. Production run `b9d9c051` is
 * that shape — `infra_transient` 00:25:20, `provider_stall` 00:28:27, one `runId`.
 *
 * The rows are told apart by what the platform DID, which only the caller knows. So the test is over
 * the two dispositions, and the property is that the death row is unchanged while the interruption
 * row stops claiming the run failed.
 */
describe("a resumed interruption is not filed as a death (#546)", () => {
	/** The message CF hands the catch when our own deploy resets the isolate. `resume: true`. */
	const DO_RESET = "Durable Object reset because its code was updated.";

	const record = async (disposition: "resumed" | "ended", err = new Error(DO_RESET)) => {
		const { env, inserts } = mockDb();
		await recordCodingFailure(env, {
			err,
			userId: "u1",
			instanceId: "a1d3522f",
			sessionId: "csess_2dd3124c",
			disposition,
			runId: "b9d9c051",
			steps: 6,
			probe: new CodingRunProbe(),
			startedAt: Date.now() - 61_000,
		});
		const row = inserts.find((i) => i.sql.includes("error_log"))!;
		return { message: row.args[4] as string, level: row.args[6], ctx: JSON.parse(row.args[5] as string) };
	};

	it("says INTERRUPTED, not failed, when the run was resumed past it", async () => {
		const { message, ctx } = await record("resumed");
		// The word is the whole point. `coding-session.ts` posts "⏸ Interrupted by a platform
		// update … nothing is needed from you" into the chat three lines after writing this row;
		// before this the row said the run failed, so the two durable surfaces of one event
		// contradicted each other and the owner's `list_errors` view was the one that was wrong.
		// The run token sits between "coding run" and the verb (#612 — keeps rows per-run distinct).
		expect(message).toContain("b9d9c051 interrupted (infra_transient)");
		expect(message, "an interruption must not read as a death").not.toContain(" failed ");
		// …and it says what happened NEXT, which is the fact that makes the row countable.
		expect(message).toContain("resumed");
		expect(ctx.disposition).toBe("resumed");
	});

	it("keeps the death row exactly as it was, so the class that ends a run is unchanged", async () => {
		const { message, ctx } = await record("ended", new Error(deadlineMessage("stall", 20_000)));
		expect(message).toContain("b9d9c051 failed (provider_stall) at start after 6 steps");
		expect(ctx.disposition).toBe("ended");
	});

	it("counts one death across the pair of rows one interrupted run writes", async () => {
		// The property stated over the production sequence rather than over one row: `b9d9c051` files
		// an interruption and then a death, and a reader counting deaths must get 1. This is what
		// "one run, one death" means operationally — the rows are both kept (#529), and exactly one
		// of them claims the run ended.
		const rows = [await record("resumed"), await record("ended", new Error(deadlineMessage("stall", 20_000)))];
		expect(rows.filter((r) => r.ctx.disposition === "ended")).toHaveLength(1);
		expect(rows.filter((r) => r.message.includes(" failed "))).toHaveLength(1);
	});

	it("never files a row the platform is actively recovering from as an `error`", async () => {
		// `infra_transient` is already `warn` by class, so today this is belt-and-braces — and that is
		// precisely why it is asserted. `DRIVER_RESUME_POLICY` is a table someone will add a resumable
		// class to, and the next one need not be in EXPLAINED. A run being resumed is explained BY the
		// resume, whatever its class says.
		const { level } = await record("resumed", new Error("something nobody has classified"));
		expect(classifyCodingFailure(new Error("something nobody has classified")).class).toBe("unknown");
		expect(level, "a resumed interruption is explained by the resume itself").toBe("warn");
	});
});

/**
 * One run-death → one row, even when CF retries the Workflow attempt (#612).
 *
 * The double-file shape: run `82739cb6` filed two `error_log` rows for the SAME death, 8 minutes
 * apart, because `recordCodingFailure` lives outside `step.do` and Cloudflare replayed the
 * Workflow instance, executing the catch block on every attempt.
 *
 * The fix: the collapse-key message now includes a per-run token (first 8 chars of `runId ??
 * sessionId`). Two attempts of the SAME run produce identical tokens → identical messages → the
 * second row is absorbed by `collapseRepeat` into `repeat_count: 2`. Deaths from DIFFERENT runs
 * produce different tokens → different messages → they stay distinct rows and never cross-collapse.
 */
describe("per-run token keeps retried deaths as one row and distinct runs as separate rows (#612)", () => {
	const base = {
		err: new Error("internal error; reference = ta78s8dpekde3apmplf351m0"),
		userId: "u1",
		instanceId: "a1d3522f",
		sessionId: "csess_2dd3124c",
		disposition: "ended" as const,
		steps: 1,
		probe: new CodingRunProbe(),
		startedAt: Date.now(),
	};

	it("two retries of the SAME run produce identical collapse-key messages", async () => {
		// The property `collapseRepeat` depends on: both CF attempts of run `82739cb6` carry the same
		// runId → same 8-char token → same message → `collapseRepeat` absorbs the second into the first.
		const { env: env1, inserts: ins1 } = mockDb();
		const { env: env2, inserts: ins2 } = mockDb();
		const runId = "82739cb6-4404-418d-992e-3dd6014c3cce";
		// Simulate attempt A: a different CF reference but the same run.
		await recordCodingFailure(env1, { ...base, runId, err: new Error("internal error; reference = ta78s8dpekde3apmplf351m0") });
		// Simulate attempt B: same run, different CF reference (CF generates a new one per retry).
		await recordCodingFailure(env2, { ...base, runId, err: new Error("internal error; reference = hknsjlipbemc1fi7lsn13vak") });
		const msgA = ins1.find((i) => i.sql.includes("error_log"))!.args[4] as string;
		const msgB = ins2.find((i) => i.sql.includes("error_log"))!.args[4] as string;
		// CF reference is stripped from both; run token is identical → messages must match.
		expect(msgA).toBe(msgB);
		// And the token prefix is visible — not a bare "coding run failed" that would cross-run collapse.
		expect(msgA).toContain("82739cb6");
	});

	it("two deaths from DIFFERENT runs produce distinct collapse-key messages", async () => {
		// The cross-run miscount: before the run token, two runs dying at the same phase produced
		// identical messages and collapsed into one row, making `context.runId ≠ last_context.runId`.
		const { env: env1, inserts: ins1 } = mockDb();
		const { env: env2, inserts: ins2 } = mockDb();
		await recordCodingFailure(env1, { ...base, runId: "run_aaaa_11111" });
		await recordCodingFailure(env2, { ...base, runId: "run_bbbb_22222" });
		const msgA = ins1.find((i) => i.sql.includes("error_log"))!.args[4] as string;
		const msgB = ins2.find((i) => i.sql.includes("error_log"))!.args[4] as string;
		// Different runIds → different 8-char tokens → different messages → they do NOT collapse.
		expect(msgA).not.toBe(msgB);
		expect(msgA).toContain("run_aaaa");
		expect(msgB).toContain("run_bbbb");
	});

	it("falls back to sessionId when no runId — chat-initiated runs stay distinct", async () => {
		// A chat-triggered `start_work` has no loopRunId, so runId is null. The sessionId is stable
		// for that run and unique across runs, so it is the right fallback discriminator.
		const { env, inserts } = mockDb();
		await recordCodingFailure(env, { ...base, sessionId: "csess_chat_abc123", runId: undefined });
		const msg = inserts.find((i) => i.sql.includes("error_log"))!.args[4] as string;
		// The token is the first 8 chars of sessionId.
		expect(msg).toContain("csess_ch");
	});
});

describe("the probe measures what a REPLAY re-measures (#546)", () => {
	const source = readFileSync(join(__dirname, "../workflows/coding-session.ts"), "utf8");

	/**
	 * Every `probe.<setter>(` call site in the workflow, and whether it sits inside a `step.do`
	 * callback. Depth is counted over braces from the last `step.do(` opening before the call —
	 * crude, and deliberately so: it is the same shape the #529 guard above uses, and the thing it
	 * has to notice is a setter moving back INSIDE a callback, which changes that nesting.
	 *
	 * G1: the denominator is asserted below. A regex that matched nothing would otherwise pass.
	 */
	const calls = [...source.matchAll(/probe\.(saw|drove|at)\(/g)].map((m) => ({ setter: m[1], at: m.index }));

	it("has the call sites this guard exists to watch", () => {
		// 1 × saw (inside `measured`), 1 × drove (in `onEvent`, before its step), 2 × at (the step
		// wrapper and the decide step). If this number moves, the guard below is measuring a
		// different program and has to be re-read, not re-pinned.
		expect(calls.map((c) => c.setter).sort().join(",")).toBe("at,at,drove,saw");
	});

	it("keeps `saw` and `drove` out of the journalled callbacks", () => {
		// The defect: `probe.saw(pane.pane)` sat inside `capture`, the snapshot step's body. A
		// replay returns the journalled result WITHOUT running the body, so a resumed attempt filed
		// `paneChars: 0` — production row 82739cb6-B — which reads as "it died on an empty pane".
		//
		// Both setters now run on the step's RESULT: `measured()` awaits the guarded promise and
		// `onEvent` reads `driven` before `step.do`. Move either back inside and this goes red.
		expect(source).toContain("const measured = async (p: Promise<unknown>): Promise<CodingPaneSnapshot> => {");
		expect(source).not.toContain("probe.saw(pane.pane)");
		const onEvent = source.slice(source.indexOf("onEvent: (type, message, data) => {"));
		const drove = onEvent.indexOf("probe.drove(driven)");
		const firstStep = onEvent.indexOf("return step.do(");
		expect(drove, "probe.drove no longer appears in onEvent").toBeGreaterThan(-1);
		expect(drove, "probe.drove moved back inside the journalled step").toBeLessThan(firstStep);
	});

	it("re-measures a journalled pane on replay", async () => {
		// The behaviour the two source assertions above stand for, exercised directly: a replay
		// hands back the recorded result and runs no callback.
		const probe = new CodingRunProbe();
		const journal = { pane: "x".repeat(4_096), runState: "idle" };
		let callbackRuns = 0;
		const replayedStep = async (_name: string, cb: () => Promise<unknown>) => {
			void cb; // a replay never invokes it
			return journal;
		};
		const measured = async (p: Promise<unknown>) => {
			const pane = (await p) as { pane: string };
			probe.saw(pane?.pane);
			return pane;
		};
		await measured(replayedStep("s0-snapshot", async () => { callbackRuns++; return journal; }));
		expect(callbackRuns, "a replay must not run the step body").toBe(0);
		expect(probe.paneChars, "the size came from the journalled result, not the callback").toBe(4_096);
	});
});
