/**
 * A woken run's objective is the TRIGGER's composition, and the engine is told so (#1019).
 *
 * `startWakeLoop` composes the standing wiring with facts about another agent's run. That is not a
 * message from the owner, so the driver must receive a `trigger` origin — the runner then attributes it
 * accordingly instead of calling it the owner's objective. Real schema; only the driver is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const driverStart = vi.fn();
vi.mock("./loop-drivers.js", async () => {
	const actual = await vi.importActual<typeof import("./loop-drivers.js")>("./loop-drivers.js");
	return { ...actual, loopDriverFor: () => ({ id: "coding", label: "coding", start: (...a: unknown[]) => driverStart(...a) }) };
});
const { startWakeLoop } = await import("./run-wake-start.js");

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["lead", "worker"] });
	driverStart.mockReset();
	driverStart.mockResolvedValue({ ok: true, runId: "run-woken", driver: "coding" });
});
afterEach(() => d1.close());

describe("startWakeLoop — the objective's origin (#1019)", () => {
	it("a wake composed from another agent's finished run reaches the driver as a TRIGGER objective, never the owner's", async () => {
		const payload = { event: "run.finished", instanceId: "worker", runId: "run-7", status: "completed" };
		const res = await startWakeLoop({ DB: d1.DB } as unknown as Env, { instance_id: "lead", user_id: "u1" }, payload, { objective: "Review what the worker shipped." } as never, {});
		expect(res).toMatchObject({ started: true });
		const input = driverStart.mock.calls[0][0] as { objective: string; objectiveOrigin?: { kind: string; by?: string } };
		expect(input.objective).toContain("Review what the worker shipped.");
		expect(input.objective).toContain("run run-7");
		expect(input.objectiveOrigin).toEqual({ kind: "trigger", by: "run.finished from agent worker" });
	});
});
