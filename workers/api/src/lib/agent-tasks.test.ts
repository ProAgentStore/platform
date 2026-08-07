import { describe, expect, it } from "vitest";
import type { AgentTask } from "../agent-types.js";
import {
	TASK_INJECT_LIMIT,
	TASK_STALE_DAYS,
	isStale,
	isUserSet,
	renderActiveTasks,
	selectInjectableTasks,
} from "./agent-tasks.js";

const NOW = Date.parse("2026-08-07T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function task(over: Partial<AgentTask> = {}): AgentTask {
	return {
		id: crypto.randomUUID(),
		title: "Ship the thing",
		description: "details",
		status: "pending",
		assignedBy: "self",
		createdAt: daysAgo(1),
		updatedAt: daysAgo(1),
		...over,
	};
}

describe("provenance", () => {
	it("marks only owner-written tasks as user-set", () => {
		expect(isUserSet(task({ assignedBy: "user" }))).toBe(true);
		expect(isUserSet(task({ assignedBy: "self" }))).toBe(false);
		expect(isUserSet(task({ assignedBy: "system" }))).toBe(false);
	});

	it("renders (user-set) in the prompt, where it influences behaviour", () => {
		const block = renderActiveTasks(
			[
				task({ title: "Owner asked", assignedBy: "user" }),
				task({ title: "Agent invented", assignedBy: "self" }),
			],
			NOW,
		);
		expect(block).toContain("Owner asked (user-set):");
		expect(block).toContain("Agent invented:");
		expect(block).not.toContain("Agent invented (user-set)");
	});

	it("carries the do-not-retire rule whenever tasks are injected", () => {
		const block = renderActiveTasks([task()], NOW);
		expect(block).toContain("## Active Tasks");
		expect(block).toContain("(user-set)");
		expect(block).toMatch(/never mark one complete/i);
	});

	it("says nothing at all when there is nothing active", () => {
		expect(renderActiveTasks([], NOW)).toBe("");
		expect(renderActiveTasks([task({ status: "complete" })], NOW)).toBe("");
	});
});

describe("staleness", () => {
	it("keeps a recently touched task in the prompt", () => {
		expect(isStale(task({ updatedAt: daysAgo(TASK_STALE_DAYS - 1) }), NOW)).toBe(false);
	});

	it("stops injecting a task nothing has touched for the cutoff", () => {
		const old = task({ title: "Forgotten", updatedAt: daysAgo(TASK_STALE_DAYS + 1) });
		expect(isStale(old, NOW)).toBe(true);
		expect(renderActiveTasks([old], NOW)).toBe("");
	});

	it("treats a malformed timestamp as stale rather than permanently fresh", () => {
		expect(isStale(task({ updatedAt: "", createdAt: "" }), NOW)).toBe(true);
		expect(isStale(task({ updatedAt: "not-a-date", createdAt: "" }), NOW)).toBe(true);
	});

	it("does not remove a stale task from the store — it is only withheld and counted", () => {
		const tasks = [task(), task({ updatedAt: daysAgo(TASK_STALE_DAYS + 5) })];
		const sel = selectInjectableTasks(tasks, NOW);
		expect(sel.shown).toHaveLength(1);
		expect(sel.stale).toBe(1);
		expect(tasks).toHaveLength(2);
		expect(renderActiveTasks(tasks, NOW)).toContain(
			`1 untouched for over ${TASK_STALE_DAYS} days`,
		);
	});

	it("brings a stale task back the moment it is touched", () => {
		const revived = task({ updatedAt: daysAgo(0) });
		expect(isStale(revived, NOW)).toBe(false);
	});
});

describe("injection cap", () => {
	const many = (n: number) =>
		Array.from({ length: n }, (_, i) =>
			task({ title: `t${i}`, updatedAt: daysAgo(i / 100) }),
		);

	it("injects at most TASK_INJECT_LIMIT, most recently updated first", () => {
		const sel = selectInjectableTasks(many(TASK_INJECT_LIMIT + 7), NOW);
		expect(sel.shown).toHaveLength(TASK_INJECT_LIMIT);
		expect(sel.withheld).toBe(7);
		expect(sel.shown[0].title).toBe("t0");
	});

	it("tells the agent how many it withheld rather than truncating silently", () => {
		const block = renderActiveTasks(many(TASK_INJECT_LIMIT + 3), NOW);
		expect(block).toContain("3 more active");
		expect(block).toContain("get_tasks");
	});

	it("adds no withheld note when everything fits", () => {
		expect(renderActiveTasks([task()], NOW)).not.toContain("not shown here");
	});
});

describe("what counts as active", () => {
	it("injects every non-complete status", () => {
		const block = renderActiveTasks(
			[
				task({ title: "P", status: "pending" }),
				task({ title: "I", status: "in_progress" }),
				task({ title: "B", status: "blocked" }),
				task({ title: "C", status: "complete" }),
			],
			NOW,
		);
		expect(block).toContain("[pending] P");
		expect(block).toContain("[in_progress] I");
		expect(block).toContain("[blocked] B");
		expect(block).not.toContain("[complete] C");
	});
});
