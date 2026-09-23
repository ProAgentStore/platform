/**
 * What Data → Runs shows when a pipeline run is expanded (#834).
 *
 * A run row carries only counts, so `errors: 12` on a COMPLETED run said nothing about what went
 * wrong — the cause lived in the run's trace (the `pipeline.partial` event and its `firstError`),
 * and `detail` was reachable only as a row tooltip. The run id IS the trace id
 * (`workflows/pipeline-run.ts` logs every event with `traceId: runId`), so the trace for one run
 * is `GET /v1/instances/:id/trace?trace_id=<run_id>`.
 *
 * Not every counted error reaches the trace: a per-record SINK failure is written to the durable
 * error log only. `errorsOnlyInLog` says so, rather than showing an empty errors section that
 * reads as "nothing went wrong".
 */

// A pipeline run record (issue #98) — GET /v1/instances/:id/pipeline-runs.
export interface PipelineRun {
	run_id: string;
	pipeline: string;
	trigger: string;
	status: string;
	started_at: number;
	finished_at: number | null;
	seen: number;
	added: number;
	skipped: number;
	errors: number;
	detail: string | null;
}

// One `agent_events` row as GET /v1/instances/:id/trace returns it (`EventRow`, lib/events.ts).
export interface PipelineRunTraceEvent {
	id: string;
	ts: number;
	source: string;
	level: string;
	event: string;
	message: string | null;
	context: string | null;
}

export interface PipelineRunTrace {
	events?: PipelineRunTraceEvent[];
}

export interface RunErrorContext {
	event: string;
	message: string;
	firstError: string | null;
	failed: number | null;
	total: number | null;
	step: number | null;
	tool: string | null;
}

export interface RunDetails {
	/** Human-readable run length; null while the run is still going. */
	duration: string | null;
	hasErrors: boolean;
	detailText: string;
	/** The earliest error event on the trace — a `pipeline.partial` when there is one. */
	firstError: RunErrorContext | null;
	/** Errors were counted but none reached the trace (per-record sink failures). */
	errorsOnlyInLog: boolean;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return "<1s";
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m ${sec}s`;
	return `${sec}s`;
}

function parseContext(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		// A context that is not JSON still has its event + message, which is what gets shown.
		return {};
	}
}

const num = (v: unknown) => (typeof v === "number" ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function buildRunDetails(run: PipelineRun, events: PipelineRunTraceEvent[]): RunDetails {
	const hasErrors = run.errors > 0 || run.status === "failed";
	// `pipeline.capped` is a warning about coverage, not a failure — it must not pose as the cause.
	const candidates = events.filter((e) => (e.level === "warn" || e.level === "error") && e.event !== "pipeline.capped");
	const hit = hasErrors ? (candidates.find((e) => e.event === "pipeline.partial") ?? candidates[0]) : undefined;
	const ctx = hit ? parseContext(hit.context) : {};
	return {
		duration: run.finished_at != null ? formatDuration(run.finished_at - run.started_at) : null,
		hasErrors,
		detailText: run.detail ?? "",
		firstError: hit
			? {
					event: hit.event,
					message: hit.message ?? "",
					firstError: str(ctx.firstError),
					failed: num(ctx.failed),
					total: num(ctx.total),
					step: num(ctx.step) ?? num(ctx.failedStep),
					tool: str(ctx.tool),
				}
			: null,
		errorsOnlyInLog: hasErrors && !hit,
	};
}
