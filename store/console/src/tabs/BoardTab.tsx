import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { RuntimeTask, BoardColumn } from "../lib/types";
import { formatTime } from "@proagentstore/sdk/ui";
import { usePolling } from "@proagentstore/sdk/hooks";

// The single, agent-configurable work board. The platform provides the kanban;
// each agent declares its columns/statuses (capabilities.boardColumns, resolved
// server-side with a per-surface default). Cards are ONE per work item (a job,
// an objective…) — retries of the same job collapse into one card instead of a
// new row — and each opens the rich run-detail page (timeline, screenshot replay,
// live browser takeover) rather than a shallow modal.

const GENERIC_COLUMNS: BoardColumn[] = [
	{ id: "waiting", title: "Waiting", color: "#eab308", statuses: ["queued", "needs_approval"] },
	{ id: "running", title: "Running", color: "#3b82f6", statuses: ["running"] },
	{ id: "needs_human", title: "Needs you", color: "#f59e0b", statuses: ["needs_human"] },
	{ id: "failed", title: "Failed", color: "#ef4444", statuses: ["failed"] },
	{ id: "blocked", title: "Blocked", color: "#f97316", statuses: ["blocked"] },
	{ id: "done", title: "Done", color: "#22c55e", statuses: ["completed"] },
	{ id: "cancelled", title: "Cancelled", color: "#a3a3a3", statuses: ["cancelled"] },
];

/** A job = one card. Group its runtime tasks (attempts) under a stable key. */
interface BoardItem {
	key: string;
	rep: RuntimeTask; // the latest attempt — drives the card's status + label
	attempts: RuntimeTask[]; // newest-first
}

