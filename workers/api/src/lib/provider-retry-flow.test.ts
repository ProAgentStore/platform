/**
 * #1391 — a Codex turn that dies on "Selected model is at capacity" and exits 1, followed from the runner's report to the run's ending.
 *
 * The two steps the workflow takes are driven here exactly as it takes them: `foldTurn` judges the runner's report of the failed turn, and a
 * `waiting` ending goes to `resolvePause`, which parks, resumes, or — out of attempts — ends the run. Nothing between them is faked or skipped;
 * only the machine (a report), the clock (sleeps are recorded, not waited) and the durable trace (events are collected) are stand-ins.
 *
 * What is held to account is what the issue asked for: the exit-1 line reaches the transient verdict; the run resends, then waits on exponential
 * backoff with jitter for a configured number of attempts; it recovers on success; and when it gives up it says so — the final status, every wait
 * served and the provider's whole error — and every one of those facts is a structured event, never only a line in a pane.
 */
import { describe, expect, it } from "vitest";
import { type CodingResult } from "./coding-loop.js";
import { type PauseDeps, resolvePause } from "./coding-pause.js";
import { EMPTY_STREAK, foldTurn, type TurnCarry } from "./coding-turn-outcome.js";
import type { EngineWaitState } from "./coding-wait.js";
import { DEFAULT_PROVIDER_RETRY, type ProviderRetryPolicy, retryDelayMs } from "./provider-retry.js";

const CAPACITY = "Selected model is at capacity. Please try a different model.";
/** What the runner reports for the incident's turn: exit 1, the engine's last line, and the lines that carry the reason. */
const capacityReport = (at: number) => ({
	verdict: "failed",
	exitCode: 1,
	signal: null,
	at,
	detail: "[codex exited with code 1]",
	tail: [`[codex] error: ${CAPACITY}`, `[error] ${CAPACITY}`, "[codex exited with code 1]"],
});
const okReport = (at: number) => ({ verdict: "ok", exitCode: 0, signal: null, at });

interface Fact {
	name: string;
	message: string;
	data: Record<string, unknown>;
}

/** The workflow's two steps, with the park's side effects recorded. */
function harness(over: { policy?: ProviderRetryPolicy; seed?: string; cancelAfterTicks?: number; withoutHooks?: boolean } = {}) {
	const facts: Fact[] = [];
	const slept: number[] = [];
	const announced: string[] = [];
	let ticks = 0;
	const deps: PauseDeps = {
		repo: "acme/app",
		instanceId: "i1",
		now: () => 1_800_000_000_000,
		takeover: async () => undefined,
		takeoverStatus: async () => ({ resolved: false }),
		endTakeover: async () => undefined,
		sleep: async (_label, ms) => void slept.push(ms),
		notify: async () => undefined,
		announce: async (m) => void announced.push(m),
		card: async () => undefined,
		tick: async () => {
			ticks++;
			return over.cancelAfterTicks === undefined || ticks < over.cancelAfterTicks;
		},
		reauthCompletedSince: async () => false,
		restartEngine: async () => undefined,
		...(over.withoutHooks ? {} : { providerRetry: async () => ({ policy: over.policy ?? DEFAULT_PROVIDER_RETRY, seed: over.seed }), trace: async (name: string, message: string, data: Record<string, unknown>) => void facts.push({ name, message, data }) }),
	};
	let carry: TurnCarry = { turns: EMPTY_STREAK, transientStreak: 0 };
	const state: EngineWaitState = { waits: 0, spentMs: 0 };
	let at = 0;
	const notes: string[] = [];
	return {
		facts,
		slept,
		announced,
		notes,
		state,
		/** One engine turn ends with this report; the run reacts as the workflow does. Returns the pause verdict when the turn parked the run, else the loop's ending or null. */
		async turn(report: ReturnType<typeof capacityReport> | ReturnType<typeof okReport>) {
			const folded = foldTurn(carry, { lastTurn: report }, { repo: "acme/app", signInBlock: () => null });
			carry = folded.carry;
			for (const e of folded.effects) {
				if (e.log) notes.push(e.log);
				if (e.event?.name.startsWith("provider_")) facts.push({ name: e.event.name, message: e.event.detail, data: (e.event.data ?? {}) as Record<string, unknown> });
			}
			if (!folded.ending) return { ending: null as null };
			const { kind: _kind, ...result } = folded.ending as { kind: string } & CodingResult;
			const res = { ...result, steps: 4 } as CodingResult;
			if (res.outcome !== "waiting") return { ending: res };
			return { ending: res, pause: await resolvePause(deps, { round: 0, result: res, state }) };
		},
		next: () => ++at,
	};
}

