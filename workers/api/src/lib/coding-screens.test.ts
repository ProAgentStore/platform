import { describe, expect, it } from "vitest";
import { PILOT_DEFAULT_MAX_STEPS } from "./loop-limits.js";
import { MAX_EMPTY_INSTRUCTIONS, MAX_REFUSALS, newLoopCounters, LOOP_FALLBACK_MAX_STEPS } from "./coding-loop-state.js";
import type { CodingGoal } from "./coding-loop-types.js";
import { screenAction } from "./coding-screens.js";

// #1359: the screens an instruction passes before the engine, lifted out of runCodingLoop. coding-loop.test.ts drives them end to
// end through the loop; these pin the extracted function directly: its verdicts, its effects and their order, and the counters.
const goal = (over: Partial<CodingGoal> = {}): CodingGoal => ({ objective: "ship it", repo: "acme/app", clientType: "claude", ...over }) as CodingGoal;
const msg = (text: string) => ({ action: { kind: "message" as const, text } });

describe("the loop's bookkeeping", () => {
	it("starts every run clean, and the default step budget is the one the loop always used", () => {
		expect(newLoopCounters()).toEqual({ scopeRefusals: 0, finishPushedBack: false, refusals: 0, askSentBack: false, emptyInstructions: 0, sentKeys: [], sentReads: [], repeatedInstruction: null });
		expect(newLoopCounters().sentKeys).not.toBe(newLoopCounters().sentKeys);
		expect(LOOP_FALLBACK_MAX_STEPS).toBe(30);
		// a different number from the workflow's per-round cap, on purpose: the loop's own fallback is not that cap
		expect(LOOP_FALLBACK_MAX_STEPS).not.toBe(PILOT_DEFAULT_MAX_STEPS);
	});
});

