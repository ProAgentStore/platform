import { describe, expect, it } from "vitest";
import type { MachineDetail } from "./machineDetail";
import { machineRollbacks, noRollbackNote, retryableRollback, rollbackLine } from "./machineRollbacks";

const base: MachineDetail = { machineId: "m1", latest_version: "0.4.150", rollbacks: [
	{ from: "0.4.149", to: "0.4.148", reason: "it crashed on start.", at: "2026-10-20T01:00:00.000Z" },
	{ from: "0.4.150", to: "0.4.148", reason: "it did not register with the platform within 5 minutes of first starting", at: "2026-10-25T01:00:00.000Z" },
] };

describe("machine rollbacks (#1150)", () => {
	it("lists the newest first, and nothing for an older API", () => {
		expect(machineRollbacks(base).map((r) => r.from)).toEqual(["0.4.150", "0.4.149"]);
		expect(machineRollbacks({ machineId: "m1" })).toEqual([]);
		expect(machineRollbacks({ machineId: "m1", rollbacks: null })).toEqual([]);
	});
	it("a retry exists only for the rolled-back release that is the latest one", () => {
		expect(retryableRollback(base)?.from).toBe("0.4.150");
		expect(retryableRollback({ ...base, latest_version: "0.4.151" })).toBeNull();
		expect(retryableRollback({ ...base, latest_version: null })).toBeNull();
		expect(retryableRollback({ machineId: "m1", latest_version: "0.4.150" })).toBeNull();
	});
	it("says from, to and why in one sentence", () => {
		expect(rollbackLine(base.rollbacks?.[0] ?? { from: "", to: null, reason: "", at: null })).toBe("0.4.149 was rolled back to 0.4.148: it crashed on start.");
		expect(rollbackLine({ from: "0.4.150", to: null, reason: "crash loop", at: null })).toBe("0.4.150 was rolled back: crash loop.");
	});
});

describe("a machine that updates in place (#1147)", () => {
	it("is told so, and a stub machine or an unreported one is not", () => {
		expect(noRollbackNote({ machineId: "m1", rollback_available: false })).toMatch(/updates in place.*not running under the bootstrap stub/);
		expect(noRollbackNote({ machineId: "m1", rollback_available: true })).toBeNull();
		expect(noRollbackNote({ machineId: "m1", rollback_available: null })).toBeNull();
		expect(noRollbackNote({ machineId: "m1" })).toBeNull();
	});
});
