import { describe, expect, it } from "vitest";
import { applyTaskEnvelope } from "./apply.js";
import { browserModelRunnerProblem } from "./model-config.js";
import { mergeRunnerSettings, RUNNER_DEFAULTS } from "./policy.js";
import type { ApplyRun } from "./store.js";
import type { JobApplication } from "../local-artifact/store.js";

describe("browser model configuration (#1511)", () => {
	it("keeps arbitrary provider model IDs and explicit effort, independently of supervisor settings", () => {
		const result = mergeRunnerSettings(RUNNER_DEFAULTS, { engine: "codex", model: "provider/future-model-42", reasoningEffort: "high" });
		expect(result).toMatchObject({ settings: { engine: "codex", model: "provider/future-model-42", reasoningEffort: "high" } });
		if (!("settings" in result)) throw new Error("settings rejected");
		expect(mergeRunnerSettings(result.settings, { engine: "claude" })).toMatchObject({ error: expect.stringContaining("clear it with null") });
		expect(mergeRunnerSettings(result.settings, { engine: "claude", model: null, reasoningEffort: null })).toMatchObject({ settings: { engine: "claude", model: null, reasoningEffort: null } });
	});
	it.each([{ model: "" }, { model: "model\n--flag" }, { reasoningEffort: "" }, { reasoningEffort: 3 }, { engine: "claude", reasoningEffort: "high" }])("refuses invalid or unsupported configuration %j", (patch) => {
		expect(mergeRunnerSettings(RUNNER_DEFAULTS, patch)).toHaveProperty("error");
	});
	it("requires proof that the runner supports explicit model configuration", () => {
		expect(browserModelRunnerProblem({}, "0.4.208")).toBeNull();
		for (const version of [null, "0.4.214"]) expect(browserModelRunnerProblem({ model: "future-model" }, version)).toMatch(/silently ignore/);
		expect(browserModelRunnerProblem({ reasoningEffort: "high" }, "0.4.215")).toBeNull();
	});
	it("dispatches the frozen run model even after the instance settings change", () => {
		const run = { policy: { engine: "codex", model: "original-model", reasoningEffort: "high", mode: "fill_and_review", allowDomains: ["example.com"], gate: {}, limits: {} } } as unknown as ApplyRun;
		const app = { lead: { leadUrl: "https://example.com/job" } } as JobApplication;
		const envelope = applyTaskEnvelope(run, app, { ...RUNNER_DEFAULTS, engine: "claude", model: "changed-model" });
		expect(envelope).toMatchObject({ engine: "codex", model: "original-model", reasoningEffort: "high" });
		delete run.policy.model;
		delete run.policy.reasoningEffort;
		expect(applyTaskEnvelope(run, app, { ...RUNNER_DEFAULTS, model: "new-model" })).toMatchObject({ model: null, reasoningEffort: null });
	});
});
