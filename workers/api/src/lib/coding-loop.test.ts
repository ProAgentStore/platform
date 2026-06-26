import { describe, expect, it } from "vitest";
import {
	runCodingLoop,
	type CodingDecision,
	type CodingDeps,
	type CodingGoal,
	type CodingPaneSnapshot,
} from "./coding-loop.js";

const GOAL: CodingGoal = { objective: "add a test", repo: "demo", clientType: "claude" };

/** Build deps that return a scripted sequence of decisions; record actions sent. */
function harness(decisions: CodingDecision[], paneState: Partial<CodingPaneSnapshot> = {}) {
	const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true, ...paneState };
	const sent: string[] = [];
	let i = 0;
	const deps: CodingDeps = {
		snapshot: async () => idle,
		waitIdle: async () => idle,
		act: async (a) => {
			sent.push(a.kind === "message" ? a.text : a.kind);
			return idle;
		},
		decide: async () => decisions[Math.min(i++, decisions.length - 1)],
	};
	return { deps, sent };
}

describe("runCodingLoop", () => {
	it("sends instructions then finishes done", async () => {
		const { deps, sent } = harness([
			{ action: { kind: "message", text: "write the test" } },
			{ finish: { status: "done", detail: "test added" } },
		]);
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("done");
		expect(r.detail).toBe("test added");
		expect(sent).toEqual(["write the test"]);
	});

	it("surfaces a stuck handoff", async () => {
		const { deps } = harness([{ stuck: { why: "interactive login needed" } }]);
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("stuck");
		expect(r.detail).toBe("interactive login needed");
	});

	it("surfaces needs_input with the field", async () => {
		const { deps } = harness([{ needsInput: { field: "DEPLOY_TOKEN", why: "required to push" } }]);
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("needs_input");
		expect(r.fieldNeeded).toBe("DEPLOY_TOKEN");
	});

	it("treats a decision with no action and no verdict as stuck", async () => {
		const { deps } = harness([{ thought: "unsure" }]);
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("stuck");
	});

	it("halts immediately when cancelled", async () => {
		const { deps } = harness([{ action: { kind: "message", text: "x" } }], { cancelled: true });
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("cancelled");
	});

	it("fails when the session is not alive", async () => {
		const { deps } = harness([{ action: { kind: "message", text: "x" } }], { alive: false });
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("failed");
	});

	it("stops at max_steps when the brain never finishes", async () => {
		const { deps, sent } = harness([{ action: { kind: "message", text: "loop" } }]);
		const r = await runCodingLoop(deps, GOAL, { maxSteps: 3 });
		expect(r.outcome).toBe("max_steps");
		expect(sent.length).toBe(3);
	});

	it("waits for the CLI to go idle before deciding", async () => {
		let snaps = 0;
		const busy: CodingPaneSnapshot = { pane: "Working…", runState: "thinking", ready: false, alive: true };
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		let waited = false;
		const deps: CodingDeps = {
			snapshot: async () => (snaps++ === 0 ? busy : idle),
			waitIdle: async () => {
				waited = true;
				return idle;
			},
			act: async () => idle,
			decide: async () => ({ finish: { status: "done", detail: "ok" } }),
		};
		const r = await runCodingLoop(deps, GOAL);
		expect(waited).toBe(true);
		expect(r.outcome).toBe("done");
	});
});
