import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";

/**
 * Autonomous runs — the history of objectives this agent worked on by itself (#158/#182).
 *
 * Since the loop moved to the server it survives the tab closing, which is the point — but it
 * also means a run you started yesterday, or one a SUPERVISOR started on your behalf, has no
 * home in the UI. The chat shows only the run you happen to be watching. This is the rest.
 *
 * `stopReason` is shown separately from `status` on purpose. Both "ran out of iterations" and
 * "kept repeating itself" are `failed`, and telling them apart is the difference between "raise
 * the cap" and "the objective is wrong".
 */

type LoopRun = {
	runId: string;
	objective: string;
	status: string;
	stopReason?: string | null;
	detail?: string | null;
	iteration: number;
	maxIterations: number;
	startedAt: number;
	finishedAt?: number | null;
};

/** Plain-language endings. The raw reasons are accurate but not self-explanatory. */
const REASON_LABEL: Record<string, string> = {
	done: "Finished",
	escalated: "Needs you",
	failed: "Failed",
	max_iterations: "Hit the step limit",
	budget: "Hit its spend limit",
	cancelled: "You stopped it",
	no_progress: "Was repeating itself",
};

const TONE: Record<string, string> = {
	completed: "text-green",
	needs_human: "text-orange",
	failed: "text-red",
	cancelled: "text-muted",
	running: "text-accent",
};

function when(ms: number): string {
	const mins = Math.round((Date.now() - ms) / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const h = Math.round(mins / 60);
	return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export default function LoopRunsSection({ instanceId }: { instanceId: string }) {
	const [runs, setRuns] = useState<LoopRun[]>([]);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			const r = await api<{ runs: LoopRun[] }>(`/v1/instances/${instanceId}/loop`);
			setRuns(r.runs ?? []);
		} catch {
			// Never blank the list on a transient read — a run in flight is unaffected by our
			// ability to see it.
		}
	}, [instanceId]);

	useEffect(() => { void load(); }, [load]);

	// Poll only while something is actually running, so an idle settings page is quiet.
	const anyRunning = runs.some((r) => r.status === "running");
	useEffect(() => {
		if (!anyRunning) return;
		const t = setInterval(() => { void load(); }, 5000);
		return () => clearInterval(t);
	}, [anyRunning, load]);

	const stop = async (runId: string) => {
		setBusy(true);
		setMsg("");
		try {
			await api(`/v1/instances/${instanceId}/loop/${runId}/cancel`, { method: "POST" });
			// Cooperative: the in-flight step finishes and settles its spend, so the row stays
			// "running" for a moment. Saying "stopping" is honest; saying "stopped" would not be.
			setMsg("Stopping — the current step will finish first.");
			await load();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};

	if (runs.length === 0) return null;

	return (
		<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Autonomous runs</h3>
			<p className="text-sm text-muted mb-3">
				Objectives this agent worked on by itself. These run on the server, so they keep going
				when you close this page.
			</p>
			{runs.slice(0, 10).map((r) => (
				<div key={r.runId} className="border border-line rounded-lg px-3 py-2 mb-1.5">
					<div className="flex items-start justify-between gap-2">
						<span className="text-sm min-w-0 truncate" title={r.objective}>{r.objective}</span>
						{r.status === "running" ? (
							<button
								type="button"
								disabled={busy}
								onClick={() => stop(r.runId)}
								className="text-xs px-2 py-1 rounded-lg border border-line hover:bg-paper whitespace-nowrap"
							>
								Stop
							</button>
						) : (
							<span className={`text-xs font-semibold whitespace-nowrap ${TONE[r.status] ?? "text-muted"}`}>
								{REASON_LABEL[r.stopReason ?? ""] ?? r.status}
							</span>
						)}
					</div>
					<div className="text-[0.7rem] text-muted mt-0.5">
						step {r.iteration}/{r.maxIterations} · started {when(r.startedAt)}
						{r.status === "running" && <span className="text-accent"> · running</span>}
					</div>
					{r.detail && r.status !== "running" && (
						<div className="text-xs text-muted mt-1 line-clamp-2">{r.detail}</div>
					)}
				</div>
			))}
			{msg && <div className="text-xs text-muted mt-2">{msg}</div>}
		</div>
	);
}
