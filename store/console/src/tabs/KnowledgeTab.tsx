import { useState, useEffect, useCallback } from "react";
import { api } from "@proagentstore/sdk/client";
import type { KnowledgeDoc, MemoryEntry, Credential } from "../lib/types";
import { formatTime, renderMd } from "@proagentstore/sdk/ui";

type KbSubTab = "docs" | "memory" | "files" | "credentials" | "rules";

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

	// Document editor/viewer: openId = null (list) | "__new__" | a doc id.
	const [openId, setOpenId] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [editTitle, setEditTitle] = useState("");
	const [editContent, setEditContent] = useState("");
	const [preview, setPreview] = useState(false);
	const [savingDoc, setSavingDoc] = useState(false);

	// URL form
	const [showUrl, setShowUrl] = useState(false);
	const [urlValue, setUrlValue] = useState("");
	const [urlTitle, setUrlTitle] = useState("");

	// Memory editor: one row editable at a time; key is identity (rename = delete + add).
	const [editMemKey, setEditMemKey] = useState<string | null>(null);
	const [editMemContent, setEditMemContent] = useState("");
	const [showAddMem, setShowAddMem] = useState(false);
	const [newMemKey, setNewMemKey] = useState("");
	const [newMemType, setNewMemType] = useState("knowledge");
	const [newMemContent, setNewMemContent] = useState("");

	const loadDocs = useCallback(async () => {
		try {
			// The DO returns { documents: [...] } with full content.
			const d = await api<{ documents?: KnowledgeDoc[]; knowledge?: KnowledgeDoc[] }>(`/v1/instances/${instanceId}/knowledge`);
			setDocs(d.documents || d.knowledge || []);
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

	// Lazy-load: only fetch data for the active sub-tab
	useEffect(() => {
		if (subTab === "docs") loadDocs();
		else if (subTab === "memory") loadMemory();
		else if (subTab === "files") loadFiles();
		else if (subTab === "credentials") loadCredentials();
		else if (subTab === "rules") loadInstructions();
	}, [subTab, loadDocs, loadMemory, loadFiles, loadCredentials, loadInstructions]);

	const openNew = () => { setOpenId("__new__"); setEditing(true); setEditTitle(""); setEditContent(""); setPreview(false); setShowUrl(false); };
	const openView = (d: KnowledgeDoc) => { setOpenId(d.id); setEditing(false); setPreview(false); };
	const startEdit = (d: KnowledgeDoc) => { setOpenId(d.id); setEditing(true); setEditTitle(d.title); setEditContent(d.content || ""); setPreview(false); };
	const closeDoc = () => { setOpenId(null); setEditing(false); };

	// Save a Markdown document: create (POST) for a new one, else amend (PUT).
	const saveDoc = async () => {
		if (!editTitle.trim()) { alert("Give the document a title."); return; }
		setSavingDoc(true);
		try {
			if (openId === "__new__") {
				const created = await api<{ id: string }>(`/v1/instances/${instanceId}/knowledge`, {
					method: "POST",
					body: JSON.stringify({ title: editTitle.trim(), content: editContent, source: "paste" }),
				});
				await loadDocs();
				setOpenId(created.id || null);
			} else if (openId) {
				await api(`/v1/instances/${instanceId}/knowledge/${openId}`, {
					method: "PUT",
					body: JSON.stringify({ title: editTitle.trim(), content: editContent }),
				});
				await loadDocs();
			}
			setEditing(false);
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
		setSavingDoc(false);
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
		try {
			await api(`/v1/instances/${instanceId}/knowledge/${docId}`, { method: "DELETE" });
			if (openId === docId) closeDoc();
			loadDocs();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const deleteFile = async (fileId: string) => {
		if (!confirm("Delete this file?")) return;
		try {
			await api(`/v1/instances/${instanceId}/files/${fileId}`, { method: "DELETE" });
			loadFiles();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

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
			// Binary (PDF etc.) or large files belong to the FILES pipeline (R2 +
			// text-extraction + vectorize, no meaningful size cap) — knowledge DOCS are
			// small pasted text, capped at 100KB by Durable Object storage. Route
			// automatically instead of erroring with "Document too large".
			const isTextDoc = /\.(txt|md|csv|json|html?)$/i.test(file.name) && !file.type.includes("pdf");
			if (!isTextDoc || file.size > 100_000) {
				await uploadFile(file);
				setSubTab("files");
				return;
			}
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
			// The DO expects contentBase64 + mime_type (NOT data/contentType) — the old
			// field names made EVERY binary upload 400 with "name and content or
			// contentBase64 required".
			await api(`/v1/instances/${instanceId}/files`, {
				method: "POST",
				body: JSON.stringify({ name: file.name, contentBase64: base64, mime_type: file.type || "application/octet-stream" }),
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

			{/* Documents — first-class Markdown docs: create, read (rendered), edit. The
			    agent reads/writes these too, so you can ask the Assistant to update one. */}
			{subTab === "docs" && (() => {
				const openDoc = openId && openId !== "__new__" ? docs.find((d) => d.id === openId) : null;

				// ── Editor (new or editing an existing doc) ──
				if (openId === "__new__" || (openDoc && editing)) {
					return (
						<div>
							<div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
								<input
									value={editTitle}
									onChange={(e) => setEditTitle(e.target.value)}
									placeholder="Document title"
									className="flex-1 min-w-[12rem] bg-panel border border-line rounded-lg px-3 py-2 text-sm font-semibold"
									autoFocus
								/>
								<div className="flex gap-1.5">
									<button type="button" onClick={() => setPreview((p) => !p)} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold">{preview ? "Write" : "Preview"}</button>
									<button type="button" onClick={saveDoc} disabled={savingDoc} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold disabled:opacity-50">{savingDoc ? "Saving…" : "Save"}</button>
									<button type="button" onClick={() => (openId === "__new__" ? closeDoc() : setEditing(false))} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted font-semibold">Cancel</button>
								</div>
							</div>
							{preview ? (
								<div className="bg-paper border border-line rounded-xl p-4 min-h-[320px] msg-md" dangerouslySetInnerHTML={{ __html: renderMd(editContent || "_Nothing to preview yet._") }} />
							) : (
								<textarea
									value={editContent}
									onChange={(e) => setEditContent(e.target.value)}
									placeholder={"# Heading\n\nWrite in **Markdown**. Lists, links, tables — all supported.\n\n- point one\n- point two"}
									className="w-full min-h-[320px] bg-panel border border-line rounded-xl px-3 py-2.5 text-sm font-mono leading-relaxed"
								/>
							)}
							<p className="text-xs text-muted-soft mt-2">Markdown. The agent can read and update this document too — ask the Assistant.</p>
						</div>
					);
				}

				// ── Viewer (rendered Markdown) ──
				if (openDoc) {
					return (
						<div>
							<div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
								<div className="flex items-center gap-2 min-w-0">
									<button type="button" onClick={closeDoc} className="text-xs text-muted hover:text-accent shrink-0">← Documents</button>
									<h3 className="text-base font-bold truncate">{openDoc.title}</h3>
								</div>
								<div className="flex gap-1.5">
									<button type="button" onClick={() => startEdit(openDoc)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold">Edit</button>
									<button type="button" onClick={() => deleteDoc(openDoc.id)} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-red hover:bg-red/10 font-semibold">Delete</button>
								</div>
							</div>
							{openDoc.source && <div className="text-xs text-muted-soft mb-2">{openDoc.source}{openDoc.createdAt ? ` · ${formatTime(openDoc.createdAt)}` : ""}</div>}
							<div className="bg-paper border border-line rounded-xl p-4 msg-md" dangerouslySetInnerHTML={{ __html: renderMd(openDoc.content || "_This document is empty. Click Edit to add content._") }} />
						</div>
					);
				}

				// ── List ──
				return (
					<div>
						<div className="flex justify-between items-center gap-2 mb-3 flex-wrap">
							<h3 className="text-base font-bold">Documents</h3>
							<div className="flex gap-1.5 flex-wrap">
								<button type="button" onClick={openNew} className="text-xs px-2.5 py-1.5 rounded-lg bg-accent text-white font-bold">+ New</button>
								<button type="button" onClick={() => setShowUrl((s) => !s)} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold">+ URL</button>
								<label className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold cursor-pointer">
									+ File
									<input type="file" accept=".txt,.md,.csv,.json,.html,.htm,.pdf,.xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadKbFile(f); e.target.value = ""; }} />
								</label>
							</div>
						</div>

						{showUrl && (
							<div className="bg-panel border border-line rounded-xl p-4 mb-3">
								<input value={urlValue} onChange={(e) => setUrlValue(e.target.value)} placeholder="https://..." className="mb-2 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
								<input value={urlTitle} onChange={(e) => setUrlTitle(e.target.value)} placeholder="Title (auto-detected)" className="mb-2 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
								<div className="flex gap-2">
									<button type="button" onClick={addUrl} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Import</button>
									<button type="button" onClick={() => setShowUrl(false)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Cancel</button>
								</div>
							</div>
						)}

						{docs.length === 0 ? (
							<p className="text-center py-6 text-muted-soft text-sm">No documents yet. Click <b>+ New</b> to write one in Markdown.</p>
						) : (
							<div className="flex flex-col gap-2">
								{docs.map((d) => (
									<button key={d.id} type="button" onClick={() => openView(d)} className="text-left bg-panel border border-line rounded-lg p-3 flex justify-between items-start gap-3 hover:border-accent transition-colors">
										<div className="min-w-0">
											<div className="font-semibold text-sm truncate">{d.title}</div>
											<div className="text-xs text-muted mt-0.5 line-clamp-1">{(d.content || "").replace(/[#*_`>\-]/g, "").trim().slice(0, 100) || d.source || "Empty"}</div>
										</div>
										<span className="text-xs text-accent shrink-0">Open →</span>
									</button>
								))}
							</div>
						)}
					</div>
				);
			})()}

			{/* Memory */}
			{subTab === "memory" && (
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
		</div>
	);
}
