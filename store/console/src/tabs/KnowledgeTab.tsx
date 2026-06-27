import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { KnowledgeDoc, MemoryEntry, Credential } from "../lib/types";
import { formatTime } from "../lib/markdown";

type KbSubTab = "docs" | "memory" | "files" | "credentials" | "rules" | "chat";

interface Props {
	instanceId: string;
	isApply: boolean;
}

export default function KnowledgeTab({ instanceId, isApply }: Props) {
	const [subTab, setSubTab] = useState<KbSubTab>("docs");
	const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
	const [memories, setMemories] = useState<MemoryEntry[]>([]);
	const [files, setFiles] = useState<{ id: string; name: string; size?: number; createdAt?: string }[]>([]);
	const [credentials, setCredentials] = useState<Credential[]>([]);
	const [instructions, setInstructions] = useState("");
	const [instrStatus, setInstrStatus] = useState("");

	// Paste form
	const [showPaste, setShowPaste] = useState(false);
	const [pasteTitle, setPasteTitle] = useState("");
	const [pasteContent, setPasteContent] = useState("");

	// URL form
	const [showUrl, setShowUrl] = useState(false);
	const [urlValue, setUrlValue] = useState("");
	const [urlTitle, setUrlTitle] = useState("");

	const loadDocs = useCallback(async () => {
		try {
			const d = await api<{ knowledge: KnowledgeDoc[] }>(`/v1/instances/${instanceId}/knowledge`);
			setDocs(d.knowledge || []);
		} catch {}
	}, [instanceId]);

	const loadMemory = useCallback(async () => {
		try {
			const d = await api<{ memory: MemoryEntry[] }>(`/v1/instances/${instanceId}/memory`);
			setMemories(d.memory || []);
		} catch {}
	}, [instanceId]);

	const loadFiles = useCallback(async () => {
		try {
			const d = await api<{ files: { id: string; name: string; size?: number; createdAt?: string }[] }>(`/v1/instances/${instanceId}/files`);
			setFiles(d.files || []);
		} catch {}
	}, [instanceId]);

	const loadCredentials = useCallback(async () => {
		try {
			const d = await api<{ credentials: Credential[] }>(`/v1/instances/${instanceId}/credentials`);
			setCredentials(d.credentials || []);
		} catch {}
	}, [instanceId]);

	const loadInstructions = useCallback(async () => {
		try {
			const d = await api<{ instructions?: string }>(`/v1/instances/${instanceId}/instructions`);
			setInstructions(d.instructions || "");
		} catch {}
	}, [instanceId]);

	useEffect(() => {
		loadDocs();
		loadMemory();
		loadFiles();
		loadCredentials();
		loadInstructions();
	}, [loadDocs, loadMemory, loadFiles, loadCredentials, loadInstructions]);

	const addPaste = async () => {
		if (!pasteTitle.trim() || !pasteContent.trim()) return;
		try {
			await api(`/v1/instances/${instanceId}/knowledge`, {
				method: "POST",
				body: JSON.stringify({ title: pasteTitle, content: pasteContent }),
			});
			setPasteTitle("");
			setPasteContent("");
			setShowPaste(false);
			loadDocs();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const addUrl = async () => {
		if (!urlValue.trim()) return;
		try {
			await api(`/v1/instances/${instanceId}/knowledge/ingest-url`, {
				method: "POST",
				body: JSON.stringify({ url: urlValue, title: urlTitle || undefined }),
			});
			setUrlValue("");
			setUrlTitle("");
			setShowUrl(false);
			loadDocs();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const deleteDoc = async (docId: string) => {
		if (!confirm("Delete this document?")) return;
		await api(`/v1/instances/${instanceId}/knowledge/${docId}`, { method: "DELETE" });
		loadDocs();
	};

	const deleteFile = async (fileId: string) => {
		if (!confirm("Delete this file?")) return;
		await api(`/v1/instances/${instanceId}/files/${fileId}`, { method: "DELETE" });
		loadFiles();
	};

	const saveInstructions = async () => {
		try {
			await api(`/v1/instances/${instanceId}/instructions`, {
				method: "PUT",
				body: JSON.stringify({ instructions }),
			});
			setInstrStatus("Saved");
			setTimeout(() => setInstrStatus(""), 2000);
		} catch (e) {
			setInstrStatus(e instanceof Error ? e.message : "Failed");
		}
	};

	const uploadKbFile = async (file: File) => {
		try {
			const text = await file.text();
			await api(`/v1/instances/${instanceId}/knowledge`, {
				method: "POST",
				body: JSON.stringify({ title: file.name, content: text, source: "upload" }),
			});
			loadDocs();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const uploadFile = async (file: File) => {
		try {
			const reader = new FileReader();
			const base64 = await new Promise<string>((resolve) => {
				reader.onload = () => resolve((reader.result as string).split(",")[1]);
				reader.readAsDataURL(file);
			});
			await api(`/v1/instances/${instanceId}/files`, {
				method: "POST",
				body: JSON.stringify({ name: file.name, data: base64, contentType: file.type }),
			});
			loadFiles();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const subTabs: { id: KbSubTab; label: string }[] = [
		{ id: "docs", label: "Documents" },
		{ id: "memory", label: "Memory" },
		{ id: "files", label: "Files" },
		{ id: "credentials", label: "Credentials" },
		{ id: "rules", label: "Rules & Tips" },
		{ id: "chat", label: "Chat" },
	];

	return (
		<div>
			{/* Sub-tab bar */}
			<div className="flex gap-0 border-b border-line mb-4 overflow-x-auto">
				{subTabs.map((t) => (
					<button
						key={t.id}
						type="button"
						onClick={() => setSubTab(t.id)}
						className={`px-3 py-2 text-sm font-bold border-b-2 whitespace-nowrap transition-all ${
							subTab === t.id
								? "text-accent border-accent"
								: "text-muted border-transparent hover:text-ink"
						}`}
					>
						{t.label}
					</button>
				))}
			</div>

			{/* Documents */}
			{subTab === "docs" && (
				<div>
					<div className="flex justify-between items-center gap-2 mb-3 flex-wrap">
						<h3 className="text-base font-bold">Documents</h3>
						<div className="flex gap-1.5 flex-wrap">
							<button type="button" onClick={() => { setShowPaste(true); setShowUrl(false); }} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold">+ Text</button>
							<button type="button" onClick={() => { setShowUrl(true); setShowPaste(false); }} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold">+ URL</button>
							<label className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold cursor-pointer">
								+ File
								<input type="file" accept=".txt,.md,.csv,.json,.html" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadKbFile(f); e.target.value = ""; }} />
							</label>
						</div>
					</div>

					{showPaste && (
						<div className="bg-panel border border-line rounded-xl p-4 mb-3">
							<input value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} placeholder="Title" className="mb-2" />
							<textarea value={pasteContent} onChange={(e) => setPasteContent(e.target.value)} placeholder="Paste your text..." className="min-h-[100px] mb-2" />
							<div className="flex gap-2">
								<button type="button" onClick={addPaste} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Add</button>
								<button type="button" onClick={() => setShowPaste(false)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Cancel</button>
							</div>
						</div>
					)}

					{showUrl && (
						<div className="bg-panel border border-line rounded-xl p-4 mb-3">
							<input value={urlValue} onChange={(e) => setUrlValue(e.target.value)} placeholder="https://..." className="mb-2" />
							<input value={urlTitle} onChange={(e) => setUrlTitle(e.target.value)} placeholder="Title (auto-detected)" className="mb-2" />
							<div className="flex gap-2">
								<button type="button" onClick={addUrl} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Import</button>
								<button type="button" onClick={() => setShowUrl(false)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Cancel</button>
							</div>
						</div>
					)}

					{docs.length === 0 ? (
						<p className="text-center py-4 text-muted-soft text-sm">No documents yet.</p>
					) : (
						<div className="flex flex-col gap-2">
							{docs.map((d) => (
								<div key={d.id} className="bg-panel border border-line rounded-lg p-3 flex justify-between items-start gap-3">
									<div>
										<div className="font-semibold text-sm">{d.title}</div>
										{d.source && <div className="text-xs text-muted mt-0.5">{d.source}</div>}
									</div>
									<button type="button" onClick={() => deleteDoc(d.id)} className="text-xs text-red shrink-0">Delete</button>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Memory */}
			{subTab === "memory" && (
				<div>
					<h3 className="text-base font-bold mb-3">Agent Memory</h3>
					{memories.length === 0 ? (
						<p className="text-center py-4 text-muted-soft text-sm">No memories stored yet.</p>
					) : (
						<div className="flex flex-col gap-2">
							{memories.map((m) => (
								<div key={m.key} className="bg-panel border border-line rounded-lg p-3">
									<div className="flex justify-between items-start gap-2">
										<div>
											<span className="font-semibold text-sm">{m.key}</span>
											<span className="text-xs text-purple-400 ml-2">{m.type}</span>
										</div>
									</div>
									<div className="text-sm text-muted mt-1">{m.content}</div>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Files */}
			{subTab === "files" && (
				<div>
					<div className="flex justify-between items-center gap-2 mb-3">
						<h3 className="text-base font-bold">Files</h3>
						<label className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold cursor-pointer">
							Upload File
							<input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }} />
						</label>
					</div>
					{files.length === 0 ? (
						<p className="text-center py-4 text-muted-soft text-sm">No files uploaded yet.</p>
					) : (
						<div className="flex flex-col gap-2">
							{files.map((f) => (
								<div key={f.id} className="bg-panel border border-line rounded-lg p-3 flex justify-between items-center gap-3">
									<div className="text-sm font-semibold">{f.name}</div>
									<button type="button" onClick={() => deleteFile(f.id)} className="text-xs text-red shrink-0">Delete</button>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Credentials */}
			{subTab === "credentials" && (
				<div>
					<h3 className="text-base font-bold mb-1">Credentials</h3>
					<p className="text-xs text-muted mb-3">Logins & secrets the agent signs in with. Passwords are encrypted at rest.</p>
					{credentials.length === 0 ? (
						<p className="text-center py-4 text-muted-soft text-sm">No credentials saved yet.</p>
					) : (
						<div className="flex flex-col gap-2">
							{credentials.map((c) => (
								<div key={c.id} className="bg-panel border border-line rounded-lg p-3">
									<div className="font-semibold text-sm">{c.domain}</div>
									{c.username && <div className="text-xs text-muted mt-0.5">{c.username}</div>}
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Rules & Tips */}
			{subTab === "rules" && (
				<div>
					<h3 className="text-base font-bold mb-1">Special Instructions</h3>
					<p className="text-xs text-muted mb-2">
						Rules this agent must follow. Injected at the top of the agent's prompt.
					</p>
					<textarea
						value={instructions}
						onChange={(e) => setInstructions(e.target.value)}
						placeholder={`e.g.\n- Use British English.\n- Never run destructive commands without asking.`}
						className="min-h-[130px] w-full mb-2"
					/>
					<div className="flex items-center gap-2">
						<button type="button" onClick={saveInstructions} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">
							Save instructions
						</button>
						{instrStatus && <span className="text-xs text-muted">{instrStatus}</span>}
					</div>
				</div>
			)}

			{/* Chat */}
			{subTab === "chat" && (
				<div className="text-center py-8 text-muted text-sm">
					KB Chat — coming soon
				</div>
			)}
		</div>
	);
}
