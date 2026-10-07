/** `list_runner_nodes` fits one response and drops nothing silently (#898; measured live at 279,297 chars). */
import { describe, expect, it } from "vitest";
import { WIRE_BUDGET_BYTES, wireBytes } from "../wire-budget.js";
import { runnerNodesPage } from "./runtime.js";

const session = (i: number, status: string) => ({ sessionId: `s-${i}`, instanceId: "i", repoId: "r", repoName: "repo", engine: "claude", status, updatedAt: "2026-10-07", terminalTail: "x".repeat(300) });
const machine = (name: string) => ({
	node: name,
	connected: true,
	instances: Array.from({ length: 40 }, (_, i) => ({ instanceId: `${name}-${i}`, name: `Agent ${i}`, connected: i % 2 === 0 })),
	sessions: [session(0, "active"), session(1, "suspended"), ...Array.from({ length: 400 }, (_, i) => session(i + 2, i % 3 ? "ended" : "error"))],
});

describe("runnerNodesPage", () => {
	const data = { nodes: [machine("pink-laptop"), machine("Macmini.modem"), machine("Mac.modem")] };

	it("fits the budget, lists open sessions, and counts the ended ones", () => {
		const text = runnerNodesPage(data);
		expect(wireBytes(text)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
		const out = JSON.parse(text) as { nodes: Array<{ node: string; sessions: Array<{ status: string }>; endedSessions: number; instances: unknown[] }>; page: { of: number }; endedSessionsNote: string };
		expect(out.page.of).toBe(3);
		expect(out.nodes[0].sessions.map((s) => s.status)).toEqual(["active", "suspended"]);
		expect(out.nodes[0].endedSessions).toBe(400);
		expect(out.nodes[0].instances).toHaveLength(40);
		expect(out.endedSessionsNote).toMatch(/coding_sessions_list/);
	});

	it("reaches every machine by paging", () => {
		const seen: string[] = [];
		let offset: number | undefined;
		for (let i = 0; i < 5; i++) {
			const out = JSON.parse(runnerNodesPage(data, offset)) as { nodes: Array<{ node: string }>; page: { nextOffset: number | null } };
			seen.push(...out.nodes.map((n) => n.node));
			if (out.page.nextOffset === null) break;
			offset = out.page.nextOffset;
		}
		expect(seen).toEqual(["pink-laptop", "Macmini.modem", "Mac.modem"]);
	});

	it("passes an error body through untouched", () => {
		expect(runnerNodesPage({ error: "nope" })).toBe('{"error":"nope"}');
	});
});
