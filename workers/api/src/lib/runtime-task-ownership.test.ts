import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The runner's own list, imported rather than restated. A guard that keeps its own copy of the
// thing it is comparing against is the second copy that drifts — which is the entire subject of
// this file. `task-types.ts` is dependency-free for exactly this reason.
import { WORKFLOW_DRIVEN_TASKS } from "../../../../packages/browser-runner/src/task-types";
import {
	isOrphanedByRunnerReconnect,
	ORPHANABLE_TASK_TYPES,
	orphanedTaskReason,
	RUNTIME_TASK_OWNERS,
	runtimeTaskOwner,
} from "./runtime-task-ownership";

/**
 * #567's acceptance criterion: "a regression test enumerating every card `type` written anywhere in
 * `workers/api/src` and asserting each is explicitly classified — so the list cannot drift a fourth
 * time."
 *
 * The three drifts it is counting: `browser.task` in neither copy of the old predicate;
 * `browser.handoff` in the runner's list and never in the API's; and #553 putting `needs_human`
 * coding cards inside the same `SELECT`. Every one of them failed destructively.
 */

const API_SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
	}
	return out;
}

/**
 * Find the card types this Worker writes, by the SHAPE of a card write rather than by grepping for
 * `type:` — which returns JSON-Schema keywords, timeline entry kinds and stats-source names, and a
 * census padded with those measures nothing.
 *
 * Four shapes, each anchored on something only a board card has:
 *   1. an object literal whose `type` is immediately followed by `status` (every card record);
 *   2. `cardType:` — the standing-policy registry names its type in a dedicated field;
 *   3. a direct `INSERT INTO instance_runtime_tasks` naming type + status as literals;
 *   4. a `…_TASK_TYPE` constant.
 */
function cardTypesWrittenByTheApi(): Map<string, Set<string>> {
	const found = new Map<string, Set<string>>();
	const add = (type: string, file: string) => {
		if (!found.has(type)) found.set(type, new Set());
		found.get(type)?.add(file.slice(file.indexOf("workers/api")));
	};
	for (const file of walk(API_SRC)) {
		const src = readFileSync(file, "utf8");
		for (const m of src.matchAll(/\btype:\s*"([a-z][a-z0-9_.]*)",\s*\n\s*status[,:]/g)) add(m[1], file);
		for (const m of src.matchAll(/\bcardType:\s*"([a-z][a-z0-9_.]*)"/g)) add(m[1], file);
		for (const m of src.matchAll(
			/INSERT INTO instance_runtime_tasks[\s\S]{0,300}?(?:VALUES|SELECT)[^\n]*?'([a-z][a-z0-9_.]*)',\s*'[a-z_]+'/g,
		)) add(m[1], file);
		for (const m of src.matchAll(/TASK_TYPE\s*=\s*"([a-z][a-z0-9_.]*)"/g)) add(m[1], file);
	}
	return found;
}

describe("every card type this Worker writes is classified", () => {
	const found = cardTypesWrittenByTheApi();

	// ADR 0002: state the denominator. This shape of guard fails silently when its scan stops
	// matching anything, and then reports a clean sweep of nothing. These are the card types
	// present on 2026-08-15; the floor moves only when a type is deliberately removed.
	it("scans a tree that still contains the known card writers", () => {
		expect([...found.keys()].sort()).toEqual(
			expect.arrayContaining([
				"browser.task",
				"coding.off_branch",
				"coding.session",
				"coding.unauthorized_act",
				"coding.uncommitted",
				"delegation",
				"engine.signin",
				"escalation",
				"job.apply_agent",
				"pipeline.run",
				"setup.cloudflare_workers_ai",
				"setup.pags_browser_runtime",
				"ticket",
			]),
		);
		expect(found.size).toBeGreaterThanOrEqual(13);
	});

	it("classifies each one explicitly", () => {
		const unclassified = [...found].filter(([type]) => !(type in RUNTIME_TASK_OWNERS));
		expect(
			unclassified.map(([type, files]) => `${type} (${[...files].join(", ")})`),
			"a new board card type must be added to RUNTIME_TASK_OWNERS — until then the reconnect sweep leaves it alone, which is safe but undocumented",
		).toEqual([]);
	});

	it("sweeps none of them: no card the cloud writes belongs to a runner process", () => {
		// The production failures were all in this set — a live coding session expired mid-run, and
		// a standing-policy card whose policy has no actuator told to "re-run it to try again".
		const swept = [...found.keys()].filter((type) => isOrphanedByRunnerReconnect(type));
		expect(swept).toEqual([]);
	});
});

describe("the cloud sweep expires exactly what the runner's own restart expires", () => {
	/**
	 * `Runner.execute()` is the whole of what the runner process runs itself — it throws
	 * `Unknown task type` for anything else — so those types, minus the ones the runner
	 * deliberately preserves, ARE the orphanable set. Scanned rather than imported: importing
	 * `runner.ts` drags Playwright into a unit test.
	 */
	const runnerSrc = readFileSync(
		join(__dirname, "../../../../packages/browser-runner/src/runner.ts"),
		"utf8",
	);
	const start = runnerSrc.indexOf("private async execute(");
	const end = runnerSrc.indexOf("Unknown task type", start);
	const dispatched = [...runnerSrc.slice(start, end).matchAll(/task\.type === "([^"]+)"/g)].map((m) => m[1]);

	it("found the runner's dispatch to compare against", () => {
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		expect(dispatched.length).toBeGreaterThan(0);
	});

	it("is the runner's executable types minus the ones the runner keeps across a restart", () => {
		const expected = dispatched.filter((type) => !WORKFLOW_DRIVEN_TASKS.has(type)).sort();
		expect([...ORPHANABLE_TASK_TYPES]).toEqual(expected);
	});

	// The drift that was live when #567 was written: the runner's list had three entries and the
	// API's had two, so a `browser.handoff` — the takeover the runner mints for an engine sign-in —
	// was expired by the cloud on the next `pags up` while the runner kept it.
	it("never expires a task the runner preserves", () => {
		const swept = [...WORKFLOW_DRIVEN_TASKS].filter((type) => isOrphanedByRunnerReconnect(type));
		expect(WORKFLOW_DRIVEN_TASKS.size).toBe(3);
		expect(swept).toEqual([]);
	});
});

describe("an unclassified type is left alone", () => {
	it("answers cloud, not runner, for a type nobody has heard of", () => {
		expect(runtimeTaskOwner("some.future.card")).toBe("cloud");
		expect(isOrphanedByRunnerReconnect("some.future.card")).toBe(false);
	});

	it("is the whole point of the inversion: the fail-safe direction is 'do not touch it'", () => {
		// Under the old denylist this returned true for every type not named in it.
		expect(isOrphanedByRunnerReconnect("coding.session")).toBe(false);
		expect(isOrphanedByRunnerReconnect("browser.open")).toBe(true);
	});
});

describe("the reason names what actually died", () => {
	it("says 'browser session' only for the one orphanable type that holds a page", () => {
		expect(orphanedTaskReason("browser.open")).toContain("browser session");
		for (const type of ORPHANABLE_TASK_TYPES.filter((t) => t !== "browser.open")) {
			expect(orphanedTaskReason(type)).not.toContain("browser");
		}
	});
});