describe("empty instructions (#504)", () => {
	it("skips an empty one with a note on all three surfaces, and says why when the model was cut off", () => {
		const c = newLoopCounters();
		const v = screenAction(c, goal(), { ...msg("   "), truncated: true });
		expect(v.kind).toBe("skip");
		expect(v.effects).toHaveLength(1);
		expect(v.effects[0].log).toMatch(/cut off at the model's output limit/);
		expect(v.effects[0]).toMatchObject({ event: { name: "empty" } });
		expect(v.effects[0].transcript).toBe(v.effects[0].log);
		expect(c.emptyInstructions).toBe(1);
	});

	it(`ends after ${MAX_EMPTY_INSTRUCTIONS} in a row, but any sent instruction resets the count`, () => {
		const c = newLoopCounters();
		for (let i = 1; i < MAX_EMPTY_INSTRUCTIONS; i++) expect(screenAction(c, goal(), msg("")).kind).toBe("skip");
		expect(screenAction(c, goal(), msg("run the tests")).kind).toBe("send");
		expect(c.emptyInstructions).toBe(0);
		for (let i = 1; i < MAX_EMPTY_INSTRUCTIONS; i++) expect(screenAction(c, goal(), msg("")).kind).toBe("skip");
		const last = screenAction(c, goal(), msg(""));
		expect(last).toMatchObject({ kind: "end", outcome: "failed" });
		expect((last as { detail: string }).detail).toMatch(new RegExp(`${MAX_EMPTY_INSTRUCTIONS} empty instructions in a row`));
	});

	it("an interrupt is not an empty message, and resets the count", () => {
		const c = newLoopCounters();
		screenAction(c, goal(), msg(""));
		expect(screenAction(c, goal(), { action: { kind: "interrupt" } }).kind).toBe("send");
		expect(c.emptyInstructions).toBe(0);
	});
});

describe("merge authority (#314)", () => {
	const merge = msg("gh pr merge 12 --squash");
	it("refuses under a no-merge policy: logs the note, raises the bare refusal, and stops the run at the bound", () => {
		const c = newLoopCounters();
		const g = goal({ mergePolicy: "pr" });
		const first = screenAction(c, g, merge);
		expect(first.kind).toBe("skip");
		expect(first.effects[0].log).toMatch(/^refused \(merge authority\): /);
		expect(first.effects[0].event?.detail).toBe(first.effects[0].log?.replace("refused (merge authority): ", ""));
		for (let i = 2; i < MAX_REFUSALS; i++) expect(screenAction(c, g, merge).kind).toBe("skip");
		expect(screenAction(c, g, merge)).toMatchObject({ kind: "end", outcome: "failed" });
	});

	it("is a no-op under the default policy", () => {
		expect(screenAction(newLoopCounters(), goal(), merge).kind).toBe("send");
	});
});

describe("owner scope (#1019)", () => {
	it("refuses an instruction outside the owner's constraints, and stops the run at the bound", () => {
		const c = newLoopCounters();
		const g = goal({ scopeConstraints: [{ kind: "no_push", source: "your standing rules" }] });
		const v = screenAction(c, g, msg("git push origin main"));
		expect(v.kind).toBe("skip");
		expect(v.effects[0]).toMatchObject({ event: { name: "scope_refused" } });
		expect(v.effects[0].log).toMatch(/^refused \(owner constraint\): /);
		for (let i = 2; i < MAX_REFUSALS; i++) expect(screenAction(c, g, msg("git push origin main")).kind).toBe("skip");
		const end = screenAction(c, g, msg("git push origin main"));
		expect(end).toMatchObject({ kind: "end", outcome: "failed" });
		expect((end as { detail: string }).detail).toMatch(/^Stopped: the orchestrator kept producing instructions outside the owner's constraints\. Last: /);
	});
});

describe("repeat and re-read (#522, #807)", () => {
	it("records every sent instruction's key and reads, one entry each, and sends", () => {
		const c = newLoopCounters();
		expect(screenAction(c, goal(), msg("```\nnpm test\n```")).kind).toBe("send");
		expect(screenAction(c, goal(), msg("quote lines 1-80 of src/a.ts")).kind).toBe("send");
		expect(c.sentKeys).toHaveLength(2);
		expect(c.sentReads).toHaveLength(2);
	});

	it("notes a repeated instruction (log + transcript + event), remembers it for the finish branch, then stops the run as stuck with the transcript only", () => {
		const c = newLoopCounters();
		const same = msg("```\nnpm run build\n```");
		const kinds: string[] = [];
		let noted = false;
		let stopped: ReturnType<typeof screenAction> | null = null;
		for (let i = 0; i < 8 && !stopped; i++) {
			const v = screenAction(c, goal(), same);
			kinds.push(v.kind);
			if (v.kind === "end") stopped = v;
			else if (v.effects.some((e) => e.event?.name === "repeated")) noted = true;
		}
		expect(noted).toBe(true);
		expect(c.repeatedInstruction).toBe((same.action as { text: string }).text);
		expect(stopped).toMatchObject({ kind: "end", outcome: "stuck" });
		const stop = (stopped as unknown as { effects: Array<{ log?: string; transcript?: string; event?: { name: string } }> }).effects;
		expect(stop).toHaveLength(1);
		expect(stop[0].log).toBeUndefined(); // the stop is told to the transcript and the listener, never the Pilot's step log
		expect(stop[0]).toMatchObject({ event: { name: "repeated" } });
		expect(kinds.at(-1)).toBe("end");
	});

	it("notes a re-read of the same file without stopping", () => {
		const c = newLoopCounters();
		screenAction(c, goal(), msg("quote lines 1-80 of src/a.ts"));
		const v = screenAction(c, goal(), msg("now quote lines 80-200 of src/a.ts"));
		expect(v.kind).toBe("send");
		expect(v.effects.some((e) => e.event?.name === "repeated" && /src\/a\.ts/.test(e.log ?? ""))).toBe(true);
	});
});
