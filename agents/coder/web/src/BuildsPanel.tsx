import { useState, useEffect, useCallback } from "react";
import { api } from "@proagentstore/sdk/client";
import { usePolling } from "@proagentstore/sdk/hooks";
import { resolveBuildsView } from "./builds-view";
import { CheckCircle2, XCircle, Loader2, Clock, GitBranch, ExternalLink, HelpCircle, ArrowLeft, ChevronRight } from "lucide-react";

/** One GitHub Actions run (from …/coding/builds → CODER-003, or …/deployments for history). */
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

/** The identity line of a run: branch@sha · workflow #N. Shared by both views. */
function RunMeta({ run }: { run: DeploymentRun }) {
	return (
		<div className="text-xs text-muted mt-0.5 flex items-center gap-1.5 min-w-0">
			<GitBranch size={12} className="shrink-0" />
			<span className="truncate font-mono">{run.branch || "?"}{run.sha ? `@${run.sha}` : ""}</span>
			{run.name && <span className="truncate">· {run.name}</span>}
			{run.runNumber != null && <span className="shrink-0 text-muted-soft">#{run.runNumber}</span>}
		</div>
	);
}

function ViewRunLink({ url }: { url?: string }) {
	if (!url) return null;
	return (
		<a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[0.65rem] font-semibold text-accent hover:underline mt-1.5">
			<ExternalLink size={11} /> View run
		</a>
	);
}

/**
 * The run HISTORY for one repo — the last N Actions runs, newest first.
 *
 * "Latest run per repo" is the right shape for a fleet, and the wrong shape for one repo: it
 * spends a whole panel on a single line and answers "did the last build pass" while hiding the
 * question you actually have — "when did this start failing / is it flaky". A Repo Coder owns
 * exactly one repo, so history is the useful view; for several repos it is the drill-down.
 */
function RepoHistory({ instanceId, repoId, repoName, onBack }: {
	instanceId: string;
	repoId: string;
	repoName: string;
	/** Absent for a one-repo agent — there is nothing to go back to. */
	onBack?: () => void;
}) {
	const [runs, setRuns] = useState<DeploymentRun[]>([]);
	const [available, setAvailable] = useState(true);
	const [loaded, setLoaded] = useState(false);

	const load = useCallback(async () => {
		try {
			const d = await api<{ available: boolean; runs?: DeploymentRun[] }>(
				`/v1/instances/${instanceId}/coding/repos/${repoId}/deployments?perPage=15`,
			);
			setAvailable(d.available !== false);
			if (d.runs) setRuns(d.runs);
		} catch {
			// Keep the last-known history on a transient error rather than blanking the panel.
		}
		setLoaded(true);
	}, [instanceId, repoId]);

	useEffect(() => { load(); }, [load]);
	usePolling(load, 20000, true);

	return (
		<div className="bg-panel border border-line rounded-xl p-3">
			<div className="flex justify-between items-center gap-2">
				<div className="flex items-center gap-1.5 min-w-0">
					{onBack && (
						<button type="button" onClick={onBack} title="All repos" aria-label="All repos" className="text-muted hover:text-ink shrink-0">
							<ArrowLeft size={15} />
						</button>
					)}
					<span className="text-ink font-bold text-[0.95rem] truncate">{repoName}</span>
				</div>
				<span className="text-[0.65rem] text-muted-soft shrink-0">Recent GitHub Actions runs</span>
			</div>

			<div className="flex flex-col gap-1.5 mt-3">
				{!loaded ? (
					<p className="text-center py-4 text-muted-soft text-sm flex items-center justify-center gap-1.5">
						<Loader2 size={14} className="animate-spin" /> Loading builds…
					</p>
				) : !available ? (
					<p className="text-center py-4 text-muted-soft text-sm">
						Not available — this is a local repo, or the GitHub App isn't installed for its owner.
					</p>
				) : runs.length === 0 ? (
					<p className="text-center py-4 text-muted-soft text-sm">No workflow runs yet.</p>
				) : (
					runs.map((run) => (
						<div key={run.url || `${run.runNumber}`} className="bg-paper border border-line rounded-lg p-3">
							<div className="flex justify-between items-start gap-3">
								<div className="min-w-0"><RunMeta run={run} /></div>
								<div className="flex flex-col items-end gap-1 shrink-0">
									<StatusBadge state={buildState(run)} />
									{run.updatedAt && <span className="text-[0.6rem] text-muted-soft">{timeAgo(run.updatedAt)}</span>}
								</div>
							</div>
							<ViewRunLink url={run.url} />
						</div>
					))
				)}
			</div>
		</div>
	);
}

/**
 * Builds view.
 *
 * ONE repo → its run history directly (a list of one row is not a list).
 * SEVERAL → latest-run-per-repo as an overview, each row a selector into that repo's history.
 *
 * The two are the same idea at different scales: the fleet list exists to choose a repo, so with
 * one repo the choice is already made. Driven off how many repos there are, not off an agent slug.
 */
export default function BuildsPanel({ instanceId }: { instanceId: string }) {
	const [builds, setBuilds] = useState<Build[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [openRepoId, setOpenRepoId] = useState<string | null>(null);

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
	// Only poll the aggregate while it is the visible view — inside a repo's history that view
	// polls for itself, and both at once would fan out to GitHub twice for nothing.
	usePolling(load, 20000, openRepoId === null);

	const view = resolveBuildsView(builds, openRepoId);

	if (loaded && view.mode === "history") {
		return (
			<div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 py-2 sm:px-4 sm:py-3">
				<RepoHistory
					instanceId={instanceId}
					repoId={view.repoId}
					repoName={view.repoName}
					// No back arrow for a one-repo agent: there is no list behind this.
					onBack={view.canGoBack ? () => setOpenRepoId(null) : undefined}
				/>
			</div>
		);
	}

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
								<button
									key={b.repoId}
									type="button"
									// The row IS the selector into that repo's history. A repo with no GitHub
									// connection has no history to open, so it stays inert rather than
									// navigating to an empty view.
									onClick={b.available ? () => setOpenRepoId(b.repoId) : undefined}
									disabled={!b.available}
									className={`bg-paper border border-line rounded-lg p-3 text-left w-full ${b.available ? "hover:border-accent cursor-pointer" : "cursor-default"}`}
								>
									<div className="flex justify-between items-start gap-3">
										<div className="min-w-0">
											<div className="font-semibold text-sm truncate flex items-center gap-1">
												{b.repoName}
												{b.available && <ChevronRight size={13} className="text-muted-soft shrink-0" />}
											</div>
											{b.available && b.run ? (
												<RunMeta run={b.run} />
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
								</button>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
