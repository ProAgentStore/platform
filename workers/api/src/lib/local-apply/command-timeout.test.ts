import { describe, expect, it } from "vitest";
import { browserCommandTimeoutRunnerProblem } from "./command-timeout.js";
import { applyTaskEnvelope } from "./apply.js";
import { mergeRunnerSettings, RUNNER_DEFAULTS } from "./policy.js";
import type { ApplyRun } from "./store.js";
import type { JobApplication } from "../local-artifact/store.js";

describe("per-instance browser command timeout", () => {
	it("defaults to 600 seconds and refuses malformed caller deadlines", () => {
		expect(RUNNER_DEFAULTS.browserCommandTimeoutSeconds).toBe(600);
		for (const seconds of [1, 600, 3600]) expect(mergeRunnerSettings(RUNNER_DEFAULTS, { browserCommandTimeoutSeconds: seconds })).toMatchObject({ settings: { browserCommandTimeoutSeconds: seconds } });
		for (const seconds of [0, -1, 3601, 1.5, "600", null, true, NaN, Infinity]) expect(mergeRunnerSettings(RUNNER_DEFAULTS, { browserCommandTimeoutSeconds: seconds })).toHaveProperty("error");
		expect(RUNNER_DEFAULTS.browserCommandTimeoutSeconds).toBe(600);
	});
	it("requires a supporting runner even for the default, preserving legacy recorded policies", () => {
		for (const version of [null, undefined, "invalid", "0.4.224"]) expect(browserCommandTimeoutRunnerProblem(RUNNER_DEFAULTS, version)).toContain("0.4.225");
		expect(browserCommandTimeoutRunnerProblem(RUNNER_DEFAULTS, "0.4.225")).toBeNull();
		expect(browserCommandTimeoutRunnerProblem({}, "0.4.224")).toBeNull();
	});
	it("uses the recorded timeout after settings change while a run is queued", () => {
		const run = { id: "r", instanceId: "i", applicationId: "a", requestId: "q", policy: { mode: "fill_and_review", engine: "codex", browserCommandTimeoutSeconds: 900, allowDomains: ["example.com"], gate: {}, limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 } } } as ApplyRun;
		const app = { lead: {} } as JobApplication;
		expect(applyTaskEnvelope(run, app, { ...RUNNER_DEFAULTS, browserCommandTimeoutSeconds: 1 }).policy.browserCommandTimeoutSeconds).toBe(900);
		delete run.policy.browserCommandTimeoutSeconds;
		expect(applyTaskEnvelope(run, app, RUNNER_DEFAULTS).policy).not.toHaveProperty("browserCommandTimeoutSeconds");
	});
});
