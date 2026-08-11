/**
 * Deployment status card for any instance — the Operator's counterpart to the Coder's
 * Build Status panel (#488).
 *
 * Reads `config.githubRepo` from `GET /v1/instances/:id/deploy-status` (latest build),
 * drills into the history list via `GET /v1/instances/:id/deploy-history`, and lets the
 * subscriber set the repo via `PUT /v1/instances/:id/deploy-status`.
 *
 * Uses the same design tokens and polling cadence as BuildsPanel in `@proagentstore/coder-web`.
 */
import { useState, useEffect, useCallback } from "react";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { CheckCircle2, XCircle, Loader2, Clock, GitBranch, ExternalLink, HelpCircle, ArrowLeft, ChevronRight, Settings2 } from "lucide-react";
import Button from "./Button";

// ── Shared types mirrored from coder-web (no cross-package import) ──────────

interface BuildRun {
	status?: string;
	conclusion?: string | null;
	name?: string;
	runNumber?: number | null;
	url?: string;
	branch?: string;
	sha?: string;
	updatedAt?: string;
}

type BuildState = "success" | "failed" | "running" | "pending" | "unknown";

function buildState(run: BuildRun | null | undefined): BuildState {
	if (!run) return "unknown";
	if (run.status === "in_progress") return "running";
	if (run.status === "queued") return "pending";
	if (run.status === "completed") {
		if (run.conclusion === "success") return "success";
		if (run.conclusion === "failure" || run.conclusion === "cancelled" || run.conclusion === "timed_out") return "failed";
	}
	return "unknown";
}

function isBuildInFlight(state: BuildState): boolean {
	return state === "running" || state === "pending";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ state }: { state: BuildState }) {
	const base = "inline-flex items-center gap-1 text-2xs font-bold px-1.5 py-0.5 rounded shrink-0";
	switch (state) {
		case "success":
			return <span className={`${base} bg-success-soft text-success`}><CheckCircle2 size={12} /> Success</span>;
		case "failed":
			return <span className={`${base} bg-danger-soft text-danger`}><XCircle size={12} /> Failed</span>;
		case "running":
			return <span className={`${base} bg-amber-500/15 text-amber-600`}><Loader2 size={12} className="animate-spin" /> Running</span>;
		case "pending":
			return <span className={`${base} bg-line/60 text-muted`}><Clock size={12} /> Pending</span>;
		default:
			return <span className={`${base} bg-line/60 text-muted`}><HelpCircle size={12} /> Unknown</span>;
	}
}

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

function RunMeta({ run }: { run: BuildRun }) {
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
		<a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-2xs font-semibold text-accent hover:underline mt-1.5">
			<ExternalLink size={11} /> View run
		</a>
	);
}

// ── History view (paginated list of recent runs for a repo) ──────────────────

