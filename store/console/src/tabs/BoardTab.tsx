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

export default function BoardTab({ instanceId, onTaskOpen }: { instanceId: string; onTaskOpen?: (task: RuntimeTask) => boolean }) {
	const [tasks, setTasks] = useState<RuntimeTask[]>([]);
	const [events, setEvents] = useState<RuntimeEvent[]>([]);
	const [filter, setFilter] = useState<"active" | "all">("active");
	const [detailId, setDetailId] = useState<string | null>(null);

	// Open a task: let a host (e.g. the apply surface) redirect it to a richer page;
	// if it doesn't handle it, fall back to the generic detail modal.
	const openTask = (id: string) => {
		const task = tasks.find((t) => t.id === id);
		if (task && onTaskOpen?.(task)) return;
		setDetailId(id);
	};

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

	// Supply a value the agent asked for (needs_input handoff). Resume only marks the
	// step done — it never delivers a value, so without this the agent hangs then fails.
	const handleProvideInput = async (taskId: string, value: string) => {
		try {
			await api(`/v1/instances/${instanceId}/input`, { method: "POST", body: JSON.stringify({ taskId, value }) });
			loadBoard();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	// Remove a single ticket from the board (best-effort cancels it if still running).
	const handleDelete = async (taskId: string) => {
		try {
			await api(`/v1/instances/${instanceId}/tasks/${taskId}`, { method: "DELETE" });
			if (detailId === taskId) setDetailId(null);
			loadBoard();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const finishedStatuses = ["completed", "cancelled", "failed", "blocked", "expired"];
	const finishedCount = tasks.filter((t) => finishedStatuses.includes(t.status)).length;
	// Clear every finished ticket (done/failed/cancelled) in one go.
	const handleClearFinished = async () => {
		if (!finishedCount || !confirm(`Remove ${finishedCount} finished ticket${finishedCount !== 1 ? "s" : ""} from the board? This can't be undone.`)) return;
		try {
			await api(`/v1/instances/${instanceId}/tasks/clear-finished`, { method: "POST" });
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
										<TaskCard key={task.id} task={task} onAction={handleAction} onResume={handleResume} onOpen={openTask} onDelete={handleDelete} />
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
					onProvideInput={handleProvideInput}
					onDelete={handleDelete}
				/>
			)}

			{/* Per-ticket activity lives inside each ticket's detail — not on the board. */}
		</div>
	);
}

function TaskDetailModal({ task, events, onClose, onAction, onResume, onProvideInput, onDelete }: {
	task: RuntimeTask;
	events: RuntimeEvent[];
	onClose: () => void;
	onAction: (id: string, action: string) => void;
	onResume: (id: string) => void;
	onProvideInput: (id: string, value: string) => void;
	onDelete: (id: string) => void;
}) {
	const isFinished = ["completed", "cancelled", "failed", "blocked", "expired"].includes(task.status);
	const [inputVal, setInputVal] = useState("");
	const needsHuman = task.status === "needs_human" || task.needs_human;
	const needsApproval = task.status === "needs_approval";
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	// Events that reference this task (the agent's decisions/handoffs for it).
	const taskEvents = events.filter((e) => String(e.taskId ?? (e.data as Record<string, unknown>)?.taskId ?? "") === task.id);
	const fmt = (v: unknown) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };

	// Work out WHAT the agent needs and HOW you answer it, from the handoff events —
	// so the panel shows ONE clear ask instead of a wall of technical decisions.
	const handoffEv = taskEvents.find((e) => e.type === "job.human_handoff_required");
	const needsInputEv = taskEvents.find((e) => e.type === "agent.needs_input");
	const reason = String((handoffEv?.data as Record<string, unknown>)?.reason ?? "");
	const isValueAsk = reason === "needs_input" || !!needsInputEv || /needs a value|enter it/i.test(handoffEv?.message ?? "");
	const isCaptcha = reason === "challenge" || /captcha|verify you|human check|not a robot/i.test(`${handoffEv?.message ?? ""} ${task.handoff_reason ?? ""}`);
	const kind: "value" | "captcha" | "stuck" = isValueAsk ? "value" : isCaptcha ? "captcha" : "stuck";
	// The specific field + why + the multiple-choice options (if the form listed any).
	const detail = needsInputEv?.message ?? handoffEv?.message ?? "";
	const field = task.handoff_field || detail.replace(/^Needs your input\s*[—-]\s*/i, "").split("(")[0].trim() || "your answer";
	const paren = detail.match(/\(([^)]*)\)/)?.[1] ?? "";
	const fromIdx = paren.toLowerCase().indexOf("from:");
	const why = (fromIdx >= 0 ? paren.slice(0, fromIdx) : paren).trim();
	const options = fromIdx >= 0
		? paren.slice(fromIdx + 5).split(",").map((s) => s.trim()).filter((s) => s && s.length < 70).slice(0, 16)
		: [];
	const send = (v: string) => { const t = v.trim(); if (t) { onProvideInput(task.id, t); onClose(); } };

	return (
		<div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
			<div className="bg-panel border border-line rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[92vh] overflow-auto p-5 sm:p-6">
				<div className="flex items-start justify-between gap-3 mb-1">
					<h3 className="text-xl font-bold break-words">{task.title || "Job application"}</h3>
					<button type="button" onClick={onClose} className="text-muted hover:text-ink text-2xl leading-none shrink-0" aria-label="Close">✕</button>
				</div>
				<div className="flex gap-2 flex-wrap items-center text-xs mb-5">
					<span className={`px-2 py-0.5 rounded-full font-semibold ${statusClass(task.status)}`}>{needsHuman ? "Waiting for you" : task.status}</span>
					{task.createdAt && <span className="text-muted-soft">started {formatTime(task.createdAt)}</span>}
				</div>

				{needsHuman && kind === "value" && (
					<div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-4 sm:p-5 mb-4">
						<div className="text-lg font-bold text-ink">✏️ The agent needs one answer to continue</div>
						<div className="text-sm text-muted mt-0.5 mb-4">It won’t guess personal or legal details, so it’s asking you. Answer once and it keeps going on its own.</div>
						<div className="text-base font-semibold text-ink">{field}</div>
						{why && <div className="text-sm text-muted mt-1">{why}</div>}
						{options.length > 0 && (
							<div className="mt-4">
								<div className="text-xs font-bold uppercase tracking-wide text-muted-soft mb-2">Tap your answer</div>
								<div className="flex flex-wrap gap-2">
									{options.map((opt) => (
										<button key={opt} type="button" onClick={() => send(opt)} className="px-3.5 py-2 rounded-lg bg-panel border border-line hover:border-accent hover:bg-accent/10 text-sm text-ink font-medium transition-colors">{opt}</button>
									))}
								</div>
								<div className="text-xs text-muted-soft mt-4 mb-1.5">…or type a different answer</div>
							</div>
						)}
						<div className="flex gap-2 mt-2">
							<input
								autoFocus
								value={inputVal}
								onChange={(e) => setInputVal(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") send(inputVal); }}
								placeholder={field}
								className="flex-1 min-w-0 bg-panel border border-line rounded-lg px-3 py-2.5 text-base text-ink"
							/>
							<button type="button" disabled={!inputVal.trim()} onClick={() => send(inputVal)} className="px-5 py-2.5 rounded-lg bg-accent text-white font-bold text-base disabled:opacity-40 shrink-0">Send</button>
						</div>
					</div>
				)}

				{needsHuman && kind !== "value" && (
					<div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-4 sm:p-5 mb-4">
						<div className="text-lg font-bold text-ink">{kind === "captcha" ? "🔐 A human verification appeared" : "✋ The agent is stuck on one step"}</div>
						<div className="text-sm text-ink mt-1 mb-3">{field && field !== "your answer" ? <>It needs your help with: <b>{field}</b>.</> : "It needs you to do one step it can’t do on its own."}</div>
						<ol className="text-sm text-muted list-decimal ml-5 space-y-1.5 mb-4">
							<li>Switch to the <b>Chrome window the agent opened</b> — on the computer where you ran <code className="text-xs bg-paper px-1 py-0.5 rounded">pags up</code>.</li>
							<li>{kind === "captcha" ? "Complete the “I’m not a robot” / verification there." : "Do that one step (tick the box, click the control, etc.)."}</li>
							<li>Come back here and press <b>Resume</b> — the agent continues from where it paused.</li>
						</ol>
						<button type="button" onClick={() => { onResume(task.id); onClose(); }} className="px-5 py-2.5 rounded-lg bg-green/15 text-green font-bold text-base">Resume — I’ve done it</button>
						<div className="text-xs text-muted-soft mt-3">There’s no screen to control from here — you act in that real Chrome window, then Resume.</div>
					</div>
				)}

				{/* The technical trace, tucked away — not what’s needed from you. */}
				<details className="mt-1">
					<summary className="cursor-pointer text-sm font-medium text-muted hover:text-ink select-none py-1">What the agent has done so far ({taskEvents.length} steps)</summary>
					<div className="mt-3">
						{taskEvents.length > 0 && (
							<div className="flex flex-col gap-1.5 mb-3">
								{taskEvents.slice(0, 60).map((ev) => (
									<div key={ev.id} className="flex justify-between gap-3 text-xs">
										<span className="text-ink truncate">{humanEvent(ev)}</span>
										<span className="shrink-0 text-muted-soft">{formatTime(ev.createdAt ?? ev.timestamp)}</span>
									</div>
								))}
							</div>
						)}
						{task.input && Object.keys(task.input).length > 0 && (
							<Section title="Technical input"><pre className="text-[0.7rem] text-muted whitespace-pre-wrap break-words">{fmt(task.input)}</pre></Section>
						)}
						{task.result && <Section title="Result"><div className="text-xs text-ink whitespace-pre-wrap">{task.result}</div></Section>}
					</div>
				</details>

				<div className="flex gap-2 mt-5 pt-4 border-t border-line flex-wrap">
					{needsApproval && <button type="button" onClick={() => { onAction(task.id, "approve"); onClose(); }} className="px-4 py-2 rounded-lg bg-green/15 text-green font-bold text-sm">Approve</button>}
					{!isFinished && <button type="button" onClick={() => { onAction(task.id, "cancel"); onClose(); }} className="px-4 py-2 rounded-lg bg-amber-500/15 text-amber-600 font-semibold text-sm">Cancel application</button>}
					{/* Always available: remove the ticket from the board (stops it first if still running). */}
					<button
						type="button"
						onClick={() => { if (isFinished || confirm("Delete this ticket? If it's still running it will be stopped first.")) { onDelete(task.id); onClose(); } }}
						className="px-4 py-2 rounded-lg bg-red text-white font-bold text-sm ml-auto"
					>
						🗑 Delete ticket
					</button>
				</div>
			</div>
		</div>
	);
}

/** Turn a raw runtime event into a plain-language line (hides empty-name noise). */
function humanEvent(ev: RuntimeEvent): string {
	if (ev.type === "task.created") return "Started the application";
	if (ev.type === "agent.needs_input") return "Paused — needs your answer";
	if (ev.type === "job.human_handoff_required") return "Paused — waiting for you";
	if (ev.type === "agent.captcha") return "Hit a human-verification check";
	const m = (ev.message || ev.type || "").replace(/\s*(?:in|into textbox|into)\s*""/gi, "").replace(/\s+/g, " ").trim();
	return m || ev.type;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="mb-3">
			<div className="text-[0.7rem] font-extrabold uppercase tracking-wide text-muted-soft mb-1">{title}</div>
			<div className="bg-paper border border-line rounded-lg p-2.5">{children}</div>
		</div>
	);
}

function TaskCard({ task, onAction, onResume, onOpen, onDelete }: { task: RuntimeTask; onAction: (id: string, action: string) => void; onResume: (id: string) => void; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
	const needsHuman = task.status === "needs_human" || task.needs_human;
	const needsApproval = task.status === "needs_approval";
	const isFinished = ["completed", "cancelled", "failed", "blocked", "expired"].includes(task.status);
	return (
		<div className="relative bg-paper border border-line rounded-lg p-3 transition-all hover:border-accent hover:-translate-y-px">
			{isFinished && (
				<button
					type="button"
					title="Remove from board"
					onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
					className="absolute top-1.5 right-1.5 w-6 h-6 flex items-center justify-center rounded-md text-muted-soft hover:text-red hover:bg-red/10 text-base leading-none"
				>
					✕
				</button>
			)}
			<button type="button" onClick={() => onOpen(task.id)} className="text-left w-full cursor-pointer">
				<h3 className="text-sm font-bold mb-0.5 break-words pr-6">{task.title || task.type}</h3>
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
