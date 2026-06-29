import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";

interface Props {
	instanceId: string;
}

type IngestStatus = "fetching" | "indexing" | "summarizing" | "done" | "error";

interface RepoState {
	key: string;
	repoUrl?: string;
	owner?: string;
	repo?: string;
	status: IngestStatus;
	total?: number;
	done?: number;
	failed?: number;
	skipped?: number;
	paths?: string[];
	description?: string | null;
	language?: string | null;
	error?: string;
}

const ACTIVE: IngestStatus[] = ["fetching", "indexing", "summarizing"];

const PHASE_LABEL: Record<IngestStatus, string> = {
	fetching: "Downloading…",
	indexing: "Indexing files…",
	summarizing: "Finishing up…",
	done: "Indexed",
	error: "Failed",
};

export default function RepoTab({ instanceId }: Props) {
	const [repos, setRepos] = useState<RepoState[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const loadStatus = useCallback(async () => {
		try {
			const d = await api<{ repos: RepoState[] }>(`/v1/instances/${instanceId}/ingest-repo/status`);
			setRepos(d.repos || []);
			setLoaded(true);
			return (d.repos || []).some((r) => ACTIVE.includes(r.status));
		} catch {
			setLoaded(true);
			return false;
		}
	}, [instanceId]);

	const stopPoll = () => {
		if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
	};
	const startPoll = useCallback(() => {
		stopPoll();
		pollRef.current = setInterval(async () => {
			const active = await loadStatus();
			if (!active) stopPoll();
		}, 1500);
	}, [loadStatus]);

	useEffect(() => {
		(async () => { if (await loadStatus()) startPoll(); })();
		return stopPoll;
	}, [loadStatus, startPoll]);

	const addRepo = async (repoUrl: string) => {
		if (!repoUrl.trim()) return;
		setBusy(true);
		setErr("");
		try {
			await api(`/v1/instances/${instanceId}/ingest-repo`, { method: "POST", body: JSON.stringify({ repoUrl: repoUrl.trim() }) });
			setUrl("");
			await loadStatus();
			startPoll();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const removeRepo = async (repoUrl?: string, key?: string) => {
		setBusy(true);
		setErr("");
		try {
			await api(`/v1/instances/${instanceId}/ingest-repo/clear`, { method: "POST", body: JSON.stringify({ repoUrl, key }) });
			await loadStatus();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="max-w-2xl mx-auto">
			{/* Add a repository */}
			<div className="bg-panel border border-line rounded-xl p-5 mb-4">
				<h3 className="text-base font-bold mb-1">Add a repository</h3>
				<p className="text-sm text-muted mb-3">
					Paste any GitHub URL. I'll read the whole codebase into my knowledge base, then you can ask about it in the Chat tab — by text or voice. You can index several repos and chat across all of them. Read-only: I explain, I never change your code.
				</p>
				<div className="flex gap-2">
					<input
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && addRepo(url)}
						placeholder="https://github.com/owner/repo"
						className="flex-1"
					/>
					<button type="button" onClick={() => addRepo(url)} disabled={busy || !url.trim()} className="text-sm px-4 py-2 rounded-lg bg-accent text-white font-bold disabled:opacity-50 shrink-0">
						{busy ? "…" : "Index"}
					</button>
				</div>
				{err && <p className="text-xs text-red mt-2">{err}</p>}
				<p className="text-xs text-muted-soft mt-2">Public repos work as-is. Private repos need GitHub connected. Up to 20 repos, 300 files each.</p>
			</div>

			{/* Indexed repositories */}
			{loaded && repos.length === 0 && (
				<p className="text-center py-6 text-muted-soft text-sm">No repositories yet. Add one above to start chatting with it.</p>
			)}
			<div className="flex flex-col gap-3">
				{repos.map((r) => {
					const active = ACTIVE.includes(r.status);
					const pct = r.total ? Math.min(100, Math.round(((r.done || 0) / r.total) * 100)) : 0;
					return (
						<div key={r.key} className="bg-panel border border-line rounded-xl p-4">
							<div className="flex items-center justify-between gap-2">
								<div className="min-w-0">
									<div className="font-bold text-sm truncate">{r.key}</div>
									<div className={`text-xs mt-0.5 ${r.status === "error" ? "text-red" : "text-muted"}`}>
										{PHASE_LABEL[r.status]}
										{r.status === "done" && <> · {r.total} files{r.language ? ` · ${r.language}` : ""}{r.skipped ? ` · ${r.skipped} skipped` : ""}{r.failed ? ` · ${r.failed} failed` : ""}</>}
										{r.status === "indexing" && <> · {r.done || 0}/{r.total || 0}</>}
									</div>
								</div>
								<div className="flex items-center gap-2 shrink-0">
									{r.status === "done" && <span className="text-lg">✅</span>}
									{active && <span className="text-lg animate-pulse">⏳</span>}
									{r.status === "error" && <span className="text-lg">⚠️</span>}
								</div>
							</div>

							{active && (
								<div className="h-1.5 rounded-full bg-line overflow-hidden mt-2">
									<div className="h-full bg-accent transition-all" style={{ width: `${r.status === "fetching" ? 5 : pct}%` }} />
								</div>
							)}
							{r.status === "done" && r.description && <p className="text-sm text-muted mt-2">{r.description}</p>}
							{r.status === "error" && <p className="text-sm text-red mt-2">{r.error || "Indexing failed."}</p>}

							{!active && (
								<div className="flex gap-3 mt-3 text-xs">
									{r.status === "done" && r.paths && r.paths.length > 0 && (
										<button type="button" onClick={() => setExpanded((e) => ({ ...e, [r.key]: !e[r.key] }))} className="text-muted hover:text-accent font-semibold">
											{expanded[r.key] ? "▾ Hide" : "▸ Show"} files ({r.paths.length})
										</button>
									)}
									{r.repoUrl && (
										<button type="button" onClick={() => addRepo(r.repoUrl as string)} disabled={busy} className="text-muted hover:text-accent font-semibold disabled:opacity-50">Re-index</button>
									)}
									<button type="button" onClick={() => removeRepo(r.repoUrl, r.key)} disabled={busy} className="text-muted hover:text-red font-semibold disabled:opacity-50">Remove</button>
								</div>
							)}

							{expanded[r.key] && r.paths && (
								<div className="mt-2 max-h-56 overflow-y-auto bg-base border border-line rounded-lg p-3 font-mono text-xs text-muted leading-relaxed">
									{r.paths.map((p) => <div key={p} className="truncate">{p}</div>)}
								</div>
							)}
						</div>
					);
				})}
			</div>

			{repos.some((r) => r.status === "done") && (
				<p className="text-sm text-accent font-semibold mt-4 text-center">→ Switch to the Chat tab and ask about your repositories.</p>
			)}
		</div>
	);
}
