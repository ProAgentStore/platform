import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { firstRunError, runDuration, runHasErrors, type Run, type RunTrace, type RunTraceEvent } from "../lib/pipelineRuns";

/**
 * The expanded half of a Data → Runs row (#834): the terminal detail, timing and run id the row
 * used to hide in a hover tooltip, plus the run's own trace — fetched by `trace_id = run_id` — so
 * a completed run with `errors > 0` shows the partial failure that the durable error log never saw.
 */
export default function PipelineRunDetails({ instanceId, run, fmtDateTime }: { instanceId: string; run: Run; fmtDateTime: (v: unknown) => string }) {
	const [events, setEvents] = useState<RunTraceEvent[] | null>(null);
	const [traceErr, setTraceErr] = useState("");
	const [showTrace, setShowTrace] = useState(false);

	useEffect(() => {
		let live = true;
		api<RunTrace>(`/v1/instances/${instanceId}/trace?trace_id=${encodeURIComponent(run.run_id)}&limit=200`)
			.then((d) => live && setEvents(d.events || []))
			.catch((e) => live && setTraceErr(e instanceof Error ? e.message : "Couldn't load the trace"));
		return () => {
			live = false;
		};
	}, [instanceId, run.run_id]);

	const duration = runDuration(run);
	const first = events ? firstRunError(events) : null;

	return (
		<div className="flex flex-col gap-2 text-xs p-2">
			<dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
				<dt className="text-muted-soft">Detail</dt>
				<dd className="break-words">{run.detail || <span className="text-muted-soft">No detail was recorded.</span>}</dd>
				<dt className="text-muted-soft">Started</dt>
				<dd>{fmtDateTime(run.started_at)}</dd>
				<dt className="text-muted-soft">Finished</dt>
				<dd>{run.finished_at == null ? <span className="text-muted-soft">Still running</span> : `${fmtDateTime(run.finished_at)} (${duration})`}</dd>
				<dt className="text-muted-soft">Run ID</dt>
				<dd className="font-mono break-all">{run.run_id}</dd>
			</dl>

			{runHasErrors(run) && (
				<section aria-label="First error" className="border border-line rounded p-2">
					<div className="font-medium text-danger mb-0.5">First error{first?.where ? ` — ${first.where}` : ""}</div>
					{traceErr ? (
						<div className="text-danger">{traceErr}</div>
					) : events == null ? (
						<div className="text-muted-soft">Loading the trace…</div>
					) : first ? (
						<>
							<div className="break-words">{first.message}</div>
							{first.scope && <div className="text-muted-soft">{first.scope}</div>}
						</>
					) : (
						// Said plainly rather than left blank: the trace is kept 14 days, the run row 30.
						<div className="text-muted-soft">No failure event is left in this run's trace — the detail above is the whole record.</div>
					)}
				</section>
			)}

			{events && events.length > 0 && (
				<div>
					<button type="button" aria-expanded={showTrace} onClick={() => setShowTrace((s) => !s)} className="text-accent underline">
						{showTrace ? "Hide pipeline trace" : `Show pipeline trace (${events.length} events)`}
					</button>
					{showTrace && (
						<ol aria-label={`Pipeline trace ${run.run_id}`} className="mt-1 border border-line rounded divide-y divide-line">
							{events.map((e) => (
								<li key={e.id} className="p-1.5 flex gap-2">
									<span className="text-muted-soft shrink-0">{fmtDateTime(e.ts)}</span>
									<span className={`font-mono shrink-0 ${e.level === "warn" || e.level === "error" ? "text-danger" : "text-muted-soft"}`}>{e.event}</span>
									<span className="min-w-0 break-words">{e.message}</span>
								</li>
							))}
						</ol>
					)}
				</div>
			)}
		</div>
	);
}
