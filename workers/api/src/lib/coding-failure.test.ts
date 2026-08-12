import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionLostMessage, deadlineMessage } from "./ai-deadlines.js";
import { classifyCodingFailure, CodingRunProbe, codingFailureLevel, recordCodingFailure } from "./coding-failure.js";
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
		expect(message).toContain("coding run failed (provider_stall) at s7-decide after 4 steps");
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

	it("falls back to the session id as the trace key when no loop run started it", async () => {
		const { env, inserts } = mockDb();
		// A chat-initiated `start_work` carries no loopRunId and no board card. It still has to be
		// findable, or the exact run this ticket was filed about would still be unreadable.
		await recordCodingFailure(env, {
			err: new RunnerGoneError("the machine did not come back"),
			userId: "u1",
			instanceId: "i1",
			sessionId: "csess_2",
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
				steps: 0,
				probe: new CodingRunProbe(),
				startedAt: Date.now(),
			}),
		).resolves.toMatchObject({ class: "unknown" });
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
