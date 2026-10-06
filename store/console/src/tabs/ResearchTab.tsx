import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { usePolling } from "@proagentstore/sdk/hooks";
import Button from "../components/Button";
import Card from "../components/Card";
import LoadFailed from "../components/LoadFailed";
import { STATUS_LABEL, TONE_CLASS, isActiveRun, setupChecklist } from "../lib/localBrowser";
import type { LocalBrowserPreflight, LocalBrowserRunList, LocalBrowserRunView } from "../lib/types";
import ResearchRunView from "./research/ResearchRunView";

/**
 * The Research tab (#946) — local CLI browser research for a general agent.
 *
 * Not a Coding tab: there is no repository here, ever. The checklist asks only for what a run
 * needs — a connected runner, a signed-in Codex or Claude Code on that machine, a browser — and the
 * run list opens a run's own page (`research/<runId>`), where its steps, any pause waiting on the
 * owner and its findings live.
 */
export default function ResearchTab({ instanceId, runId }: { instanceId: string; runId?: string }) {
	if (runId) return <ResearchRunView instanceId={instanceId} runId={runId} />;
	return <ResearchHome instanceId={instanceId} />;
}

function ResearchHome({ instanceId }: { instanceId: string }) {
	const navigate = useNavigate();
	const [preflight, setPreflight] = useState<LocalBrowserPreflight | null>(null);
	const [runs, setRuns] = useState<LocalBrowserRunView[] | null>(null);
	const [error, setError] = useState("");
	const [objective, setObjective] = useState("");
	const [starting, setStarting] = useState(false);
	const [startMsg, setStartMsg] = useState("");

	const loadRuns = useCallback(async () => {
		try {
			setRuns((await api<LocalBrowserRunList>(`/v1/instances/${instanceId}/local-browser/runs?limit=20`)).runs);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	const loadPreflight = useCallback(async () => {
		try {
			setPreflight(await api<LocalBrowserPreflight>(`/v1/instances/${instanceId}/local-browser/preflight`));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => {
		loadPreflight();
		loadRuns();
	}, [loadPreflight, loadRuns]);
	usePolling(loadRuns, 5000, !!runs?.some((r) => isActiveRun(r.status)));

	const start = async () => {
		setStarting(true);
		setStartMsg("");
		try {
			// A fresh key per click: a retried request (a flaky network) returns the same run instead of a second one.
			const run = await api<LocalBrowserRunView>(`/v1/instances/${instanceId}/local-browser/runs`, { method: "POST", body: JSON.stringify({ objective: objective.trim(), requestId: crypto.randomUUID() }) });
			setObjective("");
			navigate(`/instances/${instanceId}/research/${encodeURIComponent(run.id)}`);
		} catch (e) {
			setStartMsg(e instanceof Error ? e.message : String(e));
		}
		setStarting(false);
	};

	if (error && !runs) return <LoadFailed what="research runs" detail={error} onRetry={() => { setError(""); loadRuns(); loadPreflight(); }} />;
	const checklist = setupChecklist(preflight);

	return (
		<div className="max-w-3xl">
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Local browser research</h3>
				<p className="text-sm text-muted mb-3">
					PAGS supervises: it keeps the run, asks you before anything new, and saves only what you approve. The research itself is done by Codex or Claude Code signed in on your own machine, in a real browser, read-only.
				</p>
				<ul className="flex flex-col gap-1.5 mb-1" aria-label="Setup checklist">
					{checklist.map((c) => (
						<li key={c.id} className="flex gap-2 text-sm">
							<span aria-hidden className={c.state === "ok" ? "text-success" : c.state === "todo" ? "text-warning" : "text-muted-soft"}>
								{c.state === "ok" ? "✓" : c.state === "todo" ? "!" : "○"}
							</span>
							<span>
								<span className="font-semibold">{c.label}</span>
								{c.state !== "ok" && <span className="block text-xs text-muted">{c.detail}</span>}
							</span>
						</li>
					))}
					{!preflight && <li className="text-sm text-muted">Checking…</li>}
				</ul>
			</Card>

			<Card className="mb-3 sm:mb-4">
				<label htmlFor="research-objective" className="text-sm font-semibold block mb-1">
					What should it research?
				</label>
				<textarea
					id="research-objective"
					value={objective}
					onChange={(e) => setObjective(e.target.value)}
					maxLength={4000}
					rows={3}
					placeholder="e.g. Find senior TypeScript roles in Sydney posted this week"
					className="w-full bg-paper border border-line rounded px-2 py-1.5 text-sm mb-2"
				/>
				<div className="flex gap-2 items-center flex-wrap">
					<Button variant="primary" disabled={starting || !objective.trim() || preflight?.ready === false} onClick={start}>
						{starting ? "Starting…" : "Start research"}
					</Button>
					{preflight?.ready === false && <span className="text-xs text-warning">Finish the checklist above first.</span>}
					{startMsg && <span className="text-xs text-danger">{startMsg}</span>}
				</div>
			</Card>

			<Card>
				<h3 className="text-base font-bold mb-2">Runs</h3>
				{runs?.length === 0 && <p className="text-sm text-muted">No research runs yet.</p>}
				<ul className="flex flex-col divide-y divide-line">
					{runs?.map((r) => {
						const s = STATUS_LABEL[r.status];
						return (
							<li key={r.id}>
								<button type="button" onClick={() => navigate(`/instances/${instanceId}/research/${encodeURIComponent(r.id)}`)} className="w-full text-left py-2 flex gap-3 items-baseline hover:bg-panel-hover">
									<span className={`text-xs font-semibold shrink-0 w-28 ${TONE_CLASS[s.tone]}`}>{s.label}</span>
									<span className="text-sm truncate flex-1">{r.objective}</span>
									<span className="text-xs text-muted-soft shrink-0">{r.result ? `${r.result.findings.length} found` : new Date(r.createdAt).toLocaleString()}</span>
								</button>
							</li>
						);
					})}
				</ul>
			</Card>
		</div>
	);
}
