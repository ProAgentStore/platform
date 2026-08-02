import { useState, useEffect, useCallback } from "react";
import { api } from "@proagentstore/sdk/client";
import { usePolling } from "@proagentstore/sdk/hooks";
import { CheckCircle2, XCircle, Loader2, Clock, GitBranch, ExternalLink, HelpCircle } from "lucide-react";

/** Latest GitHub Actions run for a repo (from GET …/coding/builds → CODER-003). */
interface DeploymentRun {
	status?: string; // queued | in_progress | completed
	conclusion?: string | null; // success | failure | cancelled | timed_out | null
	name?: string;
	runNumber?: number | null;
	url?: string;
	branch?: string;
	sha?: string;
	updatedAt?: string;
}

interface Build {
	repoId: string;
	repoName: string;
	available: boolean;
	run: DeploymentRun | null;
}

type BuildState = "success" | "failed" | "running" | "pending" | "unknown";

/** Map a GitHub Actions run (status + conclusion) → a single build state. */
function buildState(run: DeploymentRun | null): BuildState {
	if (!run) return "unknown";
	if (run.status === "in_progress") return "running";
	if (run.status === "queued") return "pending";
	if (run.status === "completed") {
		if (run.conclusion === "success") return "success";
		if (run.conclusion === "failure" || run.conclusion === "cancelled" || run.conclusion === "timed_out") return "failed";
	}
	return "unknown";
}

function StatusBadge({ state }: { state: BuildState }) {
	const base = "inline-flex items-center gap-1 text-[0.65rem] font-bold px-1.5 py-0.5 rounded shrink-0";
	switch (state) {
		case "success":
			return <span className={`${base} bg-green/15 text-green`}><CheckCircle2 size={12} /> Success</span>;
		case "failed":
			return <span className={`${base} bg-red/15 text-red`}><XCircle size={12} /> Failed</span>;
		case "running":
			return <span className={`${base} bg-amber-500/15 text-amber-600`}><Loader2 size={12} className="animate-spin" /> Running</span>;
		case "pending":
			return <span className={`${base} bg-line/60 text-muted`}><Clock size={12} /> Pending</span>;
		default:
			return <span className={`${base} bg-line/60 text-muted`}><HelpCircle size={12} /> Unknown</span>;
	}
}

/** Short relative timestamp, e.g. "3m ago", "2h ago", "5d ago". */
function timeAgo(iso?: string): string {
	if (!iso) return "";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/**
 * Builds view — one row per repo showing its latest CI/CD run (name/#runNumber, status
 * badge, relative timestamp, branch@sha summary, "View run" link). Data is the aggregate
 * /coding/builds endpoint (one call, latest run per repo). Repos that are local/non-GitHub
 * (available:false) are shown as a muted "not available" row, not hidden. Polls every 20s
 * while mounted (CodingTab only mounts this while the Builds view is open). Scrollable on
 * mobile (overflow-y-auto + overscroll-contain, flex-1 min-h-0). (CODER-004, #80)
 */
export default function BuildsPanel({ instanceId }: { instanceId: string }) {
	const [builds, setBuilds] = useState<Build[]>([]);
	const [loaded, setLoaded] = useState(false);

	const load = useCallback(async () => {
		try {
			const d = await api<{ builds: Build[] }>(`/v1/instances/${instanceId}/coding/builds`);
			setBuilds(d.builds || []);
		} catch {
			// leave the last-known list in place on a transient error
		}
		setLoaded(true);
	}, [instanceId]);

	useEffect(() => { load(); }, [load]);
	usePolling(load, 20000, true);

	return (
		<div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 py-2 sm:px-4 sm:py-3">
			<div className="bg-panel border border-line rounded-xl p-3">
				<div className="flex justify-between items-center gap-2">
					<span className="text-ink font-bold text-[0.95rem]">Builds</span>
					<span className="text-[0.65rem] text-muted-soft">Latest GitHub Actions run per repo</span>
				</div>

				<div className="flex flex-col gap-1.5 mt-3">
					{!loaded ? (
						<p className="text-center py-4 text-muted-soft text-sm flex items-center justify-center gap-1.5">
							<Loader2 size={14} className="animate-spin" /> Loading builds…
						</p>
					) : builds.length === 0 ? (
						<p className="text-center py-4 text-muted-soft text-sm">No repos yet. Add one from the Repos tab.</p>
					) : (
						// Always render a row per repo — each self-describes availability (a repo that's
						// local, non-GitHub, or awaiting the GitHub App shows "Not available" rather than
						// being hidden behind a misleading "no GitHub repos" message).
						builds.map((b) => {
							const state = buildState(b.run);
							return (
								<div key={b.repoId} className="bg-paper border border-line rounded-lg p-3">
									<div className="flex justify-between items-start gap-3">
										<div className="min-w-0">
											<div className="font-semibold text-sm truncate">{b.repoName}</div>
											{b.available && b.run ? (
												<div className="text-xs text-muted mt-0.5 flex items-center gap-1.5 min-w-0">
													<GitBranch size={12} className="shrink-0" />
													<span className="truncate font-mono">{b.run.branch || "?"}{b.run.sha ? `@${b.run.sha}` : ""}</span>
													{b.run.name && <span className="truncate">· {b.run.name}</span>}
													{b.run.runNumber != null && <span className="shrink-0 text-muted-soft">#{b.run.runNumber}</span>}
												</div>
											) : (
												<div className="text-xs text-muted-soft mt-0.5">
													{b.available ? "No runs yet." : "Not available (local repo / GitHub App not installed)."}
												</div>
											)}
										</div>
										<div className="flex flex-col items-end gap-1 shrink-0">
											{b.available && <StatusBadge state={state} />}
											{b.run?.updatedAt && <span className="text-[0.6rem] text-muted-soft">{timeAgo(b.run.updatedAt)}</span>}
										</div>
									</div>
									{b.run?.url && (
										<a
											href={b.run.url}
											target="_blank"
											rel="noreferrer"
											className="inline-flex items-center gap-1 text-[0.65rem] font-semibold text-accent hover:underline mt-1.5"
										>
											<ExternalLink size={11} /> View run
										</a>
									)}
								</div>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
