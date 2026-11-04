import { describe, expect, it } from "vitest";
import { applyTaskEnvelope } from "./apply.js";
import { checkpointDecisionEvent, decideCheckpoint } from "./brain.js";
import { escalationRunnerProblem } from "./escalation-config.js";
import { mergeRunnerSettings, RUNNER_DEFAULTS } from "./policy.js";
import { sanitizeSupervisorFacts, type SupervisorCheckpoint } from "./supervision.js";
import type { ApplyRun } from "./store.js";
import { parseLocalApplyEvent, type LocalApplyEscalationLevel } from "./contract.js";
import type { JobApplication } from "../local-artifact/store.js";

const run = (escalationLevel?: LocalApplyEscalationLevel): ApplyRun => ({
	id: "run-1", instanceId: "runner-1", applicationId: "app-1", requestId: "request-1", status: "paused",
	policy: { escalationLevel, engine: "codex", authMode: "machine", browserProfile: "isolated", mode: "fill_and_review", gate: { allowed: false, gateId: null, checks: [] }, allowDomains: ["example.com"], limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 } },
	pause: null, result: null, engineAuth: null, errorCode: null, error: null, runnerNode: "mac", runnerVersion: "0.4.220",
	trace: [], runnerSeq: 3, lastSyncedAt: null, createdAt: 1, startedAt: 1, endedAt: null,
});
const checkpoint = (risk: "minor" | "major" = "minor"): SupervisorCheckpoint => ({
	runId: "run-1", instanceId: "runner-1", checkpointId: "decision-1", schemaVersion: 1, runnerSeq: 3, receivedAt: 1, directive: null,
	facts: { phase: "uncertain", actions: 3, filled: 1, uploaded: 0, blockers: [], decision: { risk, reason: "The visible option preserves the source meaning." } },
});

