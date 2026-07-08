import { useState, useCallback } from "react";
import { api } from "@proagentstore/sdk/client";
import type { CodingRepo } from "./types";
import { CircleDot, ExternalLink, RefreshCw, ChevronRight, Play } from "lucide-react";

interface Issue {
	number: number;
	title: string;
	state: string;
	labels: string[];
	comments: number;
	url: string;
}

/**
 * Read-only GitHub Issues for one repo (Phase A). Fetched on expand from the cloud
 * (works on any runner). "Work on this" pre-fills an objective for the user to review
 * and send — it never auto-runs. Only rendered for GitHub-connected repos.
 */
export default function RepoIssues({
	instanceId,
	repo,
	onWorkOnIssue,
}: {
	instanceId: string;
	repo: CodingRepo;
	onWorkOnIssue: (repo: CodingRepo, issue: { number: number; title: string }) => void;
}) {
	const [open, setOpen] = useState(false);
	const [issues, setIssues] = useState<Issue[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const d = await api<{ issues: Issue[] }>(`/v1/instances/${instanceId}/coding/repos/${repo.id}/issues`);
			setIssues(d.issues || []);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setIssues([]);
		}
		setLoading(false);
	}, [instanceId, repo.id]);

	const toggle = () => {
		const next = !open;
		setOpen(next);
		if (next && issues === null) load();
	};

	return (
		<div className="mt-2 border-t border-line pt-2">
			<div className="flex items-center justify-between gap-2">
				<button type="button" onClick={toggle} className="flex items-center gap-1 text-xs font-semibold text-muted hover:text-accent">
					<ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} />
					<CircleDot size={12} />
					Issues{issues !== null ? ` (${issues.length})` : ""}
				</button>
				{open && (
					<button type="button" onClick={load} title="Refresh issues" disabled={loading} className="text-muted hover:text-accent disabled:opacity-40">
						<RefreshCw size={12} className={loading ? "animate-spin" : ""} />
					</button>
				)}
			</div>

			{open && (
				<div className="mt-2 flex flex-col gap-1">
					{loading && issues === null ? (
						<p className="text-xs text-muted-soft py-1">Loading issues…</p>
					) : error ? (
						<p className="text-xs text-red py-1">{error}</p>
					) : issues && issues.length === 0 ? (
						<p className="text-xs text-muted-soft py-1">No open issues.</p>
					) : (
						issues?.map((i) => (
							<div key={i.number} className="flex items-center gap-2 text-xs">
								<span className="text-muted shrink-0 tabular-nums">#{i.number}</span>
								<span className="truncate flex-1" title={i.title}>{i.title}</span>
								{i.labels.slice(0, 2).map((l) => (
									<span key={l} className="hidden sm:inline text-[0.6rem] px-1 py-0.5 bg-accent-soft text-accent rounded font-semibold shrink-0">{l}</span>
								))}
								<button
									type="button"
									onClick={() => onWorkOnIssue(repo, { number: i.number, title: i.title })}
									title="Pre-fill this issue as the objective"
									className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-line text-muted font-semibold hover:border-accent hover:text-accent"
								>
									<Play size={10} /> Work on this
								</button>
								{i.url && (
									<a href={i.url} target="_blank" rel="noreferrer" title="Open on GitHub" className="shrink-0 text-muted hover:text-accent">
										<ExternalLink size={12} />
									</a>
								)}
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
}
