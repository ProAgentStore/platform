import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { BoardColumn } from "../lib/types";
import { formatTime } from "@proagentstore/sdk/ui";
import { usePolling } from "@proagentstore/sdk/hooks";

// The single, agent-configurable work board. The server (lib/board.ts) is the ONE
// place the board shape is defined: it groups runtime-task retries into one card
// per job, resolves the agent's configured columns, and applies the durable human
// status override. This tab just renders columns + cards and lets the user MOVE a
// card (into a pipeline column the automation never sets) or drill into attempts.

const GENERIC_COLUMNS: BoardColumn[] = [
	{ id: "waiting", title: "Waiting", color: "#eab308", statuses: ["queued", "needs_approval"] },
	{ id: "running", title: "Running", color: "#3b82f6", statuses: ["running"] },
	{ id: "needs_human", title: "Needs you", color: "#f59e0b", statuses: ["needs_human"] },
	{ id: "failed", title: "Failed", color: "#ef4444", statuses: ["failed"] },
	{ id: "blocked", title: "Blocked", color: "#f97316", statuses: ["blocked"] },
	{ id: "done", title: "Done", color: "#22c55e", statuses: ["completed"] },
	{ id: "cancelled", title: "Cancelled", color: "#a3a3a3", statuses: ["cancelled"] },
];

interface BoardAttempt { id: string; status: string; updatedAt: string }
interface BoardItem {
	jobKey: string;
	latestTaskId: string;
	title: string;
	subtitle: string;
	description: string;
	url: string;
	runStatus: string;
	userStatus: string | null;
	status: string;
	attempts: BoardAttempt[];
	updatedAt: string;
}

