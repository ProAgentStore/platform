import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { BoardColumn } from "../lib/types";
import { formatTime } from "@proagentstore/sdk/ui";
import { usePolling } from "@proagentstore/sdk/hooks";
import { LayoutGrid, List, SlidersHorizontal, Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";

type BoardView = "kanban" | "list";

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

export default function BoardTab({ instanceId, columns, apply }: { instanceId: string; columns?: BoardColumn[]; apply?: boolean }) {
	const navigate = useNavigate();
	const [items, setItems] = useState<BoardItem[]>([]);
	const [serverCols, setServerCols] = useState<BoardColumn[] | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [truncated, setTruncated] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [retrying, setRetrying] = useState<Set<string>>(new Set());
	const [view, setView] = useState<BoardView>("kanban");
	const [editingCols, setEditingCols] = useState(false);
	// Only adopt the server's saved view on first load — otherwise every 2.5s poll
	// would yank the user back out of a view they just toggled.
	const viewInit = useRef(false);

	const cols = serverCols?.length ? serverCols : (columns?.length ? columns : GENERIC_COLUMNS);

	const loadBoard = useCallback(async () => {
		try {
			const data = await api<{ columns?: BoardColumn[]; items?: BoardItem[]; view?: BoardView; truncated?: boolean }>(`/v1/instances/${instanceId}/board`);
			setItems(data.items || []);
			if (data.columns?.length) setServerCols(data.columns);
			if (!viewInit.current && (data.view === "kanban" || data.view === "list")) { setView(data.view); viewInit.current = true; }
			setTruncated(data.truncated === true);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't load the board");
		}
	}, [instanceId]);

	// Persist the view choice (config.boardView) so it follows the user + is readable
	// by MCP / the agent. Optimistic: flip locally first, then save.
	const changeView = useCallback(async (v: BoardView) => {
		setView(v);
		viewInit.current = true;
		try { await api(`/v1/instances/${instanceId}/board-config`, { method: "PUT", body: JSON.stringify({ view: v }) }); } catch { /* non-fatal */ }
	}, [instanceId]);

	useEffect(() => { loadBoard(); }, [loadBoard]);
	usePolling(loadBoard, 2500);

	// Bulk-clearable = terminal automation outcomes. Deliberately excludes `blocked`
	// (needs you) and human pipeline stages (interview/offer/rejected) — mirrors the
	// server's FINISHED_STATUSES so the count matches what Clear finished removes.
	const finishedStatuses = ["completed", "submitted", "failed", "cancelled", "expired"];
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

	// Send a snapshot of the display fields so a moved card can stand alone once its
	// runs are cleared. Empty status resets to automation (clears the durable row).
	const setStatus = async (item: BoardItem, status: string) => {
		try {
			await api(`/v1/instances/${instanceId}/board/status`, {
				method: "POST",
				body: JSON.stringify({ jobKey: item.jobKey, status, title: item.title, subtitle: item.subtitle, url: item.url }),
			});
			loadBoard();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	// Approve a task waiting for approval (generic runner tasks that require a human
	// OK before they run, e.g. browser.open). Acts on the job's latest task.
	const handleApprove = async (item: BoardItem) => {
		if (!item.latestTaskId) return;
		try {
			await api(`/v1/instances/${instanceId}/tasks/${item.latestTaskId}/approve`, { method: "POST" });
			loadBoard();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	// Re-run a job (apply agents): kick off a fresh application for the same URL.
	// The new run shows up as this job's newest attempt on the next poll.
	const handleRetry = async (item: BoardItem) => {
		if (!item.url || retrying.has(item.jobKey)) return; // guard double-fire (single-flight)
		setRetrying((s) => new Set(s).add(item.jobKey));
		try {
			await api(`/v1/instances/${instanceId}/apply`, { method: "POST", body: JSON.stringify({ url: item.url }) });
			loadBoard();
		} catch (e) {
			// startJobApply rejects with a clear message: single-flight (409), no runner,
			// no résumé/profile — surface it so the user knows what to fix.
			alert(e instanceof Error ? e.message : String(e));
		} finally {
			setRetrying((s) => { const n = new Set(s); n.delete(item.jobKey); return n; });
		}
	};

	const handleDeleteItem = async (item: BoardItem) => {
		try {
			// Hide the runtime tasks AND clear any durable overlay row (status "").
			await Promise.all(item.attempts.map((a) => api(`/v1/instances/${instanceId}/tasks/${a.id}`, { method: "DELETE" })));
			if (item.userStatus) await api(`/v1/instances/${instanceId}/board/status`, { method: "POST", body: JSON.stringify({ jobKey: item.jobKey, status: "" }) });
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

	// Shared per-card wiring so the Kanban card and the List row behave identically.
	const itemProps = (item: BoardItem) => ({
		item,
		cols,
		expanded: expanded === item.jobKey,
		onToggleAttempts: () => setExpanded(expanded === item.jobKey ? null : item.jobKey),
		onOpen: (taskId: string) => { if (taskId) navigate(`/instances/${instanceId}/tasks/${taskId}`); },
		onMove: (status: string) => setStatus(item, status),
		onRetry: apply && item.url && ["failed", "blocked"].includes(item.status) ? () => handleRetry(item) : undefined,
		onApprove: item.status === "needs_approval" ? () => handleApprove(item) : undefined,
		retrying: retrying.has(item.jobKey),
		onDelete: () => handleDeleteItem(item),
	});

	return (
		<div>
			<div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
				<div>
					<h3 className="text-base font-bold mb-0.5">Board</h3>
					<div className="text-xs text-muted">{items.length} job{items.length !== 1 ? "s" : ""}</div>
				</div>
				<div className="flex items-center gap-2 flex-wrap">
					{/* View toggle — Kanban ⇄ List (persisted per-instance). */}
					<div className="flex border border-line rounded-lg overflow-hidden">
						<button type="button" onClick={() => changeView("kanban")} title="Board view" aria-pressed={view === "kanban"} className={`flex items-center gap-1 px-2 py-1.5 text-xs font-bold ${view === "kanban" ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel-hover"}`}><LayoutGrid size={13} /><span className="hidden sm:inline">Board</span></button>
						<button type="button" onClick={() => changeView("list")} title="List view" aria-pressed={view === "list"} className={`flex items-center gap-1 px-2 py-1.5 text-xs font-bold ${view === "list" ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel-hover"}`}><List size={13} /><span className="hidden sm:inline">List</span></button>
					</div>
					<button
						type="button"
						onClick={() => setEditingCols(true)}
						title="Customize columns"
						className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold"
					>
						<SlidersHorizontal size={13} /><span className="hidden sm:inline">Columns</span>
					</button>
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

			{error && (
				<div className="mb-3 text-xs px-3 py-2 rounded-lg bg-red/10 border border-red/30 text-red">
					Couldn't refresh the board: {error}
				</div>
			)}
			{truncated && (
				<div className="mb-3 text-xs px-3 py-2 rounded-lg bg-yellow/10 border border-yellow/30 text-yellow">
					Showing your most recent jobs — some older jobs are hidden.
				</div>
			)}

			{view === "kanban" ? (
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
										colItems.map((item) => <ItemCard key={item.jobKey} {...itemProps(item)} />)
									)}
								</div>
							</div>
						);
					})}
				</div>
			) : (
				<div className="flex flex-col gap-4 mb-4">
					{renderCols.map((col) => {
						const colItems = col.id === "__other" ? other : (byColumn.get(col.id) ?? []);
						if (colItems.length === 0) return null;
						return (
							<div key={col.id}>
								<div className="flex items-center gap-1.5 mb-1.5 text-xs font-extrabold uppercase tracking-wide text-muted">
									<span className="w-2.5 h-2.5 rounded-full" style={{ background: col.color }} />
									{col.title}
									<span className="text-[0.7rem] text-muted-soft border border-line rounded-full px-1.5 py-0.5 font-bold">{colItems.length}</span>
								</div>
								<div className="border border-line rounded-xl overflow-hidden divide-y divide-line">
									{colItems.map((item) => <ListRow key={item.jobKey} {...itemProps(item)} />)}
								</div>
							</div>
						);
					})}
					{items.length === 0 && <div className="text-center text-muted-soft text-sm py-8 border border-line rounded-xl">No jobs yet</div>}
				</div>
			)}

			{editingCols && (
				<ColumnEditor
					instanceId={instanceId}
					current={cols}
					onClose={() => setEditingCols(false)}
					onSaved={() => { setServerCols(null); viewInit.current = true; loadBoard(); setEditingCols(false); }}
				/>
			)}
		</div>
	);
}

function ItemCard({ item, cols, expanded, onToggleAttempts, onOpen, onMove, onRetry, onApprove, retrying, onDelete }: {
	item: BoardItem;
	cols: BoardColumn[];
	expanded: boolean;
	onToggleAttempts: () => void;
	onOpen: (taskId: string) => void;
	onMove: (status: string) => void;
	onRetry?: () => void;
	onApprove?: () => void;
	retrying?: boolean;
	onDelete: () => void;
}) {
	const isFinished = ["completed", "cancelled", "failed", "blocked", "expired", "rejected"].includes(item.status);
	// A moved card whose runs are gone stands alone — no run to open.
	const openable = !!item.latestTaskId;
	// Current selection: the column holding this card, or "__auto" when no override.
	const currentCol = columnFor(cols, item.status) ?? "";
	const selectValue = item.userStatus ? currentCol : "__auto";
	return (
		<div className="relative bg-paper border border-line rounded-lg p-3 transition-all hover:border-accent">
			{(isFinished || !openable) && (
				<button
					type="button"
					title="Remove from board"
					onClick={(e) => { e.stopPropagation(); onDelete(); }}
					className="absolute top-1.5 right-1.5 w-6 h-6 flex items-center justify-center rounded-md text-muted-soft hover:text-red hover:bg-red/10 text-base leading-none"
				>
					✕
				</button>
			)}
			<button type="button" onClick={() => onOpen(item.latestTaskId)} disabled={!openable} className={`text-left w-full ${openable ? "cursor-pointer" : "cursor-default"}`}>
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
				{onApprove && (
					<button
						type="button"
						onClick={(e) => { e.stopPropagation(); onApprove(); }}
						className="text-[0.7rem] px-2 py-1 rounded border border-green/40 text-green hover:bg-green/10 font-bold"
						title="Approve this task to run"
					>
						Approve
					</button>
				)}
				{onRetry && (
					<button
						type="button"
						disabled={retrying}
						onClick={(e) => { e.stopPropagation(); onRetry(); }}
						className="text-[0.7rem] px-2 py-1 rounded border border-line text-accent hover:bg-accent/10 font-bold disabled:opacity-40"
						title="Re-run this application"
					>
						{retrying ? "↻ Retrying…" : "↻ Retry"}
					</button>
				)}
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

/** A compact one-line row for the List view — same actions as the Kanban card. */
function ListRow({ item, cols, expanded, onToggleAttempts, onOpen, onMove, onRetry, onApprove, retrying, onDelete }: {
	item: BoardItem;
	cols: BoardColumn[];
	expanded: boolean;
	onToggleAttempts: () => void;
	onOpen: (taskId: string) => void;
	onMove: (status: string) => void;
	onRetry?: () => void;
	onApprove?: () => void;
	retrying?: boolean;
	onDelete: () => void;
}) {
	const isFinished = ["completed", "cancelled", "failed", "blocked", "expired", "rejected"].includes(item.status);
	const openable = !!item.latestTaskId;
	const currentCol = columnFor(cols, item.status) ?? "";
	const selectValue = item.userStatus ? currentCol : "__auto";
	return (
		<div className="bg-paper hover:bg-panel-hover transition-colors">
			<div className="flex items-center gap-2 px-3 py-2 flex-wrap">
				<button type="button" onClick={() => onOpen(item.latestTaskId)} disabled={!openable} className={`flex-1 min-w-[9rem] text-left ${openable ? "cursor-pointer" : "cursor-default"}`}>
					<div className="flex items-baseline gap-2 min-w-0">
						<span className="text-sm font-bold truncate">{item.title}</span>
						{item.subtitle && <span className="text-[0.7rem] text-muted-soft truncate hidden sm:inline">{item.subtitle}</span>}
					</div>
					{item.description && <p className="text-xs text-muted line-clamp-1">{item.description}</p>}
				</button>
				<span className={`shrink-0 px-1.5 py-0.5 rounded text-[0.7rem] font-medium ${statusClass(item.status)}`}>{item.status}</span>
				{item.userStatus && <span className="shrink-0 text-[0.7rem] text-muted-soft hidden sm:inline" title={`Automation: ${item.runStatus}`}>moved</span>}
				{item.updatedAt && <span className="shrink-0 text-[0.7rem] text-muted-soft hidden md:inline">{formatTime(item.updatedAt)}</span>}
				{onApprove && (
					<button type="button" onClick={onApprove} className="shrink-0 text-[0.7rem] px-2 py-1 rounded border border-green/40 text-green hover:bg-green/10 font-bold" title="Approve this task to run">Approve</button>
				)}
				{onRetry && (
					<button type="button" disabled={retrying} onClick={onRetry} className="shrink-0 text-[0.7rem] px-2 py-1 rounded border border-line text-accent hover:bg-accent/10 font-bold disabled:opacity-40" title="Re-run this application">{retrying ? "↻…" : "↻ Retry"}</button>
				)}
				<select
					value={selectValue}
					onChange={(e) => { const v = e.target.value; onMove(v === "__auto" ? "" : (cols.find((c) => c.id === v)?.statuses?.[0] ?? v)); }}
					className="shrink-0 text-[0.7rem] bg-panel border border-line rounded px-1.5 py-1 text-muted max-w-[8rem]"
					title="Move to column"
				>
					<option value="__auto">Auto</option>
					{cols.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
				</select>
				{item.attempts.length > 1 && (
					<button type="button" onClick={onToggleAttempts} className="shrink-0 text-[0.7rem] px-1.5 py-1 rounded border border-line text-muted hover:border-accent hover:text-accent font-medium" title="Show attempts">×{item.attempts.length} {expanded ? "▲" : "▼"}</button>
				)}
				{(isFinished || !openable) && (
					<button type="button" title="Remove from board" onClick={onDelete} className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-muted-soft hover:text-red hover:bg-red/10 text-base leading-none">✕</button>
				)}
			</div>
			{expanded && item.attempts.length > 1 && (
				<div className="flex flex-col gap-1 px-3 pb-2">
					{item.attempts.map((a, i) => (
						<button key={a.id} type="button" onClick={() => onOpen(a.id)} className="flex items-center justify-between gap-2 text-[0.7rem] px-2 py-1 rounded bg-panel/60 border border-line hover:border-accent text-left">
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

/** Editing shape for one column — statuses held as raw text so typing commas isn't fought. */
interface DraftCol { id: string; title: string; color: string; statusesText: string; catchAll?: boolean }

/** Add / rename / recolor / reorder / remove the instance's board columns. Saves a
 *  per-instance override via PUT /board-config; "Reset" drops it back to the agent's. */
function ColumnEditor({ instanceId, current, onClose, onSaved }: {
	instanceId: string;
	current: BoardColumn[];
	onClose: () => void;
	onSaved: () => void;
}) {
	const [draft, setDraft] = useState<DraftCol[]>(() =>
		current.filter((c) => c.id !== "__other").map((c) => ({ id: c.id, title: c.title, color: c.color || "#a3a3a3", statusesText: (c.statuses ?? []).join(", "), catchAll: c.catchAll })),
	);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const patch = (i: number, p: Partial<DraftCol>) => setDraft((d) => d.map((c, idx) => (idx === i ? { ...c, ...p } : c)));
	const remove = (i: number) => setDraft((d) => d.filter((_, idx) => idx !== i));
	const swap = (i: number, dir: -1 | 1) => setDraft((d) => { const j = i + dir; if (j < 0 || j >= d.length) return d; const n = [...d]; [n[i], n[j]] = [n[j], n[i]]; return n; });
	const addCol = () => setDraft((d) => [...d, { id: "", title: "New column", color: "#a3a3a3", statusesText: "" }]);
	// Exactly one catchAll column — toggling one clears the others.
	const toggleCatchAll = (i: number) => setDraft((d) => d.map((c, idx) => ({ ...c, catchAll: idx === i ? !c.catchAll : false })));

	const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "col";

	const build = (): BoardColumn[] | null => {
		if (!draft.length) { setErr("Add at least one column."); return null; }
		const seen = new Set<string>();
		const out: BoardColumn[] = [];
		for (const c of draft) {
			const title = c.title.trim();
			if (!title) { setErr("Every column needs a title."); return null; }
			let id = slug(c.id || title);
			let uid = id, n = 2;
			while (seen.has(uid)) uid = `${id}-${n++}`;
			seen.add(uid);
			const statuses = c.statusesText.split(",").map((s) => s.trim()).filter(Boolean);
			out.push({ id: uid, title, color: c.color || "#a3a3a3", statuses: statuses.length ? statuses : undefined, catchAll: c.catchAll || undefined });
		}
		return out;
	};

	const save = async () => {
		const cols = build();
		if (!cols) return;
		setSaving(true); setErr(null);
		try { await api(`/v1/instances/${instanceId}/board-config`, { method: "PUT", body: JSON.stringify({ columns: cols }) }); onSaved(); }
		catch (e) { setErr(e instanceof Error ? e.message : "Save failed"); setSaving(false); }
	};

	const reset = async () => {
		if (!confirm("Reset to the agent's default columns? Your custom columns will be removed.")) return;
		setSaving(true); setErr(null);
		try { await api(`/v1/instances/${instanceId}/board-config`, { method: "PUT", body: JSON.stringify({ columns: null }) }); onSaved(); }
		catch (e) { setErr(e instanceof Error ? e.message : "Reset failed"); setSaving(false); }
	};

	return (
		<div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
			<div className="bg-panel border border-line rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[88dvh] overflow-y-auto overscroll-contain p-4" style={{ WebkitOverflowScrolling: "touch" }}>
				<div className="flex items-center justify-between gap-3 mb-1">
					<h3 className="text-base font-bold flex items-center gap-1.5"><SlidersHorizontal size={16} /> Board columns</h3>
					<button type="button" onClick={onClose} className="text-muted hover:text-ink text-lg leading-none">✕</button>
				</div>
				<p className="text-xs text-muted mb-3">Cards land in the first column whose statuses include their status, else the <b>catch-all</b> column. Statuses are comma-separated (e.g. <code className="text-accent">queued, needs_approval</code>).</p>

				<div className="flex flex-col gap-2">
					{draft.map((c, i) => (
						<div key={i} className="border border-line rounded-xl p-2.5 bg-paper flex flex-col gap-2">
							<div className="flex items-center gap-2">
								<input type="color" value={/^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : "#a3a3a3"} onChange={(e) => patch(i, { color: e.target.value })} className="w-7 h-7 rounded border border-line bg-panel shrink-0 cursor-pointer" title="Column color" aria-label="Column color" />
								<input value={c.title} onChange={(e) => patch(i, { title: e.target.value })} placeholder="Column title" className="flex-1 min-w-0 bg-panel border border-line rounded-lg px-2.5 py-1.5 text-sm" />
								<div className="flex items-center gap-0.5 shrink-0">
									<button type="button" onClick={() => swap(i, -1)} disabled={i === 0} className="w-7 h-7 flex items-center justify-center rounded border border-line text-muted hover:text-accent disabled:opacity-30" title="Move up"><ArrowUp size={13} /></button>
									<button type="button" onClick={() => swap(i, 1)} disabled={i === draft.length - 1} className="w-7 h-7 flex items-center justify-center rounded border border-line text-muted hover:text-accent disabled:opacity-30" title="Move down"><ArrowDown size={13} /></button>
									<button type="button" onClick={() => remove(i)} className="w-7 h-7 flex items-center justify-center rounded border border-line text-muted hover:text-red hover:border-red" title="Remove column"><Trash2 size={13} /></button>
								</div>
							</div>
							<div className="flex items-center gap-2 flex-wrap">
								<input value={c.statusesText} onChange={(e) => patch(i, { statusesText: e.target.value })} placeholder="statuses (comma-separated) — optional for manual columns" className="flex-1 min-w-[10rem] bg-panel border border-line rounded-lg px-2.5 py-1.5 text-xs font-mono" />
								<label className="flex items-center gap-1.5 text-xs text-muted shrink-0 cursor-pointer">
									<input type="checkbox" checked={!!c.catchAll} onChange={() => toggleCatchAll(i)} /> Catch-all
								</label>
							</div>
						</div>
					))}
				</div>

				<button type="button" onClick={addCol} className="mt-2 flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-line text-muted hover:border-accent hover:text-accent font-semibold"><Plus size={13} /> Add column</button>

				{err && <div className="mt-3 text-xs px-3 py-2 rounded-lg bg-red/10 border border-red/30 text-red">{err}</div>}

				<div className="flex items-center justify-between gap-2 mt-4">
					<button type="button" onClick={reset} disabled={saving} className="text-xs px-3 py-1.5 rounded-md border border-line text-muted hover:border-red hover:text-red font-semibold disabled:opacity-50">Reset to default</button>
					<div className="flex gap-2">
						<button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-line text-muted font-semibold">Cancel</button>
						<button type="button" onClick={save} disabled={saving} className="text-xs px-3 py-1.5 rounded-md bg-accent text-white font-bold disabled:opacity-50">{saving ? "Saving…" : "Save columns"}</button>
					</div>
				</div>
			</div>
		</div>
	);
}

/** Which column an item's status belongs to: first matching `statuses`, else catchAll. */
function columnFor(cols: BoardColumn[], status: string): string | null {
	for (const c of cols) if (c.statuses?.includes(status) || c.id === status) return c.id;
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