const names = (facts: Fact[]) => facts.map((f) => f.name);

describe("a Codex turn that dies on 'Selected model is at capacity' and exits 1 (#1391)", () => {
	it("is classified as a transient provider failure from the exit-1 report — the matched rule, the exit code and the whole error recorded", async () => {
		const h = harness();
		await h.turn(capacityReport(h.next()));
		const classified = h.facts.find((f) => f.name === "provider_error_classified");
		expect(classified?.data).toMatchObject({ kind: "transient", provider: "openai (codex)", rule: "openai (codex)/transient", exitCode: 1 });
		// The whole of what the turn printed, not the one clipped line the owner-facing sentence quotes.
		expect(String(classified?.data.text)).toContain(`[codex] error: ${CAPACITY}`);
		expect(String(classified?.data.text)).toContain("[codex exited with code 1]");
	});

	it("is classified even when the report's own detail is only the exit line — the reason sits in the tail", async () => {
		// The shape of the incident: detail "[codex exited with code 1]" names nothing; the capacity line is two lines up.
		const h = harness();
		await h.turn({ ...capacityReport(1), detail: "[codex exited with code 1]" });
		expect(names(h.facts)).toContain("provider_error_classified");
	});

	it("the FIRST failure is resent (the Pilot is told to send the same instruction again) and the decision says why", async () => {
		const h = harness();
		const out = await h.turn(capacityReport(h.next()));
		expect(out.ending).toBeNull(); // not parked yet, not a strike
		expect(h.notes.join("\n")).toMatch(/send the SAME instruction again/);
		expect(h.facts.at(-1)).toMatchObject({ name: "provider_retry_decision", data: { decision: "resend", why: "first_transient_failure", exitCode: 1, rule: "openai (codex)/transient" } });
	});

	it("a repeat parks on exponential backoff: the wait, 'retry 1 of 4' and the next-attempt time are structured events", async () => {
		const h = harness();
		await h.turn(capacityReport(h.next()));
		const out = await h.turn(capacityReport(h.next()));
		expect(out.pause).toMatchObject({ resume: true });
		expect(h.slept).toEqual([120_000]); // the first wait: 2 minutes, no seed so no spread
		const scheduled = h.facts.find((f) => f.name === "provider_retry_scheduled");
		expect(scheduled?.data).toMatchObject({ attempt: 1, of: 4, waitMs: 120_000, rule: "openai (codex)/transient", provider: "openai (codex)", exitCode: 1 });
		expect(typeof scheduled?.data.nextAttemptAt).toBe("number");
		expect(h.facts.find((f) => f.name === "provider_retry_attempt")?.data).toMatchObject({ attempt: 1, of: 4, waitedMs: 120_000 });
		expect(h.facts.find((f) => f.name === "provider_retry_decision" && (f.data as { decision?: string }).decision === "park")?.data).toMatchObject({ why: "repeated_transient" });
	});

	it("the events come in the order the run lived them", async () => {
		const h = harness();
		await h.turn(capacityReport(h.next()));
		await h.turn(capacityReport(h.next()));
		expect(names(h.facts)).toEqual([
			"provider_error_classified",
			"provider_retry_decision", // resend
			"provider_error_classified",
			"provider_retry_decision", // park
			"provider_retry_scheduled",
			"provider_retry_attempt",
		]);
	});

	it("recovers on success: a turn that works after the wait adds no failure and ends the streak", async () => {
		const h = harness();
		await h.turn(capacityReport(h.next()));
		await h.turn(capacityReport(h.next()));
		const before = names(h.facts).length;
		const out = await h.turn(okReport(h.next()));
		expect(out.ending).toBeNull();
		expect(names(h.facts).length).toBe(before); // nothing more recorded: the run is working again
		expect(h.state.transientWaits).toBe(1);
	});

	it("gives up only after the configured attempts, and then says so: engine_error, every wait served, the provider's whole error", async () => {
		const policy: ProviderRetryPolicy = { attempts: 3, baseMs: 60_000, maxMs: 15 * 60_000, jitter: 0 };
		const h = harness({ policy });
		let last: Awaited<ReturnType<typeof h.turn>> = { ending: null };
		// Each cycle is a free resend, then a park; after the third wait the next park is refused.
		for (let cycle = 0; cycle < 6 && !(last.pause && last.pause.resume === false); cycle++) {
			await h.turn(capacityReport(h.next()));
			last = await h.turn(capacityReport(h.next()));
		}
		expect(h.slept).toEqual([60_000, 120_000, 240_000]); // 1, 2, 4 minutes — exponential
		expect(last.pause?.resume).toBe(false);
		const result = last.pause && !last.pause.resume ? last.pause.result : null;
		expect(result?.outcome).toBe("engine_error");
		// The ending names what was tried and quotes the provider in full.
		expect(result?.detail).toMatch(/kept failing after 3 retries \(waits: 1 min, 2 min, 4 min\)/);
		expect(result?.detail).toContain("openai (codex)");
		expect(result?.detail).toContain(`[codex] error: ${CAPACITY}`);
		const exhausted = h.facts.find((f) => f.name === "provider_retry_exhausted");
		expect(exhausted?.data).toMatchObject({ attempts: 3, taken: 3, waitsMs: [60_000, 120_000, 240_000], stopReason: "engine_error", rule: "openai (codex)/transient", exitCode: 1 });
		expect(String(exhausted?.data.error)).toContain(`[error] ${CAPACITY}`);
		// …and every attempt left its own pair of facts.
		expect(h.facts.filter((f) => f.name === "provider_retry_scheduled").map((f) => f.data.attempt)).toEqual([1, 2, 3]);
		expect(h.facts.filter((f) => f.name === "provider_retry_attempt").map((f) => f.data.attempt)).toEqual([1, 2, 3]);
		expect(names(h.facts).at(-1)).toBe("provider_retry_exhausted");
	});

	it("never ends silently: the run is stopped with an explicit outcome, not left to the next poll", async () => {
		const h = harness({ policy: { attempts: 1, baseMs: 60_000, maxMs: 60_000, jitter: 0 } });
		await h.turn(capacityReport(h.next()));
		await h.turn(capacityReport(h.next())); // park 1 (the only attempt)
		await h.turn(capacityReport(h.next()));
		const out = await h.turn(capacityReport(h.next())); // refused
		expect(out.pause).toMatchObject({ resume: false, result: { outcome: "engine_error" } });
		expect(h.facts.some((f) => f.name === "provider_retry_exhausted")).toBe(true);
	});

	it("a wait the owner cancels is not an attempt: nothing is recorded as retried", async () => {
		const h = harness({ cancelAfterTicks: 1 });
		await h.turn(capacityReport(h.next()));
		const out = await h.turn(capacityReport(h.next()));
		expect(out.pause).toMatchObject({ resume: false, result: { outcome: "cancelled" } });
		expect(h.facts.some((f) => f.name === "provider_retry_attempt")).toBe(false);
		expect(h.state.transientWaits ?? 0).toBe(0);
	});
});