export default function BoardTab({ instanceId, columns }: { instanceId: string; columns?: BoardColumn[] }) {
	const navigate = useNavigate();
	const [items, setItems] = useState<BoardItem[]>([]);
	const [serverCols, setServerCols] = useState<BoardColumn[] | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);

	const cols = serverCols && serverCols.length ? serverCols : (columns && columns.length ? columns : GENERIC_COLUMNS);

	const loadBoard = useCallback(async () => {
		try {
			const data = await api<{ columns?: BoardColumn[]; items?: BoardItem[] }>(`/v1/instances/${instanceId}/board`);
			setItems(data.items || []);
			if (data.columns?.length) setServerCols(data.columns);
		} catch {}
	}, [instanceId]);

	useEffect(() => { loadBoard(); }, [loadBoard]);
	usePolling(loadBoard, 2500);

	const finishedStatuses = ["completed", "cancelled", "failed", "blocked", "expired", "rejected"];
	const finishedCount = items.filter((it) => finishedStatuses.includes(it.status)).length;

	// Assign each job to exactly one column; unmatched jobs fall into a trailing
	// "Other" bucket so a card is never silently dropped.
	const byColumn = new Map<string, BoardItem[]>();
	const other: BoardItem[] = [];
	for (const it of items) {
		const colId = columnFor(cols, it.status);
		if (colId) (byColumn.get(colId) ?? byColumn.set(colId, []).get(colId)!).push(it);
		else other.push(it);
	}

	const setStatus = async (jobKey: string, status: string) => {
		try {
			await api(`/v1/instances/${instanceId}/board/status`, { method: "POST", body: JSON.stringify({ jobKey, status }) });
			loadBoard();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const handleDeleteItem = async (item: BoardItem) => {
		try {
			await Promise.all(item.attempts.map((a) => api(`/v1/instances/${instanceId}/tasks/${a.id}`, { method: "DELETE" })));
			loadBoard();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const handleClearFinished = async () => {
		if (!finishedCount || !confirm(`Remove ${finishedCount} finished job${finishedCount !== 1 ? "s" : ""} from the board? This can't be undone.`)) return;
		try {
			await api(`/v1/instances/${instanceId}/tasks/clear-finished`, { method: "POST" });
			loadBoard();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const renderCols = [...cols, ...(other.length ? [{ id: "__other", title: "Other", color: "#a3a3a3" } as BoardColumn] : [])];

	return (
		<div>
			<div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
				<div>
					<h3 className="text-base font-bold mb-0.5">Board</h3>
					<div className="text-xs text-muted">{items.length} job{items.length !== 1 ? "s" : ""}</div>
				</div>
				<div className="flex items-center gap-2">
					{finishedCount > 0 && (
						<button
							type="button"
							onClick={handleClearFinished}
							className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-red hover:text-red font-semibold"
						>
							Clear finished ({finishedCount})
						</button>
					)}
					<button
						type="button"
						onClick={loadBoard}
						className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold"
					>
						Refresh
					</button>
				</div>
			</div>

			<div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3 items-start mb-4">
				{renderCols.map((col) => {
					const colItems = col.id === "__other" ? other : (byColumn.get(col.id) ?? []);
					return (
						<div key={col.id} className="border border-line rounded-xl bg-panel/55 min-h-[180px]">
							<div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-line">
								<div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide">
									<span className="w-2.5 h-2.5 rounded-full" style={{ background: col.color }} />
									{col.title}
								</div>
								<span className="text-[0.7rem] text-muted border border-line rounded-full px-1.5 py-0.5 font-bold">{colItems.length}</span>
							</div>
							<div className="flex flex-col gap-2 p-2.5">
								{colItems.length === 0 ? (
									<div className="text-center text-muted-soft text-sm py-4">No jobs</div>
								) : (
									colItems.map((item) => (
										<ItemCard
											key={item.jobKey}
											item={item}
											cols={cols}
											expanded={expanded === item.jobKey}
											onToggleAttempts={() => setExpanded(expanded === item.jobKey ? null : item.jobKey)}
											onOpen={(taskId) => navigate(`/instances/${instanceId}/tasks/${taskId}`)}
											onMove={(status) => setStatus(item.jobKey, status)}
											onDelete={() => handleDeleteItem(item)}
										/>
									))
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function ItemCard({ item, cols, expanded, onToggleAttempts, onOpen, onMove, onDelete }: {
	item: BoardItem;
	cols: BoardColumn[];
	expanded: boolean;
	onToggleAttempts: () => void;
	onOpen: (taskId: string) => void;
	onMove: (status: string) => void;
	onDelete: () => void;
}) {
	const isFinished = ["completed", "cancelled", "failed", "blocked", "expired", "rejected"].includes(item.status);
	// Current selection: the column holding this card, or "__auto" when no override.
	const currentCol = columnFor(cols, item.status) ?? "";
	const selectValue = item.userStatus ? currentCol : "__auto";
	return (
		<div className="relative bg-paper border border-line rounded-lg p-3 transition-all hover:border-accent">
			{isFinished && (
				<button
					type="button"
					title="Remove from board"
					onClick={(e) => { e.stopPropagation(); onDelete(); }}
					className="absolute top-1.5 right-1.5 w-6 h-6 flex items-center justify-center rounded-md text-muted-soft hover:text-red hover:bg-red/10 text-base leading-none"
				>
					✕
				</button>
			)}
			<button type="button" onClick={() => onOpen(item.latestTaskId)} className="text-left w-full cursor-pointer">
				<h3 className="text-sm font-bold mb-0.5 break-words pr-6">{item.title}</h3>
				{item.subtitle && <p className="text-[0.7rem] text-muted-soft mb-1 line-clamp-1">{item.subtitle}</p>}
				{item.description && <p className="text-xs text-muted line-clamp-2 mb-2">{item.description}</p>}
				<div className="flex gap-1.5 flex-wrap items-center text-[0.7rem]">
					<span className={`px-1.5 py-0.5 rounded font-medium ${statusClass(item.status)}`}>{item.status}</span>
					{item.userStatus && <span className="text-muted-soft" title={`Automation: ${item.runStatus}`}>moved</span>}
					{item.updatedAt && <span className="text-muted-soft">{formatTime(item.updatedAt)}</span>}
				</div>
			</button>

			<div className="flex items-center gap-2 mt-2 pt-2 border-t border-line/60">
				{/* Move to any column (pipeline stages the automation never sets). */}
				<select
					value={selectValue}
					onClick={(e) => e.stopPropagation()}
					onChange={(e) => { const v = e.target.value; onMove(v === "__auto" ? "" : (cols.find((c) => c.id === v)?.statuses?.[0] ?? v)); }}
					className="text-[0.7rem] bg-panel border border-line rounded px-1.5 py-1 text-muted max-w-[8rem]"
					title="Move to column"
				>
					<option value="__auto">Auto (follow run)</option>
					{cols.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
				</select>
				{item.attempts.length > 1 && (
					<button
						type="button"
						onClick={(e) => { e.stopPropagation(); onToggleAttempts(); }}
						className="text-[0.7rem] px-1.5 py-1 rounded border border-line text-muted hover:border-accent hover:text-accent font-medium ml-auto"
						title="Show attempts"
					>
						×{item.attempts.length} runs {expanded ? "▲" : "▼"}
					</button>
				)}
			</div>

			{expanded && item.attempts.length > 1 && (
				<div className="mt-2 flex flex-col gap-1">
					{item.attempts.map((a, i) => (
						<button
							key={a.id}
							type="button"
							onClick={(e) => { e.stopPropagation(); onOpen(a.id); }}
							className="flex items-center justify-between gap-2 text-[0.7rem] px-2 py-1 rounded bg-panel/60 border border-line hover:border-accent text-left"
						>
							<span className="text-ink">Attempt {item.attempts.length - i}{i === 0 ? " (latest)" : ""}</span>
							<span className={`px-1 rounded ${statusClass(a.status)}`}>{a.status}</span>
							{a.updatedAt && <span className="text-muted-soft shrink-0">{formatTime(a.updatedAt)}</span>}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** Which column an item's status belongs to: first matching `statuses`, else catchAll. */
function columnFor(cols: BoardColumn[], status: string): string | null {
	for (const c of cols) if (c.statuses?.includes(status)) return c.id;
	const catchAll = cols.find((c) => c.catchAll);
	return catchAll ? catchAll.id : null;
}

function statusClass(status: string): string {
	switch (status) {
		case "queued": case "needs_approval": return "bg-yellow/15 text-yellow";
		case "running": return "bg-blue/15 text-blue";
		case "needs_human": return "bg-amber-500/15 text-amber-500";
		case "completed": case "submitted": case "offer": case "accepted": return "bg-green/15 text-green";
		case "interview": return "bg-violet-500/15 text-violet-500";
		case "failed": return "bg-red/15 text-red";
		case "blocked": return "bg-orange-500/15 text-orange-500";
		case "rejected": case "cancelled": return "bg-muted/15 text-muted";
		default: return "bg-muted/15 text-muted";
	}
}
