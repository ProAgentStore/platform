import { describe, expect, it } from "vitest";
import { engineAuthRefusalDetail, recordEngineAuthRefusal } from "./engine-auth-refusal.js";
import type { Env } from "../types.js";

function captureDb() {
	const writes: Array<{ q: string; args: unknown[] }> = [];
	const env = {
		DB: {
			prepare: (q: string) => ({
				bind: (...args: unknown[]) => ({
					async run() {
						writes.push({ q, args });
						return { meta: { changes: 1 } };
					},
				}),
			}),
		},
	} as unknown as Env;
	return { env, writes };
}

describe("recordEngineAuthRefusal (#891)", () => {
	it("records the run already finished as `engine_auth`, on the session it would have driven", async () => {
		const { env, writes } = captureDb();
		const runId = await recordEngineAuthRefusal(env, {
			instanceId: "i1",
			userId: "u1",
			objective: "fix the thing",
			maxIterations: 10,
			budgetId: "b1",
			sessionId: "csess_1",
			preflightMessage: "Codex is installed on machine \"mac\" but not signed in there.",
		});
		const insert = writes.find((w) => w.q.includes("INSERT INTO agent_loop_runs"));
		expect(insert?.args).toEqual(expect.arrayContaining([runId, "u1", "i1", "fix the thing", 10, "b1", "csess_1"]));
		const finish = writes.find((w) => w.q.includes("UPDATE agent_loop_runs"));
		// `status` is derived from the stop reason: `engine_auth` needs a human, it did not fail.
		expect(finish?.args.slice(0, 3)).toEqual([runId, "needs_human", "engine_auth"]);
		expect(String(finish?.args[3])).toContain("not signed in");
	});

	it("says nothing ran, and how to pick it back up", () => {
		const detail = engineAuthRefusalDetail("Codex is not signed in.");
		expect(detail).toMatch(/^Refused before the first turn: Codex is not signed in\./);
		expect(detail).toContain("no iteration was spent");
		expect(detail).toContain("continue_instance_run");
		expect(detail).not.toMatch(/api[ _-]?key/i);
	});
});
