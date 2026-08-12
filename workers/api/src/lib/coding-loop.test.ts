import { describe, expect, it } from "vitest";
import {
	runCodingLoop,
	systemPrompt,
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

	it("hands the action itself to onEvent, not only its truncated label (#374)", async () => {
		// The Pilot writes the instruction it drove into `coding_timeline` so the Co-pilot thread
		// and the repo history (#257) still record an autonomous run — a record that used to come
		// from the `/message` route the browser Loop relayed through. `describe()` prefixes the
		// kind and cuts at 120 characters, which is right for a step log and wrong for a
		// transcript, so the raw action rides along.
		const long = `refactor ${"the storage layer ".repeat(20)}`.trim();
		const events: Array<{ type: string; message: string; data?: unknown }> = [];
		const { deps } = harness([
			{ action: { kind: "message", text: long } },
			{ finish: { status: "done", detail: "ok" } },
		]);
		deps.onEvent = (type, message, data) => {
			events.push({ type, message, data });
		};
		await runCodingLoop(deps, GOAL);
		const action = events.find((e) => e.type === "action");
		expect(action?.message.length).toBeLessThan(long.length); // the label really is lossy
		expect(action?.data).toEqual({ kind: "message", text: long });
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

	it("never drives an empty instruction into the engine, and tells the brain nothing was sent (#504)", async () => {
		const seen: string[][] = [];
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		const sent: string[] = [];
		const events: Array<[string, string]> = [];
		const decisions: CodingDecision[] = [
			{ action: { kind: "message", text: "" }, truncated: true },
			{ action: { kind: "message", text: "run the tests" } },
			{ finish: { status: "done", detail: "green" } },
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
			onEvent: (type, message) => {
				events.push([type, message]);
			},
		};
		const r = await runCodingLoop(deps, GOAL);
		// The empty one never reached the engine; the real instruction did.
		expect(sent).toEqual(["run the tests"]);
		// The brain is told, in the step log it already reads, and told WHICH failure it was.
		expect(seen[1][0]).toMatch(/^empty instruction not sent \(it was cut off at the model's output limit/);
		// And the owner is told: the run used to show a blank instruction line instead.
		expect(events.some(([t]) => t === "empty")).toBe(true);
		expect(r.outcome).toBe("done");
	});

	it("distinguishes an empty instruction from a truncated one in what it tells the brain", async () => {
		const seen: string[][] = [];
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		const decisions: CodingDecision[] = [
			{ action: { kind: "message", text: "   " } },
			{ finish: { status: "done", detail: "ok" } },
		];
		let i = 0;
		const deps: CodingDeps = {
			snapshot: async () => idle,
			waitIdle: async () => idle,
			act: async () => idle,
			decide: async (p) => {
				seen.push([...p.actionLog]);
				return decisions[Math.min(i++, decisions.length - 1)];
			},
		};
		await runCodingLoop(deps, GOAL);
		expect(seen[1][0]).toMatch(/the brain returned an instruction with no text/);
	});

	it("stops after three empty instructions in a row rather than spending the step budget on them", async () => {
		const { deps, sent } = harness([{ action: { kind: "message", text: "" } }]);
		const r = await runCodingLoop(deps, GOAL, { maxSteps: 30 });
		expect(sent).toEqual([]);
		expect(r.outcome).toBe("failed");
		expect(r.detail).toMatch(/3 empty instructions in a row/);
		expect(r.steps).toBeLessThan(5);
	});

	it("resets the empty-instruction count when an instruction actually goes out", async () => {
		// The run this came from recovered repeatedly, so an empty that is followed by a real
		// instruction must not accumulate toward the limit — otherwise the fix kills working runs.
		const decisions: CodingDecision[] = [
			{ action: { kind: "message", text: "" } },
			{ action: { kind: "message", text: "step one" } },
			{ action: { kind: "message", text: "" } },
			{ action: { kind: "message", text: "step two" } },
			{ action: { kind: "message", text: "" } },
			{ action: { kind: "message", text: "step three" } },
			{ finish: { status: "done", detail: "ok" } },
		];
		let i = 0;
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		const sent: string[] = [];
		const deps: CodingDeps = {
			snapshot: async () => idle,
			waitIdle: async () => idle,
			act: async (a) => {
				sent.push(a.kind === "message" ? a.text : a.kind);
				return idle;
			},
			decide: async () => decisions[Math.min(i++, decisions.length - 1)],
		};
		const r = await runCodingLoop(deps, GOAL);
		expect(sent).toEqual(["step one", "step two", "step three"]);
		expect(r.outcome).toBe("done");
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

describe("systemPrompt — who the terminal means by \"the user\" (#505)", () => {
	it("tells the Pilot that the terminal's \"user\" is itself, not the human", () => {
		// The runner writes the Pilot's instruction as `role: "user"`, so the engine calls its
		// interlocutor "the user" and means the Pilot. A Pilot that relayed that wording back told
		// the owner he had been warned and had chosen — about a bump he was never asked about.
		const p = systemPrompt(GOAL);
		expect(p).toMatch(/WHO IS WHO/);
		expect(p).toMatch(/means YOU, not the human/);
	});

	it("forbids reporting a decision as the human's", () => {
		expect(systemPrompt(GOAL)).toMatch(/NEVER report a decision as the human's/);
	});

	it("requires escalation, not repetition, when the engine objects", () => {
		// The engine's objection in the incident was CORRECT and overriding it broke the deploy.
		// `request_human` is the channel that already exists for "someone else has to decide this".
		const p = systemPrompt(GOAL);
		expect(p).toMatch(/objects to an instruction/);
		expect(p).toMatch(/you may NOT simply repeat it/);
		expect(p).toMatch(/request_human quoting the objection/);
	});
});