function HistoryView({ instanceId, repo, onBack }: {
	instanceId: string;
	repo: string;
	onBack: () => void;
}) {
	const [runs, setRuns] = useState<BuildRun[]>([]);
	const [available, setAvailable] = useState(true);
	const [loaded, setLoaded] = useState(false);

	const load = useCallback(async () => {
		try {
			const d = await api<{ available: boolean; runs?: BuildRun[] }>(
				`/v1/instances/${instanceId}/deploy-history?repo=${encodeURIComponent(repo)}&perPage=15`,
			);
			setAvailable(d.available !== false);
			if (d.runs) setRuns(d.runs);
		} catch {
			// keep last-known history on a transient error
		}
		setLoaded(true);
	}, [instanceId, repo]);

	useEffect(() => { load(); }, [load]);
	useTieredPolling(
		load,
		{ activeMs: 20000, passiveMs: 120000 },
		runs.some((r) => isBuildInFlight(buildState(r))),
	);

	return (
		<div className="bg-panel border border-line rounded-xl p-3">
			<div className="flex justify-between items-center gap-2">
				<div className="flex items-center gap-1.5 min-w-0">
					<button type="button" onClick={onBack} title="Latest build" aria-label="Back" className="text-muted hover:text-ink shrink-0">
						<ArrowLeft size={15} />
					</button>
					<span className="text-ink font-bold text-sm truncate">{repo}</span>
				</div>
				<span className="text-2xs text-muted-soft shrink-0">Recent GitHub Actions runs</span>
			</div>

			<div className="flex flex-col gap-1.5 mt-3">
				{!loaded ? (
					<p className="text-center py-4 text-muted-soft text-sm flex items-center justify-center gap-1.5">
						<Loader2 size={14} className="animate-spin" /> Loading…
					</p>
				) : !available ? (
					<p className="text-center py-4 text-muted-soft text-sm">
						Not available — the GitHub App isn't installed for this repo's owner, or the repo is private.
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
									{run.updatedAt && <span className="text-2xs text-muted-soft">{timeAgo(run.updatedAt)}</span>}
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

// ── Configure form ────────────────────────────────────────────────────────────

function ConfigureForm({ instanceId, current, onSaved }: {
	instanceId: string;
	current: string | null;
	onSaved: (repo: string | null) => void;
}) {
	const [value, setValue] = useState(current ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	const save = async () => {
		setSaving(true);
		setError("");
		try {
			const d = await api<{ repo: string | null; error?: string }>(
				`/v1/instances/${instanceId}/deploy-status`,
				{ method: "PUT", body: JSON.stringify({ repo: value.trim() }) },
			);
			if ("error" in d && d.error) { setError(d.error); return; }
			onSaved(d.repo ?? null);
		} catch {
			setError("Save failed — try again.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="bg-panel border border-line rounded-xl p-3">
			<div className="flex items-center gap-1.5 mb-2">
				<Settings2 size={14} className="text-accent shrink-0" />
				<span className="text-sm font-bold text-ink">Deployment repo</span>
			</div>
			<p className="text-xs text-muted-soft mb-2">
				Enter the GitHub repository (<code className="font-mono px-0.5">owner/repo</code>) to track
				build and deploy status. The GitHub App must be installed for the repo's owner.
			</p>
			<div className="flex gap-2">
				<input
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") save(); }}
					placeholder="owner/repo"
					aria-label="GitHub repository"
					className="font-mono flex-1"
					disabled={saving}
				/>
				<Button variant="primary" size="lg" onClick={save} disabled={saving}>
					{saving ? <Loader2 size={14} className="animate-spin" /> : "Save"}
				</Button>
			</div>
			{error && <p className="text-xs text-danger mt-1.5">{error}</p>}
		</div>
	);
}

// ── Public component ──────────────────────────────────────────────────────────

/**
 * Deployment status card for an Operator instance.
 *
 * Renders inline in TmuxTab, below the terminal pane. When the instance has a configured
 * `config.githubRepo` it shows the latest Actions run; otherwise it shows the configure form.
 * The "View all runs" arrow opens an inline history list.
 */
export default function DeploymentCard({ instanceId }: { instanceId: string }) {
	const [repo, setRepo] = useState<string | null>(null);
	const [available, setAvailable] = useState(false);
	const [run, setRun] = useState<BuildRun | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [configuring, setConfiguring] = useState(false);
	const [showHistory, setShowHistory] = useState(false);

	const load = useCallback(async () => {
		try {
			const d = await api<{ repo: string | null; available: boolean; run: BuildRun | null }>(
				`/v1/instances/${instanceId}/deploy-status`,
			);
			setRepo(d.repo ?? null);
			setAvailable(d.available !== false);
			setRun(d.run ?? null);
		} catch {
			// keep last-known state on a transient error
		}
		setLoaded(true);
	}, [instanceId]);

	useEffect(() => { load(); }, [load]);
	// Poll: fast while a build is actually running; slow while settled; stops when the
	// tab is not active (useTieredPolling's own visibility guard).
	useTieredPolling(
		load,
		{ activeMs: 20000, passiveMs: 120000 },
		isBuildInFlight(buildState(run)),
	);

	// Reset history / configure view when the repo changes. `repo` is the trigger — the effect
	// intentionally resets the view when the stored coord changes, even though the setters are stable.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `repo` is the intended trigger
	useEffect(() => {
		setShowHistory(false);
		setConfiguring(false);
	}, [repo]);

	if (!loaded) return null; // don't flash during the first round-trip

	if (showHistory && repo) {
		return (
			<div className="px-3 pb-3 pt-0">
				<HistoryView instanceId={instanceId} repo={repo} onBack={() => setShowHistory(false)} />
			</div>
		);
	}

	if (configuring || !repo) {
		return (
			<div className="px-3 pb-3 pt-0">
				<ConfigureForm
					instanceId={instanceId}
					current={repo}
					onSaved={(saved) => { setRepo(saved); setConfiguring(false); }}
				/>
			</div>
		);
	}

	// Configured repo: show latest build
	const state = buildState(run);
	return (
		<div className="px-3 pb-3 pt-0">
			<div className="bg-panel border border-line rounded-xl p-3">
				<div className="flex justify-between items-center gap-2 mb-2">
					<span className="text-sm font-bold text-ink">Deployment</span>
					<button
						type="button"
						onClick={() => setConfiguring(true)}
						title="Change repo"
						aria-label="Change GitHub repo"
						className="text-muted hover:text-accent"
					>
						<Settings2 size={13} />
					</button>
				</div>

				{/* Latest run */}
				{!available ? (
					<p className="text-xs text-muted-soft">
						Not available — the GitHub App isn't installed for <code className="font-mono">{repo}</code>, or the repo is private.
					</p>
				) : !run ? (
					<p className="text-xs text-muted-soft">No workflow runs yet for <code className="font-mono">{repo}</code>.</p>
				) : (
					<button
						type="button"
						onClick={() => setShowHistory(true)}
						className="w-full text-left bg-paper border border-line rounded-lg p-2 hover:border-accent"
					>
						<div className="flex justify-between items-start gap-3">
							<div className="min-w-0">
								<div className="font-mono text-xs font-semibold truncate flex items-center gap-1">
									{repo} <ChevronRight size={12} className="text-muted-soft shrink-0" />
								</div>
								<RunMeta run={run} />
							</div>
							<div className="flex flex-col items-end gap-1 shrink-0">
								<StatusBadge state={state} />
								{run.updatedAt && <span className="text-2xs text-muted-soft">{timeAgo(run.updatedAt)}</span>}
							</div>
						</div>
						<ViewRunLink url={run.url} />
					</button>
				)}
			</div>
		</div>
	);
}
