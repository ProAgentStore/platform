import { describe, expect, it } from "vitest";
import { observedRunnerWork } from "./runner-work-observation.js";

describe("observedRunnerWork (#1007)", () => {
	it("does not block a restart for retained engines that authoritatively report idle", () => {
		expect(observedRunnerWork({
			sessions: [
				{ sessionId: "csess-retained-claude", alive: true, runState: "idle" },
				{ sessionId: "csess-retained-codex", alive: true, runState: "idle" },
			],
			work: { codingTurns: 0, localRuns: 0, detail: [] },
		})).toEqual([]);
	});

	it("blocks thinking, responding, and tool-executing turns with their exact lifecycle diagnostics", () => {
		expect(observedRunnerWork({
			sessions: [
				{ sessionId: "csess-think", alive: true, runState: "thinking" },
				{ sessionId: "csess-reply", alive: true, runState: "responding" },
				{ sessionId: "csess-tool", alive: true, runState: "tool-executing" },
			],
			work: { codingTurns: 3, localRuns: 0, detail: ["ignored", "ignored", "ignored"] },
		})).toEqual([
			"coding session csess-think (thinking)",
			"coding session csess-reply (responding)",
			"coding session csess-tool (tool-executing)",
		]);
	});

	it("fails closed for unavailable or malformed observations", () => {
		expect(observedRunnerWork({ work: { codingTurns: 0, localRuns: 0, detail: [] } })).toEqual(["runner-work-observation-unavailable"]);
		expect(observedRunnerWork({ sessions: [], work: { codingTurns: 0, localRuns: 0, detail: "not-an-array" } })).toEqual(["runner-work-observation-unavailable"]);
		expect(observedRunnerWork({
			sessions: [{ sessionId: "csess-unreadable", alive: true }],
			work: { codingTurns: 1, localRuns: 0, detail: ["ignored"] },
		})).toEqual(["coding session csess-unreadable (unknown)"]);
	});

	it("continues to protect browser, artifact, and application runs", () => {
		expect(observedRunnerWork({
			sessions: [],
			work: {
				codingTurns: 0,
				localRuns: 3,
				detail: ["local browser run browser-1", "local artifact run artifact-1", "local application run apply-1"],
			},
		})).toEqual(["local browser run browser-1", "local artifact run artifact-1", "local application run apply-1"]);
	});
});
