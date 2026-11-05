import type { BrowserTools } from "../local-browser/bridge.js";
import type { BrowserCallRecord } from "../browser-call-recorder.js";
import type { ApplyBridge } from "./bridge.js";
import type { LocalApplyExecutionEvidence } from "./contract.js";

/** Keep independent causes and label bounded recorder counts as retained execution evidence. */
export function executionEvidence(input: { tools?: BrowserTools; bridge?: ApplyBridge; runId: string; full: boolean; timedOut: boolean; engineExit?: number | null }): LocalApplyExecutionEvidence {
	const { tools, bridge } = input;
	const subject = { kind: "local_apply_run" as const, id: input.runId };
	let page = tools?.pullCalls?.(subject, 0, 100);
	const retained: BrowserCallRecord[] = [...(page?.calls ?? [])];
	let dropped = page?.dropped ?? 0;
	for (let i = 1; i < 20 && page?.hasMore; i++) {
		const next = tools!.pullCalls!(subject, page.lastSeq, 100);
		if (next.lastSeq <= page.lastSeq) break;
		page = next; dropped = Math.max(dropped, page.dropped); retained.push(...page.calls);
	}
	const calls = retained.filter(call => !call.internal && call.tool !== "browser_recover");
	const recovery = tools?.recoveryStatus?.();
	const timeouts = Math.max(recovery?.deadlineCount ?? 0, calls.filter(call => call.toolDiagnostic?.kind === "request_deadline").length);
	const failures = calls.filter(call => call.outcome !== "ok");
	const last = calls.at(-1);
	const state = recovery?.diagnostic.execution;
	const unavailable = !!recovery || last?.toolDiagnostic?.kind === "transport_failure" || last?.toolDiagnostic?.kind === "browser_process_lost";
	const browser: LocalApplyExecutionEvidence["browser"] = { state: state === "pending" || state === "settled" || state === "unknown" ? state : !last || unavailable ? "unavailable" : last.outcome === "ok" ? "healthy" : "tool_error", timeouts };
	const blockingQuestions = bridge?.unresolvedQuestions.length ?? 0;
	return {
		schemaVersion: 1, fieldCounts: input.full ? "unmeasured" : "action_counts",
		nativeCalls: { attempted: calls.length, succeeded: calls.length - failures.length, failed: failures.length, notDispatched: calls.filter(call => call.outcome === "refused" || call.toolDiagnostic?.kind === "quarantined" && call.toolDiagnostic.phase === "recovery" || call.toolDiagnostic?.execution === "not_dispatched").length, dropped, truncated: page?.hasMore === true, coverage: page ? "retained" : "unavailable" },
		screenshotsDelivered: bridge?.screenshotsDelivered ?? 0, screenshotRequests: bridge?.screenshotRequests ?? 0, independentScreenshotAvailable: bridge?.independentScreenshotAvailable ?? false, blockingQuestions,
		optionalQuestions: bridge?.deferredQuestions.filter(question => !question.blocking).length ?? 0,
		browser,
		causes: [...(timeouts ? ["browser_timeout" as const] : []), ...(unavailable ? ["browser_unavailable" as const] : []), ...(blockingQuestions ? ["unresolved_answers" as const] : []), ...(input.timedOut ? ["run_timeout" as const] : []), ...(input.engineExit !== undefined && input.engineExit !== null && input.engineExit !== 0 ? ["engine_failure" as const] : [])],
	};
}