describe("when nothing was retried, the decision says why (#1391)", () => {
	it("a failed turn no rule recognises is a strike, recorded as `no_rule_matched`", async () => {
		const h = harness();
		await h.turn({ verdict: "failed", exitCode: 2, signal: null, at: 1, detail: "invalid model gpt-9", tail: ["error: invalid model gpt-9"] });
		expect(names(h.facts)).toEqual(["provider_retry_decision"]);
		expect(h.facts[0].data).toMatchObject({ decision: "strike", why: "no_rule_matched", exitCode: 2, consecutiveFailures: 1 });
	});

	it("a runner too old to send the turn's output cannot be classified at all, and that is recorded as `tail_not_reported`", async () => {
		const h = harness();
		await h.turn({ verdict: "failed", exitCode: 1, signal: null, at: 1, detail: "[codex exited with code 1]" }); // no `tail` field
		expect(h.facts[0].data).toMatchObject({ decision: "strike", why: "tail_not_reported" });
	});

	it("a billing failure ends the run at once and the decision names it", async () => {
		const h = harness();
		const out = await h.turn({ verdict: "failed", exitCode: 1, signal: null, at: 1, detail: "You exceeded your current quota", tail: ["You exceeded your current quota, please check your plan and billing"] });
		expect(out.ending).toMatchObject({ outcome: "engine_error" });
		expect(h.facts.at(-1)?.data).toMatchObject({ decision: "end", why: "billing" });
	});

	it("the same turn seen again on the next poll records nothing twice", async () => {
		const h = harness();
		await h.turn(capacityReport(7));
		const n = h.facts.length;
		await h.turn(capacityReport(7));
		expect(h.facts.length).toBe(n);
	});
});