describe("owner escalation thresholds", () => {
	it("defaults old settings to conservative and refuses malformed settings without touching submission policy", () => {
		expect(RUNNER_DEFAULTS.escalationLevel).toBe("conservative");
		for (const escalationLevel of ["conservative", "balanced", "autonomous"] as const) {
			expect(mergeRunnerSettings(RUNNER_DEFAULTS, { escalationLevel })).toMatchObject({ settings: { escalationLevel, autoSubmit: { enabled: false } } });
		}
		for (const escalationLevel of [null, "never", "", true, 1]) expect(mergeRunnerSettings(RUNNER_DEFAULTS, { escalationLevel })).toHaveProperty("error");
	});
	it("requires a supporting CLI for nondefault settings, including unknown versions", () => {
		for (const escalationLevel of ["balanced", "autonomous"] as const) {
			for (const version of [null, undefined, "0.4.219", "invalid"]) expect(escalationRunnerProblem({ escalationLevel }, version)).toContain("0.4.220");
			expect(escalationRunnerProblem({ escalationLevel }, "0.4.220")).toBeNull();
		}
		expect(escalationRunnerProblem({}, null)).toBeNull();
		expect(escalationRunnerProblem({ escalationLevel: "conservative" }, "0.4.219")).toBeNull();
	});
	it("dispatches the run's frozen setting after instance settings change, and never upgrades old runs", () => {
		const app = { lead: { leadUrl: "https://example.com/job" } } as JobApplication;
		expect(applyTaskEnvelope(run("balanced"), app, { ...RUNNER_DEFAULTS, escalationLevel: "autonomous" }).policy.escalationLevel).toBe("balanced");
		expect(applyTaskEnvelope(run(), app, { ...RUNNER_DEFAULTS, escalationLevel: "autonomous" }).policy.escalationLevel).toBe("conservative");
	});
	it.each([
		["conservative", "minor", "request_review"], ["conservative", "major", "request_review"],
		["balanced", "minor", "continue"], ["balanced", "major", "request_review"],
		["autonomous", "minor", "continue"], ["autonomous", "major", "continue"],
	] as const)("%s handles an assessed %s decision as %s regardless of the cloud proposal", (level, risk, directive) => {
		for (const proposed of [null, "continue", "request_review", "stop"] as const) expect(decideCheckpoint(run(level), checkpoint(risk), proposed)).toMatchObject({ directive, source: "policy", escalationLevel: level });
	});
	it("never continues unassessed or malformed uncertainty, even in autonomous mode", () => {
		for (const decision of [undefined, null, { risk: "minor", reason: " " }, { risk: "low", reason: "why" }, { risk: "minor", reason: "x".repeat(1001) }]) {
			const c = checkpoint();
			c.facts.decision = decision as never;
			expect(decideCheckpoint(run("autonomous"), c, "continue")).toMatchObject({ directive: "request_review", reason: "unknown_phase_needs_review" });
		}
	});
	it("keeps blockers and explicit submission gates ahead of autonomy", () => {
		for (const blocker of ["captcha", "login_required", "anti_bot", "missing_answer", "screening_ambiguity", "external_redirect", "duplicate_application"] as const) {
			const c = checkpoint(); c.facts.blockers = [blocker];
			expect(decideCheckpoint(run("autonomous"), c, "continue")).toMatchObject({ directive: "stop", reason: "blocker" });
		}
		const c = checkpoint(); c.facts.phase = "before_submit";
		expect(decideCheckpoint(run("autonomous"), c, "continue")).toMatchObject({ directive: "request_review", reason: "fill_and_review_never_submits" });
		const r = run("autonomous"); r.policy.mode = "auto_submit";
		expect(decideCheckpoint(r, c, "continue")).toMatchObject({ directive: "request_review", reason: "no_submit_authorization" });
	});
	it("validates and retains labelled model assessment while stripping unrelated payload fields", () => {
		const c = checkpoint();
		expect(sanitizeSupervisorFacts({ ...c.facts, decision: { ...c.facts.decision, source_quote: "private source" } })?.decision).toEqual(c.facts.decision);
		for (const decision of [null, [], { risk: "major", reason: "" }, { risk: "minor", reason: "x".repeat(1001) }]) expect(sanitizeSupervisorFacts({ ...c.facts, decision })).toBeNull();
		const { decision: _ignored, ...legacy } = c.facts;
		expect(sanitizeSupervisorFacts(legacy)).toEqual(legacy);
	});
	it("retains bounded decision receipts through runner event sanitization without admitting source quotes", () => {
		const event = (detail: Record<string, unknown>) => parseLocalApplyEvent({ type: "policy.decision", at: "2026-11-05T00:00:00Z", detail });
		expect(event({ escalationLevel: "balanced", decisionRisk: "minor", decisionReason: "why", source_quote: "private" })?.detail).toEqual({ escalationLevel: "balanced", decisionRisk: "minor", decisionReason: "why" });
		expect(event({ escalationLevel: "invalid", decisionRisk: "low", decisionReason: "x".repeat(1001) })?.detail).toBeUndefined();
		expect(event({ decisionReason: " " })?.detail).toBeUndefined();
		const sourceId = `source-${"a".repeat(64)}`;
		expect(event({ sourceId })?.detail).toEqual({ sourceId });
		for (const sourceId of ["source-page-claim", "private source text", 123, `source-${"a".repeat(65)}`]) expect(event({ sourceId })?.detail).toBeUndefined();
	});
	it("records the threshold, model risk and bounded explanation in the decision trace", () => {
		const c = checkpoint();
		const event = checkpointDecisionEvent(c, decideCheckpoint(run("balanced"), c, null), "now");
		expect(event.detail).toMatchObject({ escalationLevel: "balanced", decisionRisk: "minor", decisionReason: c.facts.decision?.reason, reason: "escalation_allows_decision" });
		expect(event.detail).not.toHaveProperty("source_quote");
	});
});
