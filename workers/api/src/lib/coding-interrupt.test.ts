/**
 * A run interrupted at its iteration-1→2 handoff resumes itself — with a stated clock (#855).
 *
 * The incident: a fresh session's run finished iteration 1, the engine went idle waiting for
 * instruction 2, the round died on an interruption, and the run parked on `platform_interrupt`
 * reading "is being resumed" while nothing was going to resume it. These drive the real
 * bookkeeping (`planInterruptionResume`) against a real-schema `agent_loop_runs` row, and the real
 * retry (`roundThroughInterruptions`), with only the workflow's journal and sleep faked — so what is
 * asserted is the row every surface reads and the sentence the owner is shown.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getLoopRun } from "./agent-loop-store.js";
import { interruptBackoffMs, MAX_PLATFORM_RESUMES } from "./coding-failure.js";
import { planInterruptionResume, roundThroughInterruptions, type InterruptionResume } from "./coding-interrupt.js";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import { sweepStaleRuns } from "./run-sweeper.js";
import { describeLoopRun, runHealth } from "./work-report.js";
import type { Env } from "../types.js";

/** Production's own interruption text (run `b9d9c051`) — classified `infra_transient`, resumable. */
const DO_RESET = "Durable Object reset because its code was updated.";
const RUN = "run-855";
const T0 = Date.parse("2026-09-26T10:00:00Z");

let close: () => void = () => undefined;
afterEach(() => close());

