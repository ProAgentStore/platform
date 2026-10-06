/**
 * The Assistant tab's Loop button says when the run it watches is parked or stalled (#930).
 *
 * It showed only `{loopIteration}`, typed its poll without `health`, and so rendered a run the
 * platform had classified as `waiting`/`stalled` exactly like one at work. The sentence itself is
 * coder-web's `loopWatchBadge` (tested there); this holds the page to reading it on every poll and
 * on adoption, and the run-list row (`activityLabel`) to the same words.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loopWatchBadge } from "@proagentstore/coder-web";
import { describe, expect, it } from "vitest";
import { activityLabel } from "../lib/workInFlight";

const PAGE = readFileSync(join(__dirname, "InstanceDetail.tsx"), "utf8");

describe("InstanceDetail's loop watcher (#930)", () => {
	it("reads health and waitNote on every poll, and clears the badge when the run ends", () => {
		const poll = PAGE.slice(PAGE.indexOf("const pollLoop = useCallback"), PAGE.indexOf("const doSend = useCallback"));
		// Typed as LoopRunLike, which carries the server's `health` + `waitNote` (lib/workInFlight.ts).
		expect(poll).toContain("api<LoopRunLike>(");
		expect(poll).toContain("setLoopBadge(loopWatchBadge(run));");
		expect(poll).toContain("setLoopBadge(null);");
	});

	it("says so for an adopted run straight away, not after the first poll", () => {
		const adopt = PAGE.slice(PAGE.indexOf("loopDriverRef.current = null; // unknown for a run we did not start"), PAGE.indexOf("setLoopOn(true); // resumes the watcher"));
		expect(adopt).toContain("setLoopBadge(loopWatchBadge(run));");
	});

	it("renders the badge beside the Stop control", () => {
		expect(PAGE).toContain('data-testid="loop-activity"');
		expect(PAGE).toContain("LOOP_WATCH_BADGE_CLASS[loopBadge.tone]");
	});
});

describe("one set of words for a parked or stalled run", () => {
	it("the run-list row says exactly what the watchers say", () => {
		for (const run of [
			{ runId: "r", status: "running", health: "waiting" as const, waitNote: "waiting on you" },
			{ runId: "r", status: "running", health: "waiting" as const },
			{ runId: "r", status: "running", health: "stalled" as const },
		]) {
			expect(activityLabel(run)).toBe(loopWatchBadge(run)?.title);
		}
	});
});