export default function BoardTab({ instanceId, columns }: { instanceId: string; columns?: BoardColumn[] }) {
	const navigate = useNavigate();
	const cols = columns && columns.length ? columns : GENERIC_COLUMNS;
	const [tasks, setTasks] = useState<RuntimeTask[]>([]);

	const loadBoard = useCallback(async () => {
		try {
			const taskData = await api<{ tasks: RuntimeTask[] }>(`/v1/instances/${instanceId}/tasks`);
			setTasks(taskData.tasks || []);
		} catch {}
	}, [instanceId]);

	useEffect(() => { loadBoard(); }, [loadBoard]);
	usePolling(loadBoard, 2500);

	// One card per job: group by a stable job key (the normalized job URL, else the
	// task id for tasks with no URL). The newest attempt is the card's representative.
	const items = groupIntoItems(tasks);
	const finishedStatuses = ["completed", "cancelled", "failed", "blocked", "expired"];
	const finishedCount = items.filter((it) => finishedStatuses.includes(it.rep.status)).length;
	// Assign each job to exactly one column. Anything whose status matches no
	// column (and there's no catchAll) falls into a trailing "Other" bucket, so a
	// job is never silently dropped from the board.
	const byColumn = new Map<string, BoardItem[]>();
	const other: BoardItem[] = [];
	for (const it of items) {
		const colId = columnFor(cols, it.rep.status);
		if (colId) (byColumn.get(colId) ?? byColumn.set(colId, []).get(colId)!).push(it);
		else other.push(it);
	}

	// Hide a whole job (all its attempts) from the board. Best-effort cancels first.
	const handleDeleteItem = async (item: BoardItem) => {
		try {
			await Promise.all(item.attempts.map((t) => api(`/v1/instances/${instanceId}/tasks/${t.id}`, { method: "DELETE" })));
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

	return (
		<div>
			<div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
				<div>
					<h3 className="text-base font-bold mb-0.5">Board</h3>
					<div className="text-xs text-muted">
						{items.length} job{items.length !== 1 ? "s" : ""}
						{tasks.length !== items.length && <span className="text-muted-soft"> · {tasks.length} run{tasks.length !== 1 ? "s" : ""}</span>}
					</div>
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

			<div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 items-start mb-4">
				{[...cols, ...(other.length ? [{ id: "__other", title: "Other", color: "#a3a3a3" } as BoardColumn] : [])].map((col) => {
					const colItems = col.id === "__other" ? other : (byColumn.get(col.id) ?? []);
					return (
						<div key={col.id} className="border border-line rounded-xl bg-panel/55 min-h-[180px]">
							<div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-line">
								<div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide">
									<span className="w-2.5 h-2.5 rounded-full" style={{ background: col.color }} />
									{col.title}
								</div>
								<span className="text-[0.7rem] text-muted border border-line rounded-full px-1.5 py-0.5 font-bold">
									{colItems.length}
								</span>
							</div>
							<div className="flex flex-col gap-2 p-2.5">
								{colItems.length === 0 ? (
									<div className="text-center text-muted-soft text-sm py-4">No jobs</div>
								) : (
									colItems.map((item) => (
										<ItemCard
											key={item.key}
											item={item}
											onOpen={() => navigate(`/instances/${instanceId}/tasks/${item.rep.id}`)}
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

function ItemCard({ item, onOpen, onDelete }: { item: BoardItem; onOpen: () => void; onDelete: () => void }) {
	const task = item.rep;
	const needsHuman = task.status === "needs_human" || task.needs_human;
	const isFinished = ["completed", "cancelled", "failed", "blocked", "expired"].includes(task.status);
	const label = taskLabel(task);
	const desc = taskDescription(task);
	return (
		<div className="relative bg-paper border border-line rounded-lg p-3 transition-all hover:border-accent hover:-translate-y-px">
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
			<button type="button" onClick={onOpen} className="text-left w-full cursor-pointer">
				<h3 className="text-sm font-bold mb-0.5 break-words pr-6">{label.title}</h3>
				{label.subtitle && <p className="text-[0.7rem] text-muted-soft mb-1 line-clamp-1">{label.subtitle}</p>}
				{desc && <p className="text-xs text-muted line-clamp-2 mb-2">{desc}</p>}
				<div className="flex gap-1.5 flex-wrap items-center text-[0.7rem]">
					<span className={`px-1.5 py-0.5 rounded font-medium ${statusClass(task.status)}`}>{task.status}</span>
					{item.attempts.length > 1 && (
						<span className="px-1.5 py-0.5 rounded font-medium bg-muted/15 text-muted" title={`${item.attempts.length} attempts`}>
							×{item.attempts.length}
						</span>
					)}
					{task.createdAt && <span className="text-muted-soft">{formatTime(task.updatedAt || task.createdAt)}</span>}
					<span className="text-accent ml-auto">Details →</span>
				</div>
			</button>
			{needsHuman && (
				<p className="text-[0.7rem] text-amber-500 mt-2 leading-snug">
					The agent needs you — open the job to take over or answer, then it continues.
				</p>
			)}
		</div>
	);
}

/** Group runtime tasks into one card per job, newest attempt first. */
function groupIntoItems(tasks: RuntimeTask[]): BoardItem[] {
	const byKey = new Map<string, RuntimeTask[]>();
	for (const t of tasks) {
		const key = jobKey(t);
		const arr = byKey.get(key);
		if (arr) arr.push(t); else byKey.set(key, [t]);
	}
	const items: BoardItem[] = [];
	for (const [key, arr] of byKey) {
		arr.sort((a, b) => stamp(b) - stamp(a)); // newest first
		items.push({ key, rep: arr[0], attempts: arr });
	}
	// Newest job first across the board.
	items.sort((a, b) => stamp(b.rep) - stamp(a.rep));
	return items;
}

function stamp(t: RuntimeTask): number {
	const v = t.updatedAt || t.createdAt || "";
	const n = Date.parse(v);
	return Number.isNaN(n) ? 0 : n;
}

/** A stable per-job key: the normalized job URL, else the task id (own card). */
function jobKey(t: RuntimeTask): string {
	const url = typeof t.input?.url === "string" ? t.input.url : "";
	if (url) {
		try {
			const u = new URL(url);
			return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
		} catch { /* not a URL */ }
	}
	return t.id;
}

/** Which column an item's status belongs to: first matching `statuses`, else catchAll. */
function columnFor(cols: BoardColumn[], status: string): string | null {
	for (const c of cols) if (c.statuses?.includes(status)) return c.id;
	const catchAll = cols.find((c) => c.catchAll);
	return catchAll ? catchAll.id : null;
}

/**
 * A readable card label. Apply tasks are created as type "job.apply_agent" with no
 * title, so fall back to the job URL: prettify the last path segment (job slug) into
 * a title and show the ATS host as the subtitle.
 */
function taskLabel(task: RuntimeTask): { title: string; subtitle: string } {
	if (task.title) return { title: task.title, subtitle: "" };
	const url = typeof task.input?.url === "string" ? task.input.url : "";
	if (url) {
		let host = "";
		try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* not a URL */ }
		const slug = url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() || "";
		const pretty = slug
			.replace(/-([a-z0-9]{4,8})$/i, (m, g: string) => (/\d/.test(g) ? "" : m))
			.replace(/[-_]+/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase())
			.trim();
		if (pretty || host) return { title: pretty || host, subtitle: pretty ? host : "" };
	}
	return { title: task.type, subtitle: "" };
}

/** A one-line description: the task's own, else the failure/outcome detail. */
function taskDescription(task: RuntimeTask): string {
	if (task.description) return task.description;
	const out = task.output as { detail?: string } | undefined;
	if (out?.detail) return out.detail;
	if (typeof task.result === "string") return task.result;
	return "";
}

function statusClass(status: string): string {
	switch (status) {
		case "queued": case "needs_approval": return "bg-yellow/15 text-yellow";
		case "running": return "bg-blue/15 text-blue";
		case "needs_human": return "bg-amber-500/15 text-amber-500";
		case "completed": return "bg-green/15 text-green";
		case "failed": return "bg-red/15 text-red";
		case "blocked": return "bg-orange-500/15 text-orange-500";
		case "cancelled": return "bg-muted/15 text-muted";
		default: return "bg-muted/15 text-muted";
	}
}
