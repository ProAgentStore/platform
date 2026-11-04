import { describe, expect, it } from "vitest";
import type { JobApplication } from "../local-artifact/store.js";
import type { ApplyRun } from "../local-apply/store.js";
import { canRegenerateMissingMaterials } from "./material-recovery.js";

const app = { id: "app", status: "blocked", fillRunId: "run", submitAttemptedAt: null, blockReason: "artifact_changed" } as JobApplication;
function run(): ApplyRun {
	return { id: "run", applicationId: "app", status: "blocked", endedAt: 10, trace: [{ type: "source.read", at: "2026-11-04T00:00:00Z" }], result: { runId: "run", outcome: "blocked", blockReason: "artifact_changed", engineAuth: "unknown", filled: 0, uploaded: [], submitAttempted: false } } as ApplyRun;
}

describe("material recovery cannot erase a browser or submission attempt", () => {
	it("allows only the matching terminal pre-engine material failure", () => {
		expect(canRegenerateMissingMaterials(app, run())).toBe(true);
		expect(canRegenerateMissingMaterials(app, null)).toBe(false);
		for (const patch of [{ status: "paused" }, { endedAt: null }, { id: "other" }, { applicationId: "other" }]) expect(canRegenerateMissingMaterials(app, { ...run(), ...patch } as ApplyRun)).toBe(false);
		expect(canRegenerateMissingMaterials({ ...app, submitAttemptedAt: 1 }, run())).toBe(false);
	});
	it.each([{ engineAuth: "machine-login" }, { filled: 1 }, { uploaded: ["resume"] }, { submitAttempted: true }, { submitAttempted: undefined }, { runId: "other" }, { blockReason: "incomplete" }, { submitted: { at: "now" } }])("refuses conflicting result evidence %j", (patch) => {
		const r = run();
		r.result = { ...(r.result as object), ...patch };
		expect(canRegenerateMissingMaterials(app, r)).toBe(false);
	});
	it.each(["engine.started", "browser.navigated", "policy.decision", "field.filled", "artifact.uploaded", "submit.attempted", "note"])("refuses a %s event even if counters are zero", (type) => {
		const r = run();
		r.trace.push({ type, at: "2026-11-04T00:00:00Z" } as ApplyRun["trace"][number]);
		expect(canRegenerateMissingMaterials(app, r)).toBe(false);
	});
});
