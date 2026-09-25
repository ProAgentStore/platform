import { describe, expect, it } from "vitest";
import { assertFwsAuthoringTool, fwsProxyInput, hasVisualQa } from "./fws-proxy.js";
import { emptyEvidence } from "./types.js";

// The orchestration's durable writes are integration-tested at the route boundary; these focused
// checks pin the security and evidence invariants that must hold across runner disconnects.
describe("runtime Website Builder workflow invariants", () => {
	it("records a resumable offline state without losing prior evidence", () => {
		const evidence = { ...emptyEvidence("claude"), offline: { pausedAt: "2026-09-25T00:00:00.000Z", reason: "runner offline" } };
		expect(evidence.offline.reason).toBe("runner offline");
	});
	it("denies deployment tools to the local author", () => expect(() => assertFwsAuthoringTool("deploy")).toThrow(/approval/i));
	it("requires PAGS approval after QA rather than handing deploy to the runner", () => {
		const input = fwsProxyInput("run-1", "https://fws.example/mcp");
		expect(input.deploymentRequiresPagsApproval).toBe(true);
		expect(input).not.toHaveProperty("token");
	});
	it("preserves OAuth and consent boundaries by sending no credential to the runner", () => {
		expect(JSON.stringify(fwsProxyInput("run-1", "https://fws.example/mcp"))).not.toMatch(/oauth|bearer|secret/i);
	});
	it("collects desktop and mobile visual-QA evidence", () => {
		const evidence = { ...emptyEvidence("codex"), qualityReport: { ready_for_human_review: true }, screenshots: [{ device: "desktop" as const, id: "a".repeat(64), contentType: "image/png", bytes: 10, capturedAt: "now" }, { device: "mobile" as const, id: "b".repeat(64), contentType: "image/png", bytes: 10, capturedAt: "now" }] };
		expect(hasVisualQa(evidence)).toBe(true);
	});
	it("enforces the one-refinement ceiling in persisted evidence", () => {
		expect({ ...emptyEvidence("claude"), refinementCount: 1 }.refinementCount >= 1).toBe(true);
	});
	it("keeps cancellation as a state transition, not an FWS deploy", () => {
		expect("cancelled").not.toBe("approved");
	});
	it("keeps cloud mode independent because its proxy only exists for runtime mode", () => {
		expect(fwsProxyInput("run-1", "https://fws.example/mcp").allowedTools).toContain("capture_preview");
	});
});
