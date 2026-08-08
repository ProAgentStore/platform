import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import {
	agentActLabel,
	anyPullInFlight,
	checksState,
	mergeTone,
	reviewLabel,
	type PullRow,
} from "./pulls-view";
import type { CodingRepo } from "./types";
import {
	Bot,
	CheckCircle2,
	ChevronRight,
	Clock,
	ExternalLink,
	GitBranch,
	GitPullRequest,
	HelpCircle,
	Loader2,
	RefreshCw,
	XCircle,
} from "lucide-react";

/**
 * The Pulls panel (#401) — the fourth thing beside Terminal · Issues · Builds.
 *
 * The Coder's safest per-repo merge policy (#314) is `pr`: do the work, open a pull request, stop.
 * Having chosen that, the owner could see the ISSUE that started the work and the BUILD that ran,
 * but not the PR that is the actual output — they had to leave for GitHub to see what their own
 * agent had just produced.
 *
 * Shows ALL open PRs, not only the agent's. A panel that hid human PRs would answer "what did my
 * agent do" while failing to be a view of the repo; the agent's are BADGED instead, which is the
 * question the board genuinely could not answer.
 */

function ChecksBadge({ pull }: { pull: PullRow }) {
	const state = checksState(pull);
	const base = "inline-flex items-center gap-1 text-2xs font-bold px-1.5 py-0.5 rounded shrink-0";
	switch (state) {
		case "success":
			return <span className={`${base} bg-success-soft text-success`}><CheckCircle2 size={11} /> Checks pass</span>;
		case "failed":
			return <span className={`${base} bg-danger-soft text-danger`}><XCircle size={11} /> Checks failed</span>;
		case "running":
			return <span className={`${base} bg-warning-soft text-warning`}><Loader2 size={11} className="animate-spin" /> Checks running</span>;
		case "pending":
			return <span className={`${base} bg-line/60 text-muted`}><Clock size={11} /> Checks queued</span>;
		default:
			// "We did not find a run for this commit" is not "no CI configured" and is certainly not
			// a pass, so it says so rather than showing nothing.
			return <span className={`${base} bg-line/60 text-muted`}><HelpCircle size={11} /> Checks unknown</span>;
	}
}

function MergeBadge({ pull }: { pull: PullRow }) {
	const m = mergeTone(pull);
	if (!m) return null;
	const base = "inline-flex items-center gap-1 text-2xs font-bold px-1.5 py-0.5 rounded shrink-0";
	const tone =
		m.tone === "conflict" ? "bg-danger-soft text-danger" : m.tone === "blocked" ? "bg-warning-soft text-warning" : m.tone === "clean" ? "bg-success-soft text-success" : "bg-line/60 text-muted";
	return <span className={`${base} ${tone}`}>{m.label}</span>;
}

function ReviewBadge({ pull }: { pull: PullRow }) {
	const label = reviewLabel(pull.review);
	if (!label) return null;
	const tone = pull.review === "changes_requested" ? "bg-danger-soft text-danger" : pull.review === "approved" ? "bg-success-soft text-success" : "bg-line/60 text-muted";
	return <span className={`inline-flex items-center gap-1 text-2xs font-bold px-1.5 py-0.5 rounded shrink-0 ${tone}`}>{label}</span>;
}

function AgentBadge({ pull }: { pull: PullRow }) {
	const label = agentActLabel(pull.agentAct);
	if (!label) return null;
	return (
		<span
			className="inline-flex items-center gap-1 text-2xs font-bold px-1.5 py-0.5 rounded bg-accent-soft text-accent shrink-0"
			// Attribution is exact or absent: it exists only where the platform recorded a PR NUMBER
			// against a run. The title says which run, so "was it mine" has a traceable answer.
			title={`Run ${pull.agentAct?.traceId ?? ""}`}
		>
			<Bot size={11} /> {label}
		</span>
	);
}

/** Short relative timestamp. Same shape as the Builds panel's — one clock across the tab. */
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
 * One repo's pull requests. `startOpen` mirrors `RepoIssues`: nested under a repo card it is one
 * of several things and collapsing is right; as its OWN tab it is the whole point of the view and
 * arriving at a collapsed disclosure reads as an empty page.
 */
