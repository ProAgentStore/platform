import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";

interface Props {
	instanceId: string;
}

type IngestStatus = "none" | "fetching" | "indexing" | "summarizing" | "done" | "error";

interface RepoState {
	status: IngestStatus;
	repo?: string;
	repoUrl?: string;
	total?: number;
	done?: number;
	skipped?: number;
	paths?: string[];
	description?: string | null;
	language?: string | null;
	error?: string;
}

const ACTIVE: IngestStatus[] = ["fetching", "indexing", "summarizing"];

const PHASE_LABEL: Record<IngestStatus, string> = {
	none: "",
	fetching: "Downloading repository…",
	indexing: "Reading & indexing files…",
	summarizing: "Finishing up…",
	done: "Indexed",
	error: "Failed",
};

export default function RepoTab({ instanceId }: Props) {
	const [state, setState] = useState<RepoState>({ status: "none" });
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const [showFiles, setShowFiles] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const loadStatus = useCallback(async () => {
		try {
			const s = await api<RepoState>(`/v1/instances/${instanceId}/ingest-repo/status`);
			setState(s);
			return s.status;
		} catch {
			return "none" as IngestStatus;
		}
	}, [instanceId]);

	const stopPoll = () => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	};

	const startPoll = useCallback(() => {
		stopPoll();
		pollRef.current = setInterval(async () => {
			const status = await loadStatus();
			if (!ACTIVE.includes(status)) stopPoll();
		}, 1500);
	}, [loadStatus]);

	useEffect(() => {
		(async () => {
			const status = await loadStatus();
			if (ACTIVE.includes(status)) startPoll();
		})();
		return stopPoll;
	}, [loadStatus, startPoll]);

	const index = async (repoUrl: string) => {
		if (!repoUrl.trim()) return;
		setBusy(true);
		try {
			await api(`/v1/instances/${instanceId}/ingest-repo`, {
				method: "POST",
				body: JSON.stringify({ repoUrl: repoUrl.trim() }),
			});
			setState({ status: "fetching", repoUrl: repoUrl.trim() });
			startPoll();
		} catch (e) {
			setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		setBusy(true);
		stopPoll();
		try {
			await api(`/v1/instances/${instanceId}/ingest-repo/clear`, { method: "POST" });
		} catch {}
		setState({ status: "none" });
		setUrl("");
		setBusy(false);
	};

	const active = ACTIVE.includes(state.status);
	const pct = state.total ? Math.min(100, Math.round(((state.done || 0) / state.total) * 100)) : 0;

	// ── Idle: prompt for a repo URL ──────────────────────────────────────────
	if (state.status === "none") {
		return (
			<div className="max-w-xl mx-auto">
				<div className="bg-panel border border-line rounded-xl p-5">
					<h3 className="text-base font-bold mb-1">Chat with a repository</h3>
					<p className="text-sm text-muted mb-4">
						Paste any GitHub repository URL. I'll read the whole codebase into my knowledge base, then you can ask me how anything works in the Chat tab — by text or voice. I'm read-only: I explain, I never change your code.
					</p>
					<input
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && index(url)}
						placeholder="https://github.com/owner/repo"
						className="mb-3"
					/>
					<button
						type="button"
						onClick={() => index(url)}
						disabled={busy || !url.trim()}
						className="text-sm px-4 py-2 rounded-lg bg-accent text-white font-bold disabled:opacity-50"
					>
						{busy ? "Starting…" : "Index repository"}
					</button>
					<p className="text-xs text-muted-soft mt-3">
						Public repos work as-is. Private repos need GitHub connected. Large repos are capped at 300 files.
					</p>
				</div>
			</div>
		);
	}

	// ── Working / done / error ───────────────────────────────────────────────
	return (
		<div className="max-w-xl mx-auto">
			<div className="bg-panel border border-line rounded-xl p-5">
				<div className="flex items-center justify-between gap-2 mb-3">
					<div className="min-w-0">
						<div className="font-bold text-sm truncate">{state.repo || state.repoUrl || "Repository"}</div>
						<div className={`text-xs mt-0.5 ${state.status === "error" ? "text-red" : "text-muted"}`}>
							{PHASE_LABEL[state.status]}
						</div>
					</div>
					{state.status === "done" && <span className="text-xl shrink-0">✅</span>}
					{active && <span className="text-xl shrink-0 animate-pulse">⏳</span>}
					{state.status === "error" && <span className="text-xl shrink-0">⚠️</span>}
				</div>

				{active && (
					<>
						<div className="h-2 rounded-full bg-line overflow-hidden mb-2">
							<div className="h-full bg-accent transition-all" style={{ width: `${state.status === "fetching" ? 5 : pct}%` }} />
						</div>
						{state.status === "indexing" && (
							<p className="text-xs text-muted">{state.done || 0} / {state.total || 0} files indexed</p>
						)}
					</>
				)}

				{state.status === "done" && (
					<>
						{state.description && <p className="text-sm text-muted mb-3">{state.description}</p>}
						<p className="text-sm mb-3">
							Indexed <span className="font-bold">{state.total}</span> files
							{state.language ? <> · {state.language}</> : null}
							{state.skipped ? <span className="text-muted-soft"> · {state.skipped} skipped (caps)</span> : null}.
						</p>
						<p className="text-sm text-accent font-semibold mb-4">→ Switch to the Chat tab and ask me anything about it.</p>
						{state.paths && state.paths.length > 0 && (
							<div className="mb-4">
								<button type="button" onClick={() => setShowFiles((v) => !v)} className="text-xs text-muted hover:text-accent font-semibold">
									{showFiles ? "▾ Hide" : "▸ Show"} indexed files ({state.paths.length})
								</button>
								{showFiles && (
									<div className="mt-2 max-h-64 overflow-y-auto bg-base border border-line rounded-lg p-3 font-mono text-xs text-muted leading-relaxed">
										{state.paths.map((p) => <div key={p} className="truncate">{p}</div>)}
									</div>
								)}
							</div>
						)}
					</>
				)}

				{state.status === "error" && (
					<p className="text-sm text-red mb-4">{state.error || "Something went wrong indexing this repository."}</p>
				)}

				{!active && (
					<div className="flex gap-2 flex-wrap">
						{state.status === "done" && state.repoUrl && (
							<button type="button" onClick={() => index(state.repoUrl as string)} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold disabled:opacity-50">
								Re-index
							</button>
						)}
						<button type="button" onClick={clear} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold disabled:opacity-50">
							Index a different repo
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
