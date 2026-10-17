import MarkdownText from "./MarkdownText";
import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { usePolling } from "@proagentstore/sdk/hooks";

/**
 * A board card's ordered action log (#1108) — every step the agent took on the card, oldest first,
 * for any task type. Reads `GET /v1/instances/:id/tasks/:taskId/actions`: pages forward with
 * `nextCursor`, and once caught up, polls from `tail` while the task runs so only new steps arrive.
 * Artifact URLs come from the server already reduced to origin + path (#1069).
 */
interface ActionArtifact {
	label: string;
	url: string;
}
interface ActionEntry {
	id: string;
	ts: string;
	actor: string;
	actionType: string;
	summary: string;
	status: "running" | "ok" | "error" | "skipped";
	artifacts: ActionArtifact[];
}
interface ActionLogPage {
	entries: ActionEntry[];
	hasMore: boolean;
	nextCursor: string | null;
	tail: string | null;
	total: number;
}

const STATUS_ICON: Record<ActionEntry["status"], string> = { running: "⏳", ok: "✓", error: "✕", skipped: "–" };
const STATUS_CLASS: Record<ActionEntry["status"], string> = { running: "text-accent", ok: "text-success", error: "text-danger", skipped: "text-muted-soft" };
const stamp = (t: string) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function ActionLog({ instanceId, taskId, running }: { instanceId: string; taskId: string; running: boolean }) {
	const [entries, setEntries] = useState<ActionEntry[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [total, setTotal] = useState(0);
	const [error, setError] = useState("");
	const base = `/v1/instances/${instanceId}/tasks/${encodeURIComponent(taskId)}/actions?limit=50`;

	const fetchFrom = useCallback(
		async (from: string | null) => {
			try {
				const page = await api<ActionLogPage>(`${base}${from ? `&cursor=${encodeURIComponent(from)}` : ""}`);
				setEntries((prev) => {
					const seen = new Set(prev.map((e) => e.id));
					return [...prev, ...page.entries.filter((e) => !seen.has(e.id))];
				});
				setHasMore(page.hasMore);
				setTotal(page.total);
				setCursor(page.tail ?? from);
				setError("");
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[base],
	);

	useEffect(() => {
		setEntries([]);
		setCursor(null);
		void fetchFrom(null);
	}, [fetchFrom]);

	// Live: once the whole log is loaded, poll from its tail while the task is still running.
	usePolling(() => fetchFrom(cursor), 3000, running && !hasMore);

	return (
		<div className="text-xs">
			{error && <p className="text-danger mb-1">Could not load the action log: {error}</p>}
			{!error && entries.length === 0 && <p className="text-muted-soft">No actions recorded on this card yet.</p>}
			<ol className="space-y-1">
				{entries.map((e) => (
					<li key={e.id} className="flex gap-2 items-start">
						<span className={`w-4 shrink-0 text-center ${STATUS_CLASS[e.status]}`} title={e.status}>
							{STATUS_ICON[e.status]}
						</span>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap gap-1.5 items-center text-2xs text-muted-soft">
								<span>{stamp(e.ts)}</span>
								<span className="px-1 rounded border border-line">{e.actionType}</span>
								<span>{e.actor}</span>
							</div>
							<MarkdownText text={e.summary} />
							{e.artifacts.length > 0 && (
								<div className="flex flex-wrap gap-2 text-2xs">
									{e.artifacts.map((a) => (
										<a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer" className="text-accent underline break-all">
											{a.label}
										</a>
									))}
								</div>
							)}
						</div>
					</li>
				))}
			</ol>
			{hasMore && (
				<button type="button" onClick={() => void fetchFrom(cursor)} className="mt-1 text-2xs text-accent underline">
					Load more ({entries.length} of {total})
				</button>
			)}
		</div>
	);
}

/** The board card's toggle: the log opens inline, under the card, and polls only while open. */
export function CardActionLog({ instanceId, taskId, running }: { instanceId: string; taskId: string; running: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="mt-2">
			<button type="button" onClick={() => setOpen(!open)} className="text-2xs text-muted hover:text-accent" aria-expanded={open}>
				{open ? "▾ Hide log" : "▸ Action log"}
			</button>
			{open && (
				<div className="mt-1 max-h-72 overflow-y-auto border-t border-line/60 pt-1">
					<ActionLog instanceId={instanceId} taskId={taskId} running={running} />
				</div>
			)}
		</div>
	);
}
