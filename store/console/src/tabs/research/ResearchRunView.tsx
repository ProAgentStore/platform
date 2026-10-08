import { telemetryRows } from "../../lib/scanSchedule";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { usePolling } from "@proagentstore/sdk/hooks";
import Button from "../../components/Button";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import { type PauseAction, STATUS_LABEL, TONE_CLASS, engineAuthLabel, isActiveRun, pageSteps, pauseBanner, reviewLabel, runPhases, runProblem } from "../../lib/localBrowser";
import type { LocalBrowserConsentList, LocalBrowserRunView, LocalBrowserTrace, LocalBrowserTraceEvent } from "../../lib/types";

/**
 * One research run (#946): what it is doing now, what it is waiting on, and what it found.
 *
 * Reading the run pulls its latest state from the runner (the API does that on every GET), so the
 * poll below is also what moves a run forward in PAGS. A pause is shown first and alone, with only
 * the step that unblocks it; findings are candidates until the owner saves them.
 */
export default function ResearchRunView({ instanceId, runId }: { instanceId: string; runId: string }) {
	const navigate = useNavigate();
	const [run, setRun] = useState<LocalBrowserRunView | null>(null);
	const [events, setEvents] = useState<LocalBrowserTraceEvent[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState("");
	const [msg, setMsg] = useState("");
	// Paths are written out in full at each call: the MCP-parity check reads them as literals.

	const load = useCallback(async () => {
		try {
			const [r, trace] = await Promise.all([api<LocalBrowserRunView>(`/v1/instances/${instanceId}/local-browser/runs/${encodeURIComponent(runId)}`), api<LocalBrowserTrace>(`/v1/instances/${instanceId}/local-browser/runs/${encodeURIComponent(runId)}/events?limit=500`)]);
			setRun(r);
			setEvents(trace.events);
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId, runId]);
	useEffect(() => {
		load();
	}, [load]);
	usePolling(load, 3000, !!run && isActiveRun(run.status));

	const act = async (label: string, fn: () => Promise<unknown>) => {
		setBusy(label);
		setMsg("");
		try {
			await fn();
			await load();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy("");
	};
	const resume = () => api<LocalBrowserRunView>(`/v1/instances/${instanceId}/local-browser/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
	const onPauseAction = (a: PauseAction) =>
		act("resume", async () => {
			if (a.kind === "allow_site") await api<LocalBrowserConsentList>(`/v1/instances/${instanceId}/local-browser/consent`, { method: "PUT", body: JSON.stringify({ scope: "navigate", domain: a.domain, decision: "allow" }) });
			if (a.kind === "allow_profile") await api<LocalBrowserConsentList>(`/v1/instances/${instanceId}/local-browser/consent`, { method: "PUT", body: JSON.stringify({ scope: "signed_in_profile", decision: "allow" }) });
			await resume();
		});
	const review = (index: number, action: "save" | "skip", force = false) =>
		act(`${action}:${index}`, () =>
			action === "save"
				? api<LocalBrowserRunView>(`/v1/instances/${instanceId}/local-browser/runs/${encodeURIComponent(runId)}/findings/${index}/save`, { method: "POST", body: JSON.stringify(force ? { force: true } : {}) })
				: api<LocalBrowserRunView>(`/v1/instances/${instanceId}/local-browser/runs/${encodeURIComponent(runId)}/findings/${index}/skip`, { method: "POST" }),
		);

	if (!run) return error ? <LoadFailed what="this research run" detail={error} onRetry={load} /> : <p className="text-sm text-muted p-2">Loading…</p>;

	const status = STATUS_LABEL[run.status];
	const banner = pauseBanner(run, events);
	const problem = runProblem(run);
	const auth = engineAuthLabel(run.engineAuth);
	const phases = runPhases(run, events);
	const pages = pageSteps(events);
	const findings = run.result?.findings ?? [];

	return (
		<div className="max-w-3xl flex flex-col gap-3 sm:gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="ghost" size="sm" onClick={() => navigate(`/instances/${instanceId}/research`)}>
					← All runs
				</Button>
				<span className={`text-sm font-semibold ${TONE_CLASS[status.tone]}`}>{status.label}</span>
				<span className={`text-xs border border-line rounded px-1.5 py-0.5 ${TONE_CLASS[auth.tone]}`} title="How the CLI on your machine is signed in">
					{run.policy.engine === "claude" ? "Claude Code" : "Codex"} · {auth.label}
				</span>
				{isActiveRun(run.status) && (
					<Button variant="danger" size="sm" className="ml-auto" disabled={!!busy} onClick={() => act("cancel", () => api<LocalBrowserRunView>(`/v1/instances/${instanceId}/local-browser/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }))}>
						Cancel run
					</Button>
				)}
			</div>
			<h2 className="text-base font-bold">{run.objective}</h2>

			{banner && (
				<Card className="border-warning-line bg-warning-soft" role="alert">
					<h3 className="text-base font-bold text-warning mb-1">{banner.title}</h3>
					<p className="text-sm mb-3">{banner.body}</p>
					<div className="flex gap-2 flex-wrap">
						{banner.actions.map((a) => (
							<Button key={a.kind} variant="primary" disabled={!!busy} onClick={() => onPauseAction(a)}>
								{a.kind === "allow_site" ? `Allow ${a.domain} and resume` : a.kind === "allow_profile" ? "Allow and resume" : a.kind === "keep_reading" ? "Let it read this page — resume" : "I've done it — resume"}
							</Button>
						))}
						<Button variant="secondary" disabled={!!busy} onClick={() => act("cancel", () => api<LocalBrowserRunView>(`/v1/instances/${instanceId}/local-browser/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }))}>
							Stop the run instead
						</Button>
					</div>
				</Card>
			)}
			{problem && <p className="text-sm text-danger">{problem}</p>}
			{msg && <p className="text-sm text-danger">{msg}</p>}

			<Card>
				<ol className="flex flex-col gap-2" aria-label="Run steps">
					{phases.map((p) => (
						<li key={p.id} className="flex gap-2 text-sm">
							<span aria-hidden className={p.state === "done" ? "text-success" : p.state === "current" ? "text-accent" : p.state === "blocked" ? "text-warning" : "text-muted-soft"}>
								{p.state === "done" ? "●" : p.state === "current" ? "◐" : p.state === "blocked" ? "■" : "○"}
							</span>
							<span className="flex-1">
								<span className="font-semibold">{p.label}</span> <span className="text-xs text-muted-soft">· {p.actor}</span>
								<span className="block text-xs text-muted break-words">{p.detail}</span>
							</span>
						</li>
					))}
				</ol>
			</Card>

			{/* #980: what the scan DID — counts, source reachability, what became of each result, and
			    the sentence that explains an empty scan. The server's projection, not a second
			    reading of the trace, so this and MCP say the same thing. */}
			{run.telemetry && (
				<Card data-testid="scan-telemetry">
					<h3 className="text-base font-bold mb-2">Scan activity</h3>
					<dl className="flex flex-col gap-1">
						{telemetryRows(run.telemetry).map((row) => (
							<div key={row.label} className="text-xs flex gap-2 items-baseline">
								<dt className="text-muted shrink-0 w-40">{row.label}</dt>
								<dd className={`flex-1 break-words ${row.tone === "danger" ? "text-danger" : row.tone === "warning" ? "text-warning" : "text-ink"}`}>{row.value}</dd>
							</div>
						))}
					</dl>
				</Card>
			)}

			{pages.length > 0 && (
				<Card>
					<h3 className="text-base font-bold mb-2">Pages</h3>
					<ul className="flex flex-col gap-1">
						{pages.map((p) => (
							<li key={p.seq} className="text-xs flex gap-2">
								<span className="text-muted-soft shrink-0">{new Date(p.at).toLocaleTimeString()}</span>
								<span className={p.note ? "text-warning" : "text-ink"}>
									<span className="font-semibold">{p.domain}</span> {p.note ?? p.title}
								</span>
							</li>
						))}
					</ul>
				</Card>
			)}

			{run.status === "completed" || findings.length ? (
				<Card>
					<h3 className="text-base font-bold mb-1">Findings</h3>
					<p className="text-xs text-muted mb-3">
						Nothing is stored until you save it{run.policy.collection ? ` — saved findings go to “${run.policy.collection.name}”` : ". Set a results collection in Settings to save findings"}.
					</p>
					{run.result?.summary && <p className="text-sm mb-3">{run.result.summary}</p>}
					{findings.length === 0 && <p className="text-sm text-muted">No findings.</p>}
					<ul className="flex flex-col gap-3">
						{findings.map((f, i) => {
							const r = reviewLabel(run.findingReviews[String(i)]);
							const decided = run.findingReviews[String(i)];
							return (
								<li key={`${f.url}\n${f.title}`} className="border border-line rounded p-2">
									<div className="flex gap-2 items-baseline flex-wrap">
										<span className="text-sm font-semibold flex-1 min-w-0 break-words">{f.title}</span>
										{r && <span className={`text-xs ${TONE_CLASS[r.tone]}`}>{r.label}</span>}
									</div>
									<a href={f.url} target="_blank" rel="noreferrer noopener" className="text-xs text-accent break-all">
										{f.url}
									</a>
									<blockquote className="text-xs text-muted border-l-2 border-line pl-2 my-1.5 whitespace-pre-wrap">{f.evidence}</blockquote>
									{Object.keys(f.fields).length > 0 && (
										<dl className="text-xs grid grid-cols-[auto_1fr] gap-x-2 mb-1.5">
											{Object.entries(f.fields).map(([k, v]) => (
												<div key={k} className="contents">
													<dt className="text-muted-soft">{k}</dt>
													<dd className="break-words">{String(v)}</dd>
												</div>
											))}
										</dl>
									)}
									{run.status === "completed" && decided?.decision !== "saved" && (
										<div className="flex gap-2 flex-wrap">
											{decided?.decision === "duplicate" ? (
												<Button size="sm" variant="secondary" disabled={!!busy} onClick={() => review(i, "save", true)}>
													Save anyway
												</Button>
											) : (
												<Button size="sm" variant="primary" disabled={!!busy || !run.policy.collection} onClick={() => review(i, "save")}>
													Save
												</Button>
											)}
											{decided?.decision !== "skipped" && (
												<Button size="sm" variant="ghost" disabled={!!busy} onClick={() => review(i, "skip")}>
													Skip
												</Button>
											)}
										</div>
									)}
								</li>
							);
						})}
					</ul>
				</Card>
			) : null}

			{run.result?.sourceFailures.length ? (
				<Card>
					<h3 className="text-base font-bold mb-2">Sources it could not read</h3>
					<ul className="flex flex-col gap-1">
						{run.result.sourceFailures.map((s) => (
							<li key={`${s.url}\n${s.reason}`} className="text-xs">
								<span className="text-warning font-semibold">{s.reason.replace(/_/g, " ")}</span> <span className="break-all">{s.url}</span>
								{s.detail && <span className="block text-muted">{s.detail}</span>}
							</li>
						))}
					</ul>
				</Card>
			) : null}
		</div>
	);
}