export default function PullsPanel({
	instanceId,
	repo,
	startOpen = false,
}: {
	instanceId: string;
	repo: CodingRepo;
	startOpen?: boolean;
}) {
	const [open, setOpen] = useState(startOpen);
	const [pulls, setPulls] = useState<PullRow[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const d = await api<{ pulls: PullRow[] }>(`/v1/instances/${instanceId}/coding/repos/${repo.id}/pulls`);
			setPulls(d.pulls || []);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setPulls([]);
		}
		setLoading(false);
	}, [instanceId, repo.id]);

	const toggle = () => {
		const next = !open;
		setOpen(next);
		if (next && pulls === null) load();
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: load is stable per (instance, repo).
	useEffect(() => {
		if (startOpen && pulls === null && !loading) load();
	}, [startOpen]);

	// The SAME cadence the Builds panel uses, and deliberately not faster. The platform-side ETag
	// (#401) makes each tick cheaper; a 304 is exempt from GitHub's PRIMARY rate limit only, still
	// counts against secondary limits, and is still a request.
	useTieredPolling(load, { activeMs: 20000, passiveMs: 120000 }, anyPullInFlight(pulls ?? []), open);

	return (
		<div className={startOpen ? "" : "mt-2 border-t border-line pt-2"}>
			<div className="flex items-center justify-between gap-2">
				{startOpen ? (
					<span className="flex items-center gap-1 text-xs font-semibold text-muted">
						<GitPullRequest size={12} />
						Pulls{pulls !== null ? ` (${pulls.length})` : ""}
					</span>
				) : (
					<button type="button" onClick={toggle} className="flex items-center gap-1 text-xs font-semibold text-muted hover:text-accent">
						<ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} />
						<GitPullRequest size={12} />
						Pulls{pulls !== null ? ` (${pulls.length})` : ""}
					</button>
				)}
				{open && (
					<button type="button" onClick={load} title="Refresh pull requests" disabled={loading} className="text-muted hover:text-accent disabled:opacity-40">
						<RefreshCw size={12} className={loading ? "animate-spin" : ""} />
					</button>
				)}
			</div>

			{open && (
				<div className="mt-2 flex flex-col gap-1.5">
					{loading && pulls === null ? (
						<p className="text-xs text-muted-soft py-1">Loading pull requests…</p>
					) : error ? (
						<p className="text-xs text-danger py-1">{error}</p>
					) : pulls && pulls.length === 0 ? (
						<p className="text-xs text-muted-soft py-1">No open pull requests.</p>
					) : (
						pulls?.map((p) => (
							// items-start, not items-center: at 320px the title wraps to two lines and
							// centre-alignment floats the number and the link into the middle of it.
							<div key={p.number} className="flex items-start gap-2 text-xs">
								<span className="text-muted shrink-0 tabular-nums leading-5">#{p.number}</span>
								<div className="flex-1 min-w-0">
									<div className="flex items-start gap-1.5">
										<span className="flex-1 min-w-0 line-clamp-2 sm:truncate leading-5" title={p.title}>{p.title}</span>
										{p.url && (
											<a href={p.url} target="_blank" rel="noreferrer" title="Open on GitHub" className="shrink-0 text-muted hover:text-accent mt-0.5">
												<ExternalLink size={12} />
											</a>
										)}
									</div>
									{/* The branch line: what the agent worked on, and where it wants to land. */}
									<div className="text-2xs text-muted mt-0.5 flex items-center gap-1 min-w-0">
										<GitBranch size={11} className="shrink-0" />
										<span className="truncate font-mono">{p.branch || "?"} → {p.baseBranch || "?"}</span>
										{p.author && <span className="truncate hidden sm:inline">· {p.author}</span>}
										{p.updatedAt && <span className="shrink-0 text-muted-soft">· {timeAgo(p.updatedAt)}</span>}
									</div>
									{/* Badges WRAP rather than truncate. There are up to four and at 320px they
									    cannot share a line with the title; pushing them onto their own wrapping
									    row is what keeps "Conflicts" visible on a phone. */}
									<div className="flex flex-wrap items-center gap-1 mt-1">
										<AgentBadge pull={p} />
										<MergeBadge pull={p} />
										<ReviewBadge pull={p} />
										<ChecksBadge pull={p} />
										{p.labels.slice(0, 2).map((l) => (
											<span key={l} className="hidden sm:inline text-2xs px-1 py-0.5 bg-accent-soft text-accent rounded font-semibold shrink-0">{l}</span>
										))}
									</div>
								</div>
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
}
