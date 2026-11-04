import { describe, expect, it } from "vitest";
import { RUNNER_DEFAULTS, mergeRunnerSettings } from "./policy.js";
import { LOCAL_APPLY_FULL_TOOLS_REVISION, parseLocalApplyEvent, parseLocalApplyResult } from "./contract.js";
import { acknowledgeFullBrowserTools, queuedToolAccessProblem, toolAccessRunnerProblem } from "./tool-access.js";

const owner = { uid: "owner", instanceId: "runner" };
const acceptedAt = "2026-11-05T01:00:00.000Z";
const full = { ...RUNNER_DEFAULTS, toolAccess: "full" as const };
const receipt = { revision: LOCAL_APPLY_FULL_TOOLS_REVISION, acceptedAt, acceptedBy: owner.uid, instanceId: owner.instanceId };
const accepted = { ...full, toolAccessAcceptance: receipt };

describe("full browser tools require explicit, scoped acceptance independently of submission permission", () => {
	it("fails without exact current revision, stamps provenance, and leaves auto-submit off", () => {
		expect(acknowledgeFullBrowserTools(RUNNER_DEFAULTS, full, true, owner, acceptedAt)).toHaveProperty("error");
		expect(acknowledgeFullBrowserTools(RUNNER_DEFAULTS, full, "old", owner, acceptedAt)).toHaveProperty("error");
		expect(acknowledgeFullBrowserTools(RUNNER_DEFAULTS, full, undefined, owner, acceptedAt)).toHaveProperty("error");
		expect(acknowledgeFullBrowserTools(RUNNER_DEFAULTS, full, LOCAL_APPLY_FULL_TOOLS_REVISION, owner, acceptedAt)).toEqual({ settings: accepted });
		expect(accepted.autoSubmit.enabled).toBe(false);
	});
	it("clears on disable and refuses old, unknown or foreign runners/receipts", () => {
		expect(acknowledgeFullBrowserTools(accepted, RUNNER_DEFAULTS, undefined, owner, acceptedAt)).toEqual({ settings: RUNNER_DEFAULTS });
		for (const version of [null, "0.4.220"]) expect(toolAccessRunnerProblem(accepted, version, owner)).toContain("0.4.221");
		expect(toolAccessRunnerProblem(accepted, "0.4.221", owner)).toBeNull();
		expect(toolAccessRunnerProblem(accepted, "0.4.221", { ...owner, uid: "other" })).toContain("this owner and instance");
		expect(toolAccessRunnerProblem(accepted, "0.4.221", { ...owner, instanceId: "other" })).toContain("this owner and instance");
		expect(toolAccessRunnerProblem(RUNNER_DEFAULTS, null, owner)).toBeNull();
		expect(mergeRunnerSettings(RUNNER_DEFAULTS, { toolAccess: "anything" })).toHaveProperty("error");
	});
	it("revokes old queued acceptance after disabling or renewing but not unrelated settings changes", () => {
		const unrelatedChange = { ...accepted, escalationLevel: "autonomous" };
		expect(queuedToolAccessProblem(accepted, unrelatedChange)).toBeNull();
		expect(queuedToolAccessProblem(accepted, RUNNER_DEFAULTS)).toContain("revoked or replaced");
		expect(queuedToolAccessProblem(accepted, { ...accepted, toolAccessAcceptance: { ...receipt, acceptedAt: "2026-11-06T01:00:00.000Z" } })).toContain("revoked or replaced");
	});
	it("retains uncertainty evidence and only typed native-tool trace metadata", () => {
		const parsed = parseLocalApplyResult({ runId: "r", outcome: "awaiting_review", mode: "fill_and_review", traceId: "t", engineAuth: "machine-login", filled: 0, uploaded: [], submitAttempted: false, submissionVerification: "unverified", summary: "Inspect the site." });
		expect(parsed).toMatchObject({ result: { submissionVerification: "unverified", submitAttempted: false } });
		const event = parseLocalApplyEvent({ seq: 1, type: "policy.decision", at: acceptedAt, detail: { toolAccess: "full", nativeToolCount: 35 } });
		expect(event?.detail).toEqual({ toolAccess: "full", nativeToolCount: 35 });
		expect(parseLocalApplyEvent({ seq: 1, type: "policy.decision", at: acceptedAt, detail: { toolAccess: "secret text", nativeToolCount: -1 } })?.detail ?? {}).toEqual({});
	});
});
