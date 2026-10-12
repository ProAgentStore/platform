import { describe, expect, it } from "vitest";
import { decideTurnRecovery, describeTurnRecovery, recoveryInputId, recoveryInstruction, turnRecoveryRecord, type InflightTurn } from "./coding-turn-recovery.js";

const turn = (over: Partial<InflightTurn> = {}): InflightTurn => ({ inputId: "act:run-1:s3-act", ledger: "L1", epoch: 0, node: "n1", receipt: "accepted", sentAt: Date.parse("2026-10-13T00:00:00Z"), recovery: false, ...over });
const engine = (ledger: string, epoch: number, consumed: Array<[string, number]> = []) => ({ ledger, epoch, accepted: [], consumed });

describe("decideTurnRecovery (#1053)", () => {
	it.each([
		["an older runner reports no ledger", turn(), { alive: true }, { decision: "intact", reason: "unverifiable_runner" }],
		["the turn had no ledger to compare", turn({ ledger: null }), { alive: true, engine: engine("L2", 0) }, { decision: "intact", reason: "unverifiable_runner" }],
		["a completed turn read it — failed turns are consumed too", turn(), { alive: true, engine: engine("L1", 0, [["act:run-1:s3-act", 0]]) }, { decision: "intact", reason: "consumed" }],
		["read by a later process of the ledger", turn(), { alive: true, engine: engine("L1", 1, [["act:run-1:s3-act", 1]]) }, { decision: "intact", reason: "consumed" }],
		["the legacy consumedInputs list says it was read", turn(), { alive: true, engine: engine("L2", 0), consumedInputs: ["act:run-1:s3-act"] }, { decision: "intact", reason: "consumed" }],
		["the same process is still there (a turn WE killed lands here too)", turn(), { alive: true, engine: engine("L1", 0) }, { decision: "intact", reason: "same_process" }],
		["the runner holds different content under the id", turn({ receipt: "conflict" }), { alive: true, engine: engine("L2", 0) }, { decision: "block", reason: "content_conflict" }],
		["another machine answers — its checkout cannot show the lost turn", turn({ node: "n0" }), { alive: true, engine: engine("L2", 0) }, { decision: "block", reason: "machine_changed" }],
		["no engine came back", turn(), { alive: false, engine: engine("L2", 0) }, { decision: "block", reason: "engine_absent" }],
		["the recovery itself was lost", turn({ recovery: true }), { alive: true, engine: engine("L3", 0) }, { decision: "block", reason: "recovery_lost" }],
		["the runner restarted (new ledger)", turn(), { alive: true, engine: engine("L2", 0) }, { decision: "resume", reason: "engine_replaced", resumeInputId: "act:run-1:s3-act:recover" }],
		["the engine process was relaunched (new epoch)", turn(), { alive: true, engine: engine("L1", 1) }, { decision: "resume", reason: "engine_replaced", resumeInputId: "act:run-1:s3-act:recover" }],
	] satisfies Array<[string, InflightTurn, Parameters<typeof decideTurnRecovery>[1], ReturnType<typeof decideTurnRecovery>]>)("%s", (_label, t, pane, expected) => {
		expect(decideTurnRecovery(t, pane, "n1")).toEqual(expected);
	});

	it("the recovery id is deterministic, so a retry or replay is refused by the ledger", () => {
		expect(recoveryInputId("x")).toBe(recoveryInputId("x"));
	});

	it("the recovery turn names the cut-off turn and asks what took effect — it never repeats the command", () => {
		const text = recoveryInstruction(turn());
		expect(text).toMatch(/^\[platform\] Your previous turn \(act:run-1:s3-act\) was cut off[\s\S]*Do not redo it[\s\S]*git status[\s\S]*what remains/);
	});

	it("the diagnostic record correlates both engines and names the safe next action", () => {
		const d = decideTurnRecovery(turn(), { alive: false, engine: engine("L2", 0) }, "n1");
		const r = turnRecoveryRecord(turn(), { alive: false, engine: engine("L2", 0) }, d, { runId: "run-1", sessionId: "s1", node: "n1", detectedAt: Date.parse("2026-10-13T00:05:00Z") });
		expect(r).toEqual({
			runId: "run-1",
			sessionId: "s1",
			turnInputId: "act:run-1:s3-act",
			recoveryInputId: null,
			decision: "block",
			reason: "engine_absent",
			receipt: "accepted",
			before: { ledger: "L1", epoch: 0, node: "n1" },
			after: { ledger: "L2", epoch: 0, node: "n1", alive: false },
			restarted: true,
			sentAt: "2026-10-13T00:00:00.000Z",
			detectedAt: "2026-10-13T00:05:00.000Z",
			safeAction: expect.stringMatching(/pags up/),
		});
		expect(describeTurnRecovery(r)).toMatch(/^\*\*Lost engine turn\*\* — turn `act:run-1:s3-act` did not finish \(engine absent\); the run stops here \(turn_lost\)\. Sent 2026-10-13T00:00:00\.000Z, detected 2026-10-13T00:05:00\.000Z\. Next: /);
	});
});
