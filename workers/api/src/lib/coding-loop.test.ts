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

	// ── Merge authority (#314) ────────────────────────────────────────────────
	//
	// The literal shape of run 73ffc073: one objective saying "merge each before starting the next",
	// relayed to the Engine three times because nothing decided whether it was allowed to.

	it("relays a merge order untouched under the default policy", async () => {
		const { deps, sent } = harness([
			{ action: { kind: "message", text: "Merge PR #150 with --squash" } },
			{ finish: { status: "done", detail: "merged" } },
		]);
		const r = await runCodingLoop(deps, GOAL);
		expect(sent).toEqual(["Merge PR #150 with --squash"]);
		expect(r.outcome).toBe("done");
	});

	it("refuses to relay a merge order under policy pr, and tells the brain in its own step log", async () => {
		const seen: string[][] = [];
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		const sent: string[] = [];
		const decisions: CodingDecision[] = [
			{ action: { kind: "message", text: "Merge PR #150 with --squash" } },
			{ action: { kind: "message", text: "Open the PR and stop there" } },
			{ finish: { status: "done", detail: "PR open, merge left to the owner" } },
		];
		let i = 0;
		const deps: CodingDeps = {
			snapshot: async () => idle,
			waitIdle: async () => idle,
			act: async (a) => {
				sent.push(a.kind === "message" ? a.text : a.kind);
				return idle;
			},
			decide: async (p) => {
				seen.push([...p.actionLog]);
				return decisions[Math.min(i++, decisions.length - 1)];
			},
		};
		const r = await runCodingLoop(deps, { ...GOAL, mergePolicy: "pr" });
		// The merge never reached the Engine; the compliant follow-up did.
		expect(sent).toEqual(["Open the PR and stop there"]);
		// The refusal is fed back through the log the loop already shows the brain, so it adapts.
		expect(seen[1][0]).toMatch(/^refused \(merge authority\)/);
		expect(r.outcome).toBe("done");
	});

	it("finishes with the reason rather than burning the step budget on a brain that will not stop", async () => {
		const { deps, sent } = harness([{ action: { kind: "message", text: "just merge it" } }]);
		const r = await runCodingLoop(deps, { ...GOAL, mergePolicy: "pr" }, { maxSteps: 30 });
		expect(sent).toEqual([]);
		expect(r.outcome).toBe("failed");
		expect(r.detail).toMatch(/not permitted/i);
		expect(r.steps).toBeLessThan(5);
	});

	it("carries a stop reason out of a halt, so a policy halt is not mistaken for the Stop button", async () => {
		const { deps } = harness([{ action: { kind: "message", text: "x" } }], {
			cancelled: true,
			stopReason: "Not permitted by this repository's merge policy (pr): the agent merged a pull request #150.",
		});
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("cancelled");
		expect(r.detail).toContain("merge policy");
	});
});
