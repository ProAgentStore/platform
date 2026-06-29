import { useState, useEffect, useCallback, type ReactNode } from "react";
import { api } from "@proagentstore/sdk/client";
import type { RuntimeTask, RuntimeEvent } from "../lib/types";
import { formatTime } from "@proagentstore/sdk/ui";
import { usePolling } from "@proagentstore/sdk/hooks";

const COLUMNS = [
	{ id: "waiting", title: "Waiting", color: "#eab308", statuses: ["queued", "needs_approval"] },
	{ id: "running", title: "Running", color: "#3b82f6", statuses: ["running"] },
	{ id: "needs_human", title: "Needs you", color: "#f59e0b", statuses: ["needs_human"] },
	{ id: "blocked", title: "Blocked", color: "#ef4444", statuses: ["blocked", "failed"] },
	{ id: "done", title: "Done", color: "#22c55e", statuses: ["completed"] },
	{ id: "cancelled", title: "Cancelled", color: "#a3a3a3", statuses: ["cancelled"] },
];

// Generic runtime board (tasks + activity) for any agent. The job-application
// agent's applications pipeline lives in its own ApplyTab, which composes this.

export default function BoardTab({ instanceId }: { instanceId: string }) {
	const [tasks, setTasks] = useState<RuntimeTask[]>([]);
	const [events, setEvents] = useState<RuntimeEvent[]>([]);
	const [filter, setFilter] = useState<"active" | "all">("active");
	const [detailId, setDetailId] = useState<string | null>(null);

	const loadBoard = useCallback(async () => {
		try {
			const [taskData, eventData] = await Promise.all([
				api<{ tasks: RuntimeTask[] }>(`/v1/instances/${instanceId}/tasks`),
				api<{ events: RuntimeEvent[] }>(`/v1/instances/${instanceId}/task-events`),
			]);
			setTasks(taskData.tasks || []);
			setEvents(eventData.events || []);
		} catch {}
	}, [instanceId]);

	useEffect(() => { loadBoard(); }, [loadBoard]);
	usePolling(loadBoard, 2500);

	const filteredTasks = filter === "active"
		? tasks.filter((t) => !["completed", "cancelled"].includes(t.status))
		: tasks;

	const handleAction = async (taskId: string, action: string) => {
		try {
			await api(`/v1/instances/${instanceId}/tasks/${taskId}/${action}`, { method: "POST" });
			loadBoard();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	// Resume a paused human-takeover task (the agent is stuck on a step / captcha).
	// You do the highlighted step in your own browser window, then click Resume.
	const handleResume = async (taskId: string) => {
		try {
			await api(`/v1/instances/${instanceId}/takeover/${taskId}/resume`, { method: "POST" });
			loadBoard();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	// Look up the open task fresh each render so the modal stays live as the board polls.
	const detailTask = detailId ? tasks.find((t) => t.id === detailId) ?? null : null;

	return (
		<div>
			<div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
				<div>
					<h3 className="text-base font-bold mb-0.5">Board</h3>
					<div className="text-xs text-muted">
						{tasks.length} task{tasks.length !== 1 ? "s" : ""}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<div className="inline-flex border border-line rounded-lg overflow-hidden">
						{(["active", "all"] as const).map((f) => (
							<button
								key={f}
								type="button"
								onClick={() => setFilter(f)}
								className={`px-2.5 py-1 text-xs font-bold ${filter === f ? "bg-accent-soft text-accent" : "text-muted"}`}
							>
								{f === "active" ? "Active" : "All"}
							</button>
						))}
					</div>
					<button
						type="button"
						onClick={loadBoard}
						className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold"
					>
						Refresh
					</button>
				</div>
			</div>

			{/* Runtime tasks kanban */}
			<div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 items-start mb-4">
				{COLUMNS.map((col) => {
					const items = filteredTasks.filter((t) => col.statuses.includes(t.status));
					return (
						<div key={col.id} className="border border-line rounded-xl bg-panel/55 min-h-[180px]">
							<div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-line">
								<div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide">
									<span className="w-2.5 h-2.5 rounded-full" style={{ background: col.color }} />
									{col.title}
								</div>
								<span className="text-[0.7rem] text-muted border border-line rounded-full px-1.5 py-0.5 font-bold">
									{items.length}
								</span>
							</div>
							<div className="flex flex-col gap-2 p-2.5">
								{items.length === 0 ? (
									<div className="text-center text-muted-soft text-sm py-4">
										No tasks
									</div>
								) : (
									items.map((task) => (
										<TaskCard key={task.id} task={task} onAction={handleAction} onResume={handleResume} onOpen={setDetailId} />
									))
								)}
							</div>
						</div>
					);
				})}
			</div>

			{detailTask && (
				<TaskDetailModal
					task={detailTask}
					events={events}
					onClose={() => setDetailId(null)}
					onAction={handleAction}
					onResume={handleResume}
				/>
			)}

			{/* Recent activity */}
			{events.length > 0 && (
				<div className="bg-panel border border-line rounded-xl p-4 mt-4">
					<h3 className="text-sm font-semibold mb-3">Recent Activity</h3>
					<div className="flex flex-col gap-1.5">
						{events.slice(0, 20).map((ev) => (
							<div key={ev.id} className="flex justify-between gap-3 text-xs text-muted border-b border-line pb-1.5 last:border-0">
								<span className="font-mono text-ink">{ev.type}</span>
								<span>{ev.message || ""}</span>
								<span className="shrink-0">{formatTime(ev.timestamp)}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

function TaskDetailModal({ task, events, onClose, onAction, onResume }: {
	task: RuntimeTask;
	events: RuntimeEvent[];
	onClose: () => void;
	onAction: (id: string, action: string) => void;
	onResume: (id: string) => void;
}) {
	const needsHuman = task.status === "needs_human" || task.needs_human;
	const needsApproval = task.status === "needs_approval";
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	// Events that reference this task (the agent's decisions/handoffs for it).
	const taskEvents = events.filter((e) => String((e.data as Record<string, unknown>)?.taskId ?? "") === task.id);
	const fmt = (v: unknown) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
	return (
		<div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
			<div className="bg-panel border border-line rounded-t-xl sm:rounded-xl w-full sm:max-w-lg max-h-[85vh] overflow-auto p-4">
				<div className="flex items-start justify-between gap-3 mb-2">
					<h3 className="text-base font-bold break-words">{task.title || task.type}</h3>
					<button type="button" onClick={onClose} className="text-muted hover:text-ink text-lg leading-none shrink-0">✕</button>
				</div>
				<div className="flex gap-2 flex-wrap items-center text-[0.7rem] mb-3">
					<span className={`px-1.5 py-0.5 rounded font-medium ${statusClass(task.status)}`}>{task.status}</span>
					<span className="text-muted font-mono">{task.type}</span>
					{task.createdAt && <span className="text-muted-soft">started {formatTime(task.createdAt)}</span>}
				</div>

				{task.description && <p className="text-sm text-ink mb-3 whitespace-pre-wrap">{task.description}</p>}

				{needsHuman && (
					<div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-3 text-xs text-amber-600">
						<b>Needs you{task.handoff_field ? `: ${task.handoff_field}` : ""}.</b> {task.handoff_reason || "The agent is stuck."} Do the step in your browser window, then Resume.
					</div>
				)}

				{task.input && Object.keys(task.input).length > 0 && (
					<Section title="Input"><pre className="text-[0.7rem] text-muted whitespace-pre-wrap break-words">{fmt(task.input)}</pre></Section>
				)}
				{task.result && <Section title="Result"><div className="text-xs text-ink whitespace-pre-wrap">{task.result}</div></Section>}
				{task.output && Object.keys(task.output).length > 0 && (
					<Section title="Output"><pre className="text-[0.7rem] text-muted whitespace-pre-wrap break-words">{fmt(task.output)}</pre></Section>
				)}
				{taskEvents.length > 0 && (
					<Section title="Activity">
						<div className="flex flex-col gap-1">
							{taskEvents.slice(0, 40).map((ev) => (
								<div key={ev.id} className="flex justify-between gap-2 text-[0.7rem] text-muted">
									<span className="font-mono text-ink shrink-0">{ev.type}</span>
									<span className="truncate">{ev.message || ""}</span>
									<span className="shrink-0">{formatTime(ev.timestamp)}</span>
								</div>
							))}
						</div>
					</Section>
				)}

				{(needsApproval || needsHuman) && (
					<div className="flex gap-2 mt-4">
						{needsHuman ? (
							<button type="button" onClick={() => { onResume(task.id); onClose(); }} className="text-xs px-3 py-1.5 rounded-md bg-green/15 text-green font-bold">Resume</button>
						) : (
							<button type="button" onClick={() => { onAction(task.id, "approve"); onClose(); }} className="text-xs px-3 py-1.5 rounded-md bg-green/15 text-green font-bold">Approve</button>
						)}
						<button type="button" onClick={() => { onAction(task.id, "cancel"); onClose(); }} className="text-xs px-3 py-1.5 rounded-md bg-red/15 text-red font-bold">Cancel</button>
					</div>
				)}
			</div>
		</div>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="mb-3">
			<div className="text-[0.7rem] font-extrabold uppercase tracking-wide text-muted-soft mb-1">{title}</div>
			<div className="bg-paper border border-line rounded-lg p-2.5">{children}</div>
		</div>
	);
}

function TaskCard({ task, onAction, onResume, onOpen }: { task: RuntimeTask; onAction: (id: string, action: string) => void; onResume: (id: string) => void; onOpen: (id: string) => void }) {
	const needsHuman = task.status === "needs_human" || task.needs_human;
	const needsApproval = task.status === "needs_approval";
	return (
		<div className="bg-paper border border-line rounded-lg p-3 transition-all hover:border-accent hover:-translate-y-px">
			<button type="button" onClick={() => onOpen(task.id)} className="text-left w-full cursor-pointer">
				<h3 className="text-sm font-bold mb-0.5 break-words">{task.title || task.type}</h3>
				<p className="text-xs text-muted line-clamp-2 mb-2">{task.description || ""}</p>
				<div className="flex gap-1.5 flex-wrap items-center text-[0.7rem]">
					<span className={`px-1.5 py-0.5 rounded font-medium ${statusClass(task.status)}`}>
						{task.status}
					</span>
					{task.createdAt && (
						<span className="text-muted-soft">{formatTime(task.createdAt)}</span>
					)}
					<span className="text-accent ml-auto">Details →</span>
				</div>
			</button>
			{needsHuman && (
				<p className="text-[0.7rem] text-amber-500 mt-2 leading-snug">
					The agent is stuck — do the highlighted step in your browser window, then click <b>Resume</b>.
				</p>
			)}
			{(needsApproval || needsHuman) && (
				<div className="flex gap-1.5 mt-2 flex-wrap">
					{needsHuman ? (
						<button
							type="button"
							onClick={(e) => { e.stopPropagation(); onResume(task.id); }}
							className="text-xs px-2 py-1 rounded-md bg-green/15 text-green font-bold"
						>
							Resume
						</button>
					) : (
						<button
							type="button"
							onClick={(e) => { e.stopPropagation(); onAction(task.id, "approve"); }}
							className="text-xs px-2 py-1 rounded-md bg-green/15 text-green font-bold"
						>
							Approve
						</button>
					)}
					<button
						type="button"
						onClick={(e) => { e.stopPropagation(); onAction(task.id, "cancel"); }}
						className="text-xs px-2 py-1 rounded-md bg-red/15 text-red font-bold"
					>
						Cancel
					</button>
				</div>
			)}
		</div>
	);
}

function statusClass(status: string): string {
	switch (status) {
		case "queued": case "needs_approval": return "bg-yellow/15 text-yellow";
		case "running": return "bg-blue/15 text-blue";
		case "needs_human": return "bg-amber-500/15 text-amber-500";
		case "completed": return "bg-green/15 text-green";
		case "blocked": case "failed": return "bg-red/15 text-red";
		case "cancelled": return "bg-muted/15 text-muted";
		default: return "bg-muted/15 text-muted";
	}
}
