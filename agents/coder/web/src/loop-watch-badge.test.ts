/**
 * The live loop watchers say when a run is parked or stalled (#930).
 *
 * Both watchers — the Assistant tab's Loop button and this tab's — showed only an iteration
 * counter, so a run the platform had classified as `waiting` or `stalled` looked exactly like one
 * at work. The API sends `health` + `waitNote` on every `GET /loop/:runId` (routes/tools.ts
 * `withHealth`); these hold the one helper both watchers render it through, and the wiring that
 * makes each watcher read it on every poll.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOP_WATCH_BADGE_CLASS, loopWatchBadge } from "./coding-loop-run";

describe("loopWatchBadge", () => {
	it("says WHAT a parked run waits for, in the server's words", () => {
		expect(loopWatchBadge({ health: "waiting", waitNote: "waiting on you — gives up at 14:32" })).toEqual({
			tone: "waiting",
			word: "Waiting",
			title: "Waiting — waiting on you — gives up at 14:32",
		});
	});

	it("never promises a resume time when the server named no reason", () => {
		const b = loopWatchBadge({ health: "waiting", waitNote: null });
		expect(b?.title).toBe("Waiting — deliberately parked, not stalled");
		expect(b?.title).not.toMatch(/resume/i);
	});

	it("calls a stalled run stalled", () => {
		expect(loopWatchBadge({ health: "stalled" })).toMatchObject({ tone: "stalled", word: "Stalled" });
	});

	it("says nothing for a working or ended run, or when the server sent no verdict", () => {
		for (const health of ["working", "ended", undefined, null, "something-new"]) expect(loopWatchBadge({ health })).toBeNull();
		expect(loopWatchBadge(null)).toBeNull();
	});

	it("has a colour for every tone, from tokens the theme declares", () => {
		expect(Object.keys(LOOP_WATCH_BADGE_CLASS).sort()).toEqual(["stalled", "waiting"]);
		expect(LOOP_WATCH_BADGE_CLASS.waiting).toContain("text-warning");
		expect(LOOP_WATCH_BADGE_CLASS.stalled).toContain("text-danger");
	});
});

describe("the Coding tab's watcher reads the verdict on every poll", () => {
	const HOOK = readFileSync(join(__dirname, "use-coding-loop.ts"), "utf8");
	const VIEW = readFileSync(join(__dirname, "CopilotView.tsx"), "utf8");

	it("sets the badge from each polled run and clears it when the run ends", () => {
		const poll = HOOK.slice(HOOK.indexOf("pollRunRef.current = async"), HOOK.indexOf("// 3s, matching"));
		expect(poll).toContain("setLoopBadge(loopWatchBadge(run));");
		expect(poll.indexOf("setLoopBadge(loopWatchBadge(run));")).toBeLessThan(poll.indexOf("if (!loopRunEnded(run)) return;"));
		expect(poll).toContain("setLoopBadge(null);");
	});

	it("renders it beside the Stop control", () => {
		expect(VIEW).toContain('data-testid="loop-activity"');
		expect(VIEW).toContain("LOOP_WATCH_BADGE_CLASS[loop.loopBadge.tone]");
		expect(VIEW).toContain("title={loop.loopBadge.title}");
	});
});
