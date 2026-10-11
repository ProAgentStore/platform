/**
 * The controller AI-provider recovery policy (#907), driven with a controlled clock and sleep.
 *
 * Invariants protected: only a provider stall is retried; the wall-clock ceiling counts attempt time
 * AND backoff; cancellation stops before any further attempt; each attempt's deadlines are clamped to
 * the time left; telemetry names the provider/model the request ACTUALLY ran on and the measured phase,
 * and nothing else; settings are validated against documented bounds, never silently clamped.
 */
import { describe, expect, it } from "vitest";
import {
	CONTROLLER_AI_DEFAULTS,
	ControllerAiCancelled,
	ControllerAiStalled,
	isControllerAiStall,
	policyFrom,
	sanitizeControllerAiSettings,
	withControllerAiRecovery,
	type ControllerAiPolicy,
} from "./controller-ai-recovery.js";
import { UserAiProviderError } from "./user-ai.js";

/** A stall exactly as `runAnthropic` raises one: retryable, measured, with its provider and model. */
function stall(contentStarted = false, provider = "anthropic", model = "claude-sonnet-4-6") {
	const e = new UserAiProviderError(`The AI provider ${contentStarted ? "stopped sending mid-reply" : "did not begin replying within 60s"}.`, 504, undefined, undefined, true);
	return Object.assign(e, { streamPhase: { contentStarted, eventsSeen: contentStarted ? 4 : 1, lastEventType: contentStarted ? "content_block_delta" : "ping", silentForMs: 45_000, elapsedMs: 50_000 }, provider, model });
}

function harness(opts: { policy?: Partial<ControllerAiPolicy>; attemptMs?: number; cancelAfterSleeps?: number } = {}) {
	let clock = 0;
	let sleeps = 0;
	const slept: number[] = [];
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	const policy = { ...policyFrom(), ...opts.policy };
	const deps = {
		surface: "pilot" as const,
		now: () => clock,
		sleep: async (ms: number) => {
			slept.push(ms);
			clock += ms;
			sleeps++;
		},
		isCancelled: async () => opts.cancelAfterSleeps !== undefined && sleeps >= opts.cancelAfterSleeps,
		emit: (event: string, data: object) => {
			events.push({ event, data: data as Record<string, unknown> });
		},
	};
	const run = <T>(results: Array<T | Error>) => {
		const calls: Array<{ attempt: number; deadlines: { preContentMs?: number; silenceMs?: number; totalMs?: number } }> = [];
		const promise = withControllerAiRecovery(policy, deps, async (deadlines, attempt) => {
			calls.push({ attempt, deadlines });
			// A real request is cut at its own `totalMs` — the clamp is how the ceiling binds attempt time.
			clock += Math.min(opts.attemptMs ?? 50_000, deadlines.totalMs ?? Number.POSITIVE_INFINITY);
			const r = results[Math.min(attempt - 1, results.length - 1)];
			if (r instanceof Error) throw r;
			return r;
		});
		return { promise, calls };
	};
	return { run, slept, events };
}