describe("jitter spreads the waits without making them unpredictable (#1391)", () => {
	const policy: ProviderRetryPolicy = { attempts: 3, baseMs: 120_000, maxMs: 900_000, jitter: 0.2 };
	const waitsFor = async (seed: string) => {
		const h = harness({ policy, seed });
		for (let i = 0; i < 3; i++) {
			await h.turn(capacityReport(h.next()));
			await h.turn(capacityReport(h.next()));
		}
		// Each wait whole, as the scheduled event records it: a wait over the park's 5-minute tick is slept in chunks.
		return h.facts.filter((f) => f.name === "provider_retry_scheduled").map((f) => f.data.waitMs as number);
	};

	it("the same run waits the same instants on a replay, and another run waits different ones", async () => {
		expect(await waitsFor("run-a")).toEqual(await waitsFor("run-a"));
		expect(await waitsFor("run-a")).not.toEqual(await waitsFor("run-b"));
	});

	it("every wait is within the spread of its backoff and never over the ceiling", async () => {
		for (const seed of ["run-a", "run-b", "run-c", "9d0f8546-6cbb-4efe-8fe6-30fffc33d46a"]) {
			const waits = await waitsFor(seed);
			expect(waits).toHaveLength(3);
			waits.forEach((ms, i) => {
				const exact = retryDelayMs(i, policy);
				expect(ms).toBeGreaterThanOrEqual(Math.floor(exact * 0.8));
				expect(ms).toBeLessThanOrEqual(Math.min(policy.maxMs, Math.ceil(exact * 1.2)));
			});
		}
	});
});

describe("a caller with no retry hooks behaves as it always did (#1391)", () => {
	it("no policy and no trace: the default ladder, no events, and an ending that still quotes the provider", async () => {
		const h = harness({ withoutHooks: true });
		for (let i = 0; i < 6; i++) {
			await h.turn(capacityReport(h.next()));
			const out = await h.turn(capacityReport(h.next()));
			if (out.pause && !out.pause.resume) {
				// 2, 4, 8, then the 15 min ceiling — slept in 5-minute ticks, so the total is the thing to compare.
				expect(h.slept.reduce((a, b) => a + b, 0)).toBe(120_000 + 240_000 + 480_000 + 900_000);
				expect(out.pause.result.outcome).toBe("engine_error");
				expect(out.pause.result.detail).toContain(CAPACITY);
				expect(h.facts.filter((f) => f.name.startsWith("provider_retry_") && f.name !== "provider_retry_decision")).toEqual([]);
				return;
			}
		}
		throw new Error("the run never gave up");
	});
});