/** A fresh run on iteration 1, as the incident's was when its round died. */
function freshRun() {
	const d1 = realSchemaD1();
	close = () => d1.close();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at)
		 VALUES ('${RUN}', 'u1', 'i1', 'implement the plan', 'running', 1, 40, ${T0})`,
	);
	return { DB: d1.DB } as unknown as Env;
}

/** The workflow's side of a resume, with its journal and sleep recorded instead of performed. */
function harness(env: Env, now = () => T0) {
	const said: string[] = [];
	const recorded: unknown[] = [];
	const slept: Array<[string, number]> = [];
	const planned: number[] = [];
	const goal: { resumeNote?: string } = {};
	let interruptions = 0;
	const deps = {
		plan: async (e: unknown, k: number): Promise<InterruptionResume | null> => {
			planned.push(k);
			return planInterruptionResume(e, {
				env,
				runId: RUN,
				record: async (err) => {
					recorded.push(err);
				},
				trace: async () => undefined,
				announce: async (text) => {
					said.push(text);
				},
				now,
			});
		},
		sleep: async (label: string, ms: number) => {
			slept.push([label, ms]);
		},
		resumed: (note: string) => {
			goal.resumeNote = note;
		},
	};
	return { deps, goal, said, recorded, slept, planned, ordinal: { next: () => ++interruptions } };
}

describe("the iteration-1→2 handoff on a fresh session (#855)", () => {
	it("an interruption at the handoff RESUMES the round, and the Pilot is told the instruction may have landed", async () => {
		const env = freshRun();
		const h = harness(env);
		const notesSeen: Array<string | undefined> = [];
		let calls = 0;
		// Round 1 dies deciding iteration 2 — the engine idle after a complete iteration 1 — and the
		// retried round carries on and finishes.
		const result = await roundThroughInterruptions(
			async () => {
				calls++;
				notesSeen.push(h.goal.resumeNote);
				if (calls === 1) throw new Error(DO_RESET);
				return { outcome: "done" as const, steps: 2 };
			},
			h.deps,
			h.ordinal,
		);
		expect(result).toEqual({ outcome: "done", steps: 2 });
		// G1: it really died once and was really retried once — nothing below means anything otherwise.
		expect(calls).toBe(2);
		expect(h.planned).toEqual([1]);
		expect(h.slept).toEqual([["interrupt-backoff-1", interruptBackoffMs(1)]]);
		expect(notesSeen[0]).toBeUndefined();
		expect(notesSeen[1]).toMatch(/PLATFORM NOTE: your previous round was interrupted/);
		expect(notesSeen[1]).toMatch(/do not repeat an instruction/);
		// Said out loud, and filed as an interruption rather than a death.
		expect(h.said).toHaveLength(1);
		expect(h.said[0]).toMatch(/interruption 1 of 3/);
		expect(h.recorded).toHaveLength(1);
	});

	it("parks the run WITH the instant it retries, so every surface says a resume is scheduled — and when", async () => {
		const env = freshRun();
		const h = harness(env);
		let parkedView: Awaited<ReturnType<typeof getLoopRun>> = null;
		// Read the row while the backoff is being waited out — the moment the incident's owner looked.
		h.deps.sleep = async (label: string, ms: number) => {
			h.slept.push([label, ms]);
			parkedView = await getLoopRun(env, "u1", RUN);
		};
		let calls = 0;
		await roundThroughInterruptions(
			async () => {
				if (++calls === 1) throw new Error(DO_RESET);
				return "ok";
			},
			h.deps,
			h.ordinal,
		);
		// Assigned inside the `sleep` callback, so control flow still reads `parkedView` as its `null`
		// initialiser here; name the row type rather than derive it from the narrowed variable.
		const run = parkedView as NonNullable<Awaited<ReturnType<typeof getLoopRun>>> | null;
		if (!run) throw new Error("the run was never read while parked");
		expect(run).not.toBeNull();
		expect(run.waitingReason).toBe("platform_interrupt");
		expect(run.waitingUntil).toBe(T0 + interruptBackoffMs(1));
		expect(run.parkedSince).toBe(T0);
		const now = T0 + 10_000;
		expect(runHealth(run, now)).toBe("waiting");
		const said = describeLoopRun(run, now);
		expect(said).toContain("a retry is scheduled");
		expect(said).toContain("expected to resume in");
	});

	it("backs off exponentially and stops at the durable bound — the death past it is rethrown, not retried", async () => {
		const env = freshRun();
		const h = harness(env);
		let calls = 0;
		const round = roundThroughInterruptions(
			async () => {
				calls++;
				throw new Error(DO_RESET);
			},
			h.deps,
			h.ordinal,
		);
		await expect(round).rejects.toThrow(DO_RESET);
		// MAX resumes, then the (MAX+1)th death is the caller's to end.
		expect(calls).toBe(MAX_PLATFORM_RESUMES + 1);
		expect(h.slept.map(([, ms]) => ms)).toEqual([30_000, 60_000, 120_000]);
		expect(h.said).toHaveLength(MAX_PLATFORM_RESUMES);
	});

	it("a death that is not an interruption is not resumed, parks nothing, and waits for nothing", async () => {
		const env = freshRun();
		const h = harness(env);
		const round = roundThroughInterruptions(
			async () => {
				throw Object.assign(new Error("Anthropic (400): Your credit balance is too low to access the Anthropic API."), { status: 400 });
			},
			h.deps,
			h.ordinal,
		);
		await expect(round).rejects.toThrow(/credit balance/);
		expect(h.slept).toEqual([]);
		expect(h.said).toEqual([]);
		const run = await getLoopRun(env, "u1", RUN);
		expect(run?.waitingReason ?? null).toBeNull();
	});
});

describe("the give-up clock — a resume that never happens fails loudly on a stated clock (#855)", () => {
	it("a scheduled resume is NOT closed while its instant is ahead", async () => {
		const env = freshRun();
		await planInterruptionResume(new Error(DO_RESET), { env, runId: RUN, record: async () => undefined, trace: async () => undefined, announce: async () => undefined, now: () => T0 });
		const swept = await sweepStaleRuns(env, T0 + 20_000);
		expect(swept.wedgedParks).toBe(0);
		expect((await getLoopRun(env, "u1", RUN))?.status).toBe("running");
	});

	it("a park whose retry never came is closed as interrupted once the park budget has run out", async () => {
		const env = freshRun();
		await planInterruptionResume(new Error(DO_RESET), { env, runId: RUN, record: async () => undefined, trace: async () => undefined, announce: async () => undefined, now: () => T0 });
		// No retry: the workflow died during its backoff and nothing came back.
		const later = T0 + 16 * 60_000;
		const unresumed = await getLoopRun(env, "u1", RUN);
		// Past the published instant, the note stops promising a resume.
		expect(describeLoopRun(unresumed as NonNullable<typeof unresumed>, T0 + 5 * 60_000)).toContain("NO resume scheduled");
		const swept = await sweepStaleRuns(env, later);
		expect(swept.wedgedParks).toBe(1);
		const closed = await getLoopRun(env, "u1", RUN);
		expect(closed?.status).not.toBe("running");
		expect(closed?.stopReason).toBe("interrupted");
	});
});
