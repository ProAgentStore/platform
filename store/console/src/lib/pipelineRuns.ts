/**
 * Data → Runs details (#834): what a pipeline run's row can say beyond its counts.
 *
 * The run row carries `detail` (the terminal message) and `errors` (a count). For a FAILED run the
 * detail is the reason. For a COMPLETED run with `errors > 0` the cause is not in the durable error
 * log at all — a partial step failure is recorded only as a `pipeline.partial` trace event whose
 * `context.firstError` holds the one string that says what went wrong (see
 * `workers/api/src/workflows/pipeline-run.ts`). The run's `run_id` IS that trace's `trace_id`, so
 * the details panel reads `/v1/instances/:id/trace?trace_id=<run_id>` and this module picks the
 * first failure out of it.
 */

// A pipeline run record (issue #98) — GET /v1/instances/:id/pipeline-runs.
export interface Run {
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

// One `agent_events` row as GET /v1/instances/:id/trace returns it — `context` is the stored JSON text.
export interface RunTraceEvent {
	id: string;
	ts: number;
	level: string;
	event: string;
	message: string | null;
	context: string | null;
}

export interface RunTrace {
	events?: RunTraceEvent[];
}

export interface FirstRunError {
	/** Which step failed, when the event says so (`step 2 · enrich → http_reachable`). */
	where: string | null;
	/** The failure itself: `firstError` from a partial-failure event, else the event's message. */
	message: string;
	/** `12 of 83 record(s) failed`, for a partial failure. */
	scope: string | null;
}

/** `1m 05s`, `3.2s`, `2h 04m` — how long a finished run took; null while it is still running. */
export function runDuration(run: Pick<Run, "started_at" | "finished_at">): string | null {
	if (run.finished_at == null) return null;
	const ms = Math.max(0, run.finished_at - run.started_at);
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Whether a run has an error worth looking up: it failed, or it counted errors on the way. */
export function runHasErrors(run: Pick<Run, "status" | "errors">): boolean {
	return run.status === "failed" || run.errors > 0;
}

function parseContext(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		// The writer truncates context at 4000 chars, so a long one is not valid JSON.
		return {};
	}
}

/**
 * The first failure in a run's trace. A `pipeline.partial` event is preferred — its `firstError` is
 * the specific cause and survives untruncated in `context` — then any warn/error event's message.
 * Null when the trace holds no failure (a zero-error run, or a trace past its 14-day retention).
 */
export function firstRunError(events: RunTraceEvent[]): FirstRunError | null {
	const partial = events.find((e) => e.event === "pipeline.partial");
	if (partial) {
		const ctx = parseContext(partial.context);
		const tool = typeof ctx.dispatched === "string" ? `${ctx.tool} → ${ctx.dispatched}` : typeof ctx.tool === "string" ? ctx.tool : null;
		const where = [typeof ctx.step === "number" ? `step ${ctx.step}` : null, tool].filter(Boolean).join(" · ") || null;
		const firstError = typeof ctx.firstError === "string" && ctx.firstError ? ctx.firstError : partial.message || "";
		const scope = typeof ctx.failed === "number" ? `${ctx.failed} of ${typeof ctx.total === "number" ? ctx.total : "?"} record(s) failed` : null;
		return { where, message: firstError, scope };
	}
	// A cap is a warning about coverage, not a failure — it would otherwise pre-empt the real one.
	const failed = events.find((e) => (e.level === "warn" || e.level === "error") && e.event !== "pipeline.capped");
	if (!failed) return null;
	const ctx = parseContext(failed.context);
	const step = typeof ctx.failedStep === "number" ? ctx.failedStep : typeof ctx.step === "number" ? ctx.step : null;
	const where = [step != null ? `step ${step}` : null, typeof ctx.tool === "string" ? ctx.tool : null].filter(Boolean).join(" · ") || null;
	return { where, message: failed.message || failed.event, scope: null };
}
