/**
 * The Knowledge tab's Tasks sub-tab (#337) — the agent's OWN task list, which until now
 * nothing in the console could show.
 *
 * This is not the Board. The Board is `instance_runtime_tasks`: work the runtime picks up.
 * This is the Durable Object's `task:` store, written by the agent's BASE `create_task` tool
 * and concatenated into its system prompt every single turn. A task it wrote once — from a
 * misread instruction or a hallucinated commitment — steered every later turn, and the owner
 * could not read it, let alone delete it.
 *
 * It sits beside Memory because it is the same class of state (agent-written, prompt-injected,
 * durable) and gets the same treatment: add, inline-edit, delete, and visible provenance.
 * Anything the owner writes or edits here becomes `user`-assigned, which the prompt marks
 * `(user-set)` and instructs the agent not to retire unasked.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { AgentTaskEntry } from "../lib/types";
import Button from "./Button";
import Card from "./Card";
import LoadFailed from "./LoadFailed";

const STATUSES = ["pending", "in_progress", "blocked", "complete"] as const;

export default function TasksSection({ instanceId, active }: { instanceId: string; active: boolean }) {
	const [tasks, setTasks] = useState<AgentTaskEntry[]>([]);
	const [limits, setLimits] = useState<{ max?: number; injected?: number; staleDays?: number }>({});
	// One row editable at a time, mirroring MemorySection.
	const [editId, setEditId] = useState<string | null>(null);
	const [editTitle, setEditTitle] = useState("");
	const [editDescription, setEditDescription] = useState("");
	const [editStatus, setEditStatus] = useState<string>("pending");
	const [showAdd, setShowAdd] = useState(false);
	const [newTitle, setNewTitle] = useState("");
	const [newDescription, setNewDescription] = useState("");

	// The empty state here does not merely say "none" — it says "Nothing is being injected into
	// the prompt from here", which is a claim about what the AGENT is currently doing. Asserting
	// that over a failed read is the worst version of this bug (#291): someone debugging why their
	// agent is behaving oddly is told, wrongly and with confidence, that this is not the cause.
	const [loadErr, setLoadErr] = useState("");
	const load = useCallback(async () => {
		try {
			const d = await api<{ tasks: AgentTaskEntry[]; limits?: typeof limits }>(
				`/v1/instances/${instanceId}/agent-tasks`,
			);
			setTasks(d.tasks || []);
			setLimits(d.limits || {});
			setLoadErr("");
		} catch (e) {
			setLoadErr(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);

	useEffect(() => {
		if (active) load();
	}, [active, load]);

	const addTask = async () => {
		if (!newTitle.trim()) { alert("Give the task a title."); return; }
		try {
			await api(`/v1/instances/${instanceId}/agent-tasks`, {
				method: "POST",
				body: JSON.stringify({ title: newTitle.trim(), description: newDescription.trim() }),
			});
			setNewTitle("");
			setNewDescription("");
			setShowAdd(false);
			load();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const saveTask = async (id: string) => {
		if (!editTitle.trim()) { alert("A task needs a title."); return; }
		try {
			await api(`/v1/instances/${instanceId}/agent-tasks/${encodeURIComponent(id)}`, {
				method: "PUT",
				body: JSON.stringify({
					title: editTitle.trim(),
					description: editDescription,
					status: editStatus,
				}),
			});
			setEditId(null);
			load();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const deleteTask = async (id: string) => {
		if (!confirm("Delete this task? The agent will stop seeing it in its prompt.")) return;
		try {
			await api(`/v1/instances/${instanceId}/agent-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
			if (editId === id) setEditId(null);
			load();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const activeCount = tasks.filter((t) => t.status !== "complete").length;

	return (
		<div>
			<div className="flex justify-between items-center gap-2 mb-1">
				<h3 className="text-base font-bold">Agent Tasks</h3>
				<Button variant="primary" onClick={() => setShowAdd((s) => !s)}>+ Add</Button>
			</div>
			{/* Say what this list DOES, because its effect is invisible: these lines go into the
			    agent's prompt on every turn, which is the whole reason the tab exists. */}
			<p className="text-xs text-muted-soft mb-3">
				The agent's own task list. Every unfinished task here is read into its prompt on
				every turn{limits.injected ? ` (the ${limits.injected} most recently updated)` : ""}
				{limits.staleDays ? `, until nothing has touched it for ${limits.staleDays} days` : ""}.
				This is separate from the Board, which is runtime work. Tasks you add or edit are
				marked <span className="font-semibold">user-set</span> and the agent won't retire them unasked.
			</p>

			{showAdd && (
				<Card className="mb-3">
					<input aria-label="Task title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Title (e.g. Renew the domain before September)" className="mb-2 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
					<textarea aria-label="Task description" value={newDescription} onChange={(e) => setNewDescription(e.target.value)} placeholder="Description (optional)" className="mb-2 w-full min-h-[80px] bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
					<div className="flex gap-2">
						<Button variant="primary" onClick={addTask}>Save</Button>
						<Button onClick={() => setShowAdd(false)}>Cancel</Button>
					</div>
				</Card>
			)}

			{loadErr ? (
				<LoadFailed what="this agent's tasks" detail={loadErr} onRetry={load} testId="agent-tasks-load-failed" />
			) : tasks.length === 0 ? (
				<p className="text-center py-4 text-muted-soft text-sm">
					No agent tasks. Nothing is being injected into the prompt from here.
				</p>
			) : (
				<>
					<div className="text-xs text-muted-soft mb-2">
						{activeCount} active of {tasks.length}
						{limits.max ? ` (limit ${limits.max})` : ""}
					</div>
					<div className="flex flex-col gap-2">
						{tasks.map((t) => (
							<Card key={t.id}>
								<div className="flex justify-between items-start gap-2">
									<div className="min-w-0">
										<span className="font-semibold text-sm break-words">{t.title}</span>
										<span className="text-xs text-purple-400 ml-2">{t.status}</span>
										{/* Provenance, shown exactly where the prompt shows it. */}
										<span className="text-xs text-muted-soft ml-2">
											{t.assignedBy === "user" ? "user-set" : t.assignedBy === "trigger" ? "trigger-posted" : t.assignedBy === "system" ? "system" : "agent-written"}
										</span>
										{/* Stale is computed server-side from the same rule the prompt uses, so
										    this badge and the prompt cannot disagree. */}
										{t.stale && t.status !== "complete" && (
											<span className="text-xs text-muted-soft ml-2 italic">not in prompt (stale)</span>
										)}
									</div>
									<div className="flex gap-1.5 shrink-0">
										<Button onClick={() => { setEditId(t.id); setEditTitle(t.title); setEditDescription(t.description || ""); setEditStatus(t.status); }}>Edit</Button>
										<Button variant="danger" onClick={() => deleteTask(t.id)}>Delete</Button>
									</div>
								</div>
								{editId === t.id ? (
									<div className="mt-2">
										{/* Named after the ROW, not the field — several of these read "Title"
										    otherwise and none of them say which task. */}
										<input aria-label={`Title of task ${t.title}`} value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="mb-2 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
										<textarea aria-label={`Description of task ${t.title}`} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} className="w-full min-h-[80px] bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
										<select aria-label={`Status of task ${t.title}`} value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className="mt-2 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm">
											{STATUSES.map((s) => (
												<option key={s} value={s}>{s}</option>
											))}
										</select>
										<div className="flex gap-2 mt-2">
											<Button variant="primary" onClick={() => saveTask(t.id)}>Save</Button>
											<Button onClick={() => setEditId(null)}>Cancel</Button>
										</div>
									</div>
								) : (
									t.description && <div className="text-sm text-muted mt-1">{t.description}</div>
								)}
							</Card>
						))}
					</div>
				</>
			)}
		</div>
	);
}
