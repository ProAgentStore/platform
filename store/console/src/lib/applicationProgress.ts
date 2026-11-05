import type { ApplicationExecutionProjection } from "../../../../workers/api/src/agent-types";

type Progress = Pick<NonNullable<ApplicationExecutionProjection["progress"]>, "filled" | "uploaded" | "fieldCounts" | "executionEvidence">;

/** Tool execution counts are not proof that distinct form fields accepted values. */
export function applicationProgressEvidence(progress: Progress): string {
	const counts = progress.fieldCounts === "unmeasured" || progress.filled === null || progress.uploaded === null
		? "Field and attachment completion unmeasured"
		: `${progress.filled} fill action${progress.filled === 1 ? "" : "s"}, ${progress.uploaded} upload${progress.uploaded === 1 ? "" : "s"}`;
	const evidence = progress.executionEvidence;
	if (!evidence) return counts;
	const calls = evidence.nativeCalls;
	const recorded = calls.coverage === "retained" ? `${calls.attempted} recorded native calls, ${calls.failed} failed${calls.dropped ? `, ${calls.dropped} older records unavailable` : ""}${calls.notDispatched ? `, ${calls.notDispatched} not dispatched` : ""}${calls.truncated ? ", bounded history incomplete" : ""}` : "native call totals unavailable";
	return `${counts} · ${recorded} · ${evidence.screenshotsDelivered} image payload${evidence.screenshotsDelivered === 1 ? "" : "s"} delivered to model tools (${evidence.screenshotRequests} screenshot requests; independent capture ${evidence.independentScreenshotAvailable ? "available" : "unavailable"}) · ${evidence.optionalQuestions} optional question${evidence.optionalQuestions === 1 ? "" : "s"} omitted`;
}