describe("withControllerAiRecovery (#907)", () => {
	it("recovers from a stall on the next attempt, after the first backoff", async () => {
		const h = harness();
		const { promise, calls } = h.run([stall(), "decision"]);
		await expect(promise).resolves.toBe("decision");
		expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
		expect(h.slept).toEqual([2_000]);
		expect(h.events.map((e) => e.event)).toEqual(["stall", "recovered"]);
	});

	it("passes this attempt's deadlines, clamped to what is left of the ceiling", async () => {
		const h = harness();
		const { promise, calls } = h.run([stall(), stall(), "ok"]);
		await promise;
		expect(calls[0].deadlines).toEqual({ preContentMs: 60_000, silenceMs: 45_000, totalMs: 240_000 });
		// 50s attempt + 2s backoff spent: 188s left for the second.
		expect(calls[1].deadlines.totalMs).toBe(240_000 - 52_000);
	});

	it("exhausts after the configured attempts with a truthful, classifiable error", async () => {
		const h = harness({ attemptMs: 1_000 });
		const { promise, calls } = h.run([stall()]);
		const err = (await promise.catch((e: unknown) => e)) as ControllerAiStalled;
		expect(err).toBeInstanceOf(ControllerAiStalled);
		expect(err).toMatchObject({ attempts: 4, reason: "exhausted" });
		expect(calls).toHaveLength(4);
		expect(err.message).toContain("controller's AI provider stalled on 4 attempts");
		expect(err.message).toContain("coding CLI, the runner and the repository were not involved");
		// …and the run-level classifier still files it as a provider stall (a resumable provider fact).
		expect(err.message).toMatch(/stopped sending mid-reply/);
		expect(h.events.map((e) => e.event)).toEqual(["stall", "stall", "stall", "stall", "exhausted"]);
	});

	it("enforces the wall-clock ceiling over attempt time AND backoff — not just the backoff", async () => {
		// 100s attempts under a 240s ceiling: 0→100, +2s, 102→202, +5s, then only 33s are left, so the
		// third attempt is clamped to 33s and the recovery ends AT the ceiling — never past it.
		const h = harness({ attemptMs: 100_000 });
		const { promise, calls } = h.run([stall()]);
		const err = (await promise.catch((e: unknown) => e)) as ControllerAiStalled;
		expect(err).toMatchObject({ reason: "ceiling", attempts: 3 });
		expect(calls.map((c) => c.deadlines.totalMs)).toEqual([240_000, 138_000, 33_000]);
		expect(err.elapsedMs).toBeLessThanOrEqual(240_000);
		expect(h.events.at(-1)?.event).toBe("ceiling");
	});

	it("stops on cancellation after a backoff, without another attempt", async () => {
		const h = harness({ cancelAfterSleeps: 1 });
		const { promise, calls } = h.run([stall(), "never reached"]);
		await expect(promise).rejects.toBeInstanceOf(ControllerAiCancelled);
		expect(calls).toHaveLength(1);
		expect(h.events.map((e) => e.event)).toEqual(["stall", "cancelled"]);
	});

	it.each([
		["credentials", new UserAiProviderError("Anthropic (401): invalid x-api-key", 400, 401, undefined, false)],
		["the total-length ceiling", new UserAiProviderError("The reply was still being written after 180s and had to be stopped", 504, undefined, undefined, false)],
		["a bug", new TypeError("cannot read properties of undefined")],
	])("does not retry %s — it passes through on the first throw", async (_label, error) => {
		const h = harness();
		const { promise, calls } = h.run([error]);
		await expect(promise).rejects.toBe(error);
		expect(calls).toHaveLength(1);
		expect(h.events).toEqual([]);
	});

	it("records the provider and model the request actually ran on, and the measured phase — nothing else", async () => {
		const h = harness();
		await h.run([stall(true, "anthropic", "claude-sonnet-4-6"), "ok"]).promise;
		const s = h.events[0].data;
		expect(s).toMatchObject({ surface: "pilot", provider: "anthropic", model: "claude-sonnet-4-6", attempt: 1, maxAttempts: 4, backoffMs: 2_000, preContentMs: 60_000, silenceMs: 45_000, ceilingMs: 240_000 });
		expect(s.phase).toEqual({ contentStarted: true, eventsSeen: 4, lastEventType: "content_block_delta", silentForMs: 45_000, elapsedMs: 50_000 });
		expect(Object.keys(s).sort()).toEqual(["attempt", "backoffMs", "ceilingMs", "elapsedMs", "maxAttempts", "model", "phase", "preContentMs", "provider", "silenceMs", "surface"]);
	});
});

describe("what counts as a stall", () => {
	it("is the provider's own retryable silence, never a non-retryable failure", () => {
		expect(isControllerAiStall(stall())).toBe(true);
		expect(isControllerAiStall(new UserAiProviderError("The connection to the AI provider ended mid-reply", 504, undefined, undefined, true))).toBe(true);
		expect(isControllerAiStall(new UserAiProviderError("stopped sending mid-reply", 504, undefined, undefined, false))).toBe(false);
		expect(isControllerAiStall(new Error("Anthropic (429): rate_limit"))).toBe(false);
	});
});

describe("per-instance settings are validated against documented bounds", () => {
	it("accepts whole seconds inside the bounds and null to restore a default", () => {
		expect(sanitizeControllerAiSettings({ preContentSeconds: 90, silenceSeconds: null })).toEqual({ ok: true, patch: { preContentSeconds: 90, silenceSeconds: null } });
	});

	it.each([
		[{ preContentSeconds: 5 }],
		[{ silenceSeconds: 121 }],
		[{ decisionCeilingSeconds: 60.5 }],
		[{ timeoutSeconds: 30 }],
		["60"],
	])("refuses %j rather than clamping it", (raw) => {
		expect(sanitizeControllerAiSettings(raw).ok).toBe(false);
	});

	it("defaults are the documented ones", () => {
		expect(CONTROLLER_AI_DEFAULTS).toEqual({ preContentSeconds: 60, silenceSeconds: 45, decisionCeilingSeconds: 240 });
		expect(policyFrom({ silenceSeconds: 30 })).toMatchObject({ preContentMs: 60_000, silenceMs: 30_000, ceilingMs: 240_000, maxAttempts: 4 });
	});
});
