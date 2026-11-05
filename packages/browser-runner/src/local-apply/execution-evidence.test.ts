import { describe, expect, it } from "vitest";
import type { BrowserCallRecord } from "../browser-call-recorder.js";
import type { BrowserTools } from "../local-browser/bridge.js";
import type { ApplyBridge } from "./bridge.js";
import { executionEvidence } from "./execution-evidence.js";
import { parseLocalApplyResult } from "./contract.js";

describe("durable application execution evidence", () => {
	it("does not relabel an executed obsolete response as a request never dispatched", () => {
		const calls = [{ tool: "browser_click", outcome: "tool_error", toolDiagnostic: { kind: "quarantined", phase: "native_response", execution: "settled" } }, { tool: "browser_click", outcome: "tool_error", toolDiagnostic: { kind: "quarantined", phase: "recovery", execution: "pending" } }] as BrowserCallRecord[];
		const tools = { pullCalls: () => ({ calls, dropped: 0, lastSeq: 2 }) } as unknown as BrowserTools;
		expect(executionEvidence({ tools, runId: "r", full: true, timedOut: false }).nativeCalls).toMatchObject({ attempted: 2, notDispatched: 1, failed: 2 });
	});
	it("preserves independent browser and answer failures without calling native actions completed fields", () => {
		const calls = [{ tool: "browser_fill_form", outcome: "ok" }, { tool: "browser_file_upload", outcome: "tool_error", toolDiagnostic: { kind: "request_deadline" } }] as BrowserCallRecord[];
		const tools = { pullCalls: () => ({ calls, dropped: 3, lastSeq: 7 }), recoveryStatus: () => ({ deadlineCount: 2, diagnostic: { execution: "pending" } }) } as unknown as BrowserTools;
		const bridge = { screenshotsDelivered: 2, unresolvedQuestions: ["Required fact"], deferredQuestions: [{ blocking: true }, { blocking: false }] } as unknown as ApplyBridge;
		const evidence = executionEvidence({ tools, bridge, runId: "r", full: true, timedOut: false, engineExit: 0 });
		expect(evidence).toEqual({ schemaVersion: 1, fieldCounts: "unmeasured", nativeCalls: { attempted: 2, succeeded: 1, failed: 1, notDispatched: 0, truncated: false, dropped: 3, coverage: "retained" }, screenshotsDelivered: 2, screenshotRequests: 0, independentScreenshotAvailable: false, blockingQuestions: 1, optionalQuestions: 1, browser: { state: "pending", timeouts: 2 }, causes: ["browser_timeout", "browser_unavailable", "unresolved_answers"] });
		const parsed = parseLocalApplyResult({ runId: "r", traceId: "r", outcome: "blocked", mode: "auto_submit", engineAuth: "machine-login", executionEvidence: { ...evidence, rawPageText: "do not retain", causes: [...evidence.causes, "untrusted prose"] } });
		expect("result" in parsed && parsed.result.executionEvidence).toEqual(evidence);
	});
	it("marks absent recording unavailable and never equates screenshot count with page completion", () => {
		expect(executionEvidence({ runId: "r", full: true, timedOut: true, engineExit: 1 })).toMatchObject({ fieldCounts: "unmeasured", nativeCalls: { coverage: "unavailable" }, browser: { state: "unavailable" }, causes: ["run_timeout", "engine_failure"] });
	});
	it("drops malformed or unbounded diagnostic records on cloud ingestion", () => {
		const evidence = executionEvidence({ runId: "r", full: false, timedOut: false });
		for (const bad of [{ ...evidence, screenshotsDelivered: -1 }, { ...evidence, browser: { state: "injected", timeouts: 0 } }, { ...evidence, nativeCalls: { ...evidence.nativeCalls, attempted: Infinity } }]) {
			const parsed = parseLocalApplyResult({ runId: "r", traceId: "r", outcome: "blocked", mode: "fill_and_review", engineAuth: "unknown", executionEvidence: bad });
			expect("result" in parsed && parsed.result.executionEvidence).toBeUndefined();
		}
	});
});
