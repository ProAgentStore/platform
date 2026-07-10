/**
 * The Knowledge tab's Memory sub-tab, extracted: view / add / inline-edit /
 * delete the agent's persistent memory. Edits are tagged source:"user" so the
 * prompt marks them (user-set) and the agent won't overwrite them unasked.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { MemoryEntry } from "../lib/types";

export default function MemorySection({ instanceId, active }: { instanceId: string; active: boolean }) {
	const [memories, setMemories] = useState<MemoryEntry[]>([]);
	// One row editable at a time; key is identity (rename = delete + add).
	const [editMemKey, setEditMemKey] = useState<string | null>(null);
	const [editMemContent, setEditMemContent] = useState("");
	const [showAddMem, setShowAddMem] = useState(false);
	const [newMemKey, setNewMemKey] = useState("");
	const [newMemType, setNewMemType] = useState("knowledge");
	const [newMemContent, setNewMemContent] = useState("");

	const loadMemory = useCallback(async () => {
		try {
			const d = await api<{ memory: MemoryEntry[] }>(`/v1/instances/${instanceId}/memory`);
			setMemories(d.memory || []);
		} catch {}
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
				<button type="button" onClick={() => setShowAddMem((s) => !s)} className="text-xs px-2.5 py-1.5 rounded-lg bg-accent text-white font-bold">+ Add</button>
			</div>

			{showAddMem && (
				<div className="bg-panel border border-line rounded-xl p-4 mb-3">
					<input value={newMemKey} onChange={(e) => setNewMemKey(e.target.value)} placeholder="Key (e.g. language)" className="mb-2 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
					<select value={newMemType} onChange={(e) => setNewMemType(e.target.value)} className="mb-2 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm">
						{["identity", "knowledge", "preference", "skill", "context"].map((t) => (
							<option key={t} value={t}>{t}</option>
						))}
					</select>
					<textarea value={newMemContent} onChange={(e) => setNewMemContent(e.target.value)} placeholder="Content" className="mb-2 w-full min-h-[80px] bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
					<div className="flex gap-2">
						<button type="button" onClick={addMemory} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Save</button>
						<button type="button" onClick={() => setShowAddMem(false)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Cancel</button>
					</div>
				</div>
			)}

			{memories.length === 0 ? (
				<p className="text-center py-4 text-muted-soft text-sm">No memories stored yet.</p>
			) : (
				<div className="flex flex-col gap-2">
					{memories.map((m) => (
						<div key={m.key} className="bg-panel border border-line rounded-lg p-3">
							<div className="flex justify-between items-start gap-2">
								<div className="min-w-0">
									<span className="font-semibold text-sm break-all">{m.key}</span>
									<span className="text-xs text-purple-400 ml-2">{m.type}</span>
									{m.source && <span className="text-xs text-muted-soft ml-2">{m.source}</span>}
								</div>
								<div className="flex gap-1.5 shrink-0">
									<button type="button" onClick={() => { setEditMemKey(m.key); setEditMemContent(m.content); }} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold">Edit</button>
									<button type="button" onClick={() => deleteMemory(m.key)} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-red hover:bg-red/10 font-semibold">Delete</button>
								</div>
							</div>
							{editMemKey === m.key ? (
								<div className="mt-2">
									<textarea value={editMemContent} onChange={(e) => setEditMemContent(e.target.value)} className="w-full min-h-[80px] bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
									<div className="flex gap-2 mt-2">
										<button type="button" onClick={() => saveMemory(m)} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Save</button>
										<button type="button" onClick={() => setEditMemKey(null)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Cancel</button>
									</div>
								</div>
							) : (
								<div className="text-sm text-muted mt-1">{m.content}</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
