/**
 * The Knowledge tab's Memory sub-tab, extracted: view / add / inline-edit /
 * delete the agent's persistent memory. Edits are tagged source:"user" so the
 * prompt marks them (user-set) and the agent won't overwrite them unasked.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { MemoryEntry } from "../lib/types";
import Button from "./Button";
import Card from "./Card";
import LoadFailed from "./LoadFailed";

export default function MemorySection({ instanceId, active }: { instanceId: string; active: boolean }) {
	const [memories, setMemories] = useState<MemoryEntry[]>([]);
	// One row editable at a time; key is identity (rename = delete + add).
	const [editMemKey, setEditMemKey] = useState<string | null>(null);
	const [editMemContent, setEditMemContent] = useState("");
	const [showAddMem, setShowAddMem] = useState(false);
	const [newMemKey, setNewMemKey] = useState("");
	const [newMemType, setNewMemType] = useState("knowledge");
	const [newMemContent, setNewMemContent] = useState("");

	// "No memories stored yet" over a failed read is a claim about the agent, not about the
	// request — and on THIS list it is the misleading one, because an empty memory is a normal
	// state for a new instance. Nothing distinguished the two (#291).
	const [loadErr, setLoadErr] = useState("");
	const loadMemory = useCallback(async () => {
		try {
			const d = await api<{ memory: MemoryEntry[] }>(`/v1/instances/${instanceId}/memory`);
			setMemories(d.memory || []);
			setLoadErr("");
		} catch (e) {
			setLoadErr(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);

	useEffect(() => {
		if (active) loadMemory();
	}, [active, loadMemory]);

	const saveMemory = async (entry: MemoryEntry) => {
		try {
			await api(`/v1/instances/${instanceId}/memory`, {
				method: "PUT",
				body: JSON.stringify({ key: entry.key, type: entry.type, content: editMemContent, source: "user" }),
			});
			setEditMemKey(null);
			loadMemory();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const addMemory = async () => {
		if (!newMemKey.trim() || !newMemContent.trim()) { alert("Give the memory a key and content."); return; }
		try {
			await api(`/v1/instances/${instanceId}/memory`, {
				method: "PUT",
				body: JSON.stringify({ key: newMemKey.trim(), type: newMemType, content: newMemContent, source: "user" }),
			});
			setNewMemKey("");
			setNewMemType("knowledge");
			setNewMemContent("");
			setShowAddMem(false);
			loadMemory();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const deleteMemory = async (key: string) => {
		if (!confirm("Delete this memory?")) return;
		try {
			await api(`/v1/instances/${instanceId}/memory/${encodeURIComponent(key)}`, { method: "DELETE" });
			if (editMemKey === key) setEditMemKey(null);
			loadMemory();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div>
			<div className="flex justify-between items-center gap-2 mb-3">
				<h3 className="text-base font-bold">Agent Memory</h3>
				<Button variant="primary" onClick={() => setShowAddMem((s) => !s)}>+ Add</Button>
			</div>

			{showAddMem && (
				<Card className="mb-3">
					<input aria-label="Memory key" value={newMemKey} onChange={(e) => setNewMemKey(e.target.value)} placeholder="Key (e.g. language)" className="mb-2 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
					<select aria-label="Memory type" value={newMemType} onChange={(e) => setNewMemType(e.target.value)} className="mb-2 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm">
						{["identity", "knowledge", "preference", "skill", "context"].map((t) => (
							<option key={t} value={t}>{t}</option>
						))}
					</select>
					<textarea aria-label="Memory content" value={newMemContent} onChange={(e) => setNewMemContent(e.target.value)} placeholder="Content" className="mb-2 w-full min-h-[80px] bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
					<div className="flex gap-2">
						<Button variant="primary" onClick={addMemory}>Save</Button>
						<Button onClick={() => setShowAddMem(false)}>Cancel</Button>
					</div>
				</Card>
			)}

			{loadErr ? (
				<LoadFailed what="this agent's memory" detail={loadErr} onRetry={loadMemory} testId="memory-load-failed" />
			) : memories.length === 0 ? (
				<p className="text-center py-4 text-muted-soft text-sm">No memories stored yet.</p>
			) : (
				<div className="flex flex-col gap-2">
					{memories.map((m) => (
						<Card key={m.key}>
							<div className="flex justify-between items-start gap-2">
								<div className="min-w-0">
									<span className="font-semibold text-sm break-all">{m.key}</span>
									<span className="text-xs text-purple-400 ml-2">{m.type}</span>
									{m.source && <span className="text-xs text-muted-soft ml-2">{m.source}</span>}
									{m.injected === false && (
										<span
											className="text-xs text-warning ml-2"
											title="Not currently repeated to the agent — too old or displaced by newer entries. Edit to promote to user-set (permanent)."
										>
											not repeated to agent
										</span>
									)}
								</div>
								<div className="flex gap-1.5 shrink-0">
									<Button onClick={() => { setEditMemKey(m.key); setEditMemContent(m.content); }}>Edit</Button>
									<Button variant="danger" onClick={() => deleteMemory(m.key)}>Delete</Button>
								</div>
							</div>
							{editMemKey === m.key ? (
								<div className="mt-2">
									{/* Names the ROW being edited, not just "content" — several of these can be
									    open at once, and "Content" three times over says nothing about which. */}
									<textarea aria-label={`Content of memory ${m.key}`} value={editMemContent} onChange={(e) => setEditMemContent(e.target.value)} className="w-full min-h-[80px] bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
									<div className="flex gap-2 mt-2">
										<Button variant="primary" onClick={() => saveMemory(m)}>Save</Button>
										<Button onClick={() => setEditMemKey(null)}>Cancel</Button>
									</div>
								</div>
							) : (
								<div className="text-sm text-muted mt-1">{m.content}</div>
							)}
						</Card>
					))}
				</div>
			)}
		</div>
	);
}
