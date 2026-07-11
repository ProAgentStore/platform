import { useState, useEffect, useCallback } from "react";
import { api } from "@proagentstore/sdk/client";
import type { KnowledgeDoc, Credential } from "../lib/types";
import { useUploader } from "../lib/use-uploader";
import FilesSection from "../components/FilesSection";
import MemorySection from "../components/MemorySection";
import VectorsSection from "../components/VectorsSection";
import { formatTime, renderMd } from "@proagentstore/sdk/ui";

type KbSubTab = "docs" | "memory" | "files" | "index" | "credentials" | "rules";

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime?: string;
	webViewLink?: string;
}

interface Props {
	instanceId: string;
	isApply: boolean;
}

export default function KnowledgeTab({ instanceId, isApply }: Props) {
	const [subTab, setSubTab] = useState<KbSubTab>("docs");
	const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
	const [credentials, setCredentials] = useState<Credential[]>([]);
	const [instructions, setInstructions] = useState("");
	const [instrStatus, setInstrStatus] = useState("");
	// Bumped when an upload lands so FilesSection reloads its list.
	const [filesRefresh, setFilesRefresh] = useState(0);

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
	const [showDrive, setShowDrive] = useState(false);
	const [driveStatus, setDriveStatus] = useState<{ connected: boolean; configured: boolean; email?: string | null } | null>(null);
	const [driveQuery, setDriveQuery] = useState("");
	const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
	const [driveLoading, setDriveLoading] = useState(false);
	const [driveMsg, setDriveMsg] = useState("");
	const [importingDriveId, setImportingDriveId] = useState<string | null>(null);

	const loadDocs = useCallback(async () => {
		try {
			// The DO returns { documents: [...] } with full content.
			const d = await api<{ documents?: KnowledgeDoc[]; knowledge?: KnowledgeDoc[] }>(`/v1/instances/${instanceId}/knowledge`);
			setDocs(d.documents || d.knowledge || []);
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

	// Lazy-load: only fetch data for the active sub-tab (Files/Memory sections load themselves)
	useEffect(() => {
		if (subTab === "docs") loadDocs();
		else if (subTab === "credentials") loadCredentials();
		else if (subTab === "rules") loadInstructions();
	}, [subTab, loadDocs, loadCredentials, loadInstructions]);

	useEffect(() => {
		if (subTab !== "docs") return;
		(async () => {
			try {
				const s = await api<{ connected: boolean; configured: boolean; email?: string | null }>("/v1/drive/status");
				setDriveStatus(s);
			} catch {}
		})();
	}, [subTab]);

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

	const searchDrive = async () => {
		setDriveLoading(true);
		setDriveMsg("");
		try {
			const params = new URLSearchParams();
			if (driveQuery.trim()) params.set("q", driveQuery.trim());
			params.set("limit", "20");
			const d = await api<{ files?: DriveFile[] }>(`/v1/drive/files?${params}`);
			setDriveFiles(d.files || []);
			if (!d.files?.length) setDriveMsg("No matching Drive files.");
		} catch (e) {
			setDriveMsg(e instanceof Error ? e.message : "Drive search failed");
		}
		setDriveLoading(false);
	};

	const importDriveFile = async (file: DriveFile) => {
		setImportingDriveId(file.id);
		setDriveMsg("");
		try {
			await api(`/v1/drive/instances/${instanceId}/import`, {
				method: "POST",
				body: JSON.stringify({ fileId: file.id }),
			});
			setDriveMsg(`Imported ${file.name}.`);
			setShowDrive(false);
			setDriveFiles([]);
			loadDocs();
		} catch (e) {
			setDriveMsg(e instanceof Error ? e.message : "Drive import failed");
		}
		setImportingDriveId(null);
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

	// Resumable uploader for EVERY file (progress, pause, survives disconnects).
	// Small files are a single-part multipart — same UX, same progress rows,
	// instead of the old silent single-shot request users read as "nothing
	// happened". Lives HERE (not in FilesSection) because the Documents tab's
	// "+ File" button shares it.
	const uploader = useUploader(instanceId, () => setFilesRefresh((k) => k + 1));
	const uploadFile = async (file: File) => uploader.start(file);

	const supportedDriveFile = (file: DriveFile) => (
		file.mimeType.startsWith("text/") ||
		file.mimeType === "application/json" ||
		file.mimeType === "application/xml" ||
		file.mimeType === "application/x-ndjson" ||
		file.mimeType === "application/yaml" ||
		file.mimeType === "application/vnd.google-apps.document" ||
		file.mimeType === "application/vnd.google-apps.spreadsheet" ||
		file.mimeType === "application/vnd.google-apps.presentation"
	);

	const subTabs: { id: KbSubTab; label: string }[] = [
		{ id: "docs", label: "Documents" },
		{ id: "memory", label: "Memory" },
		{ id: "files", label: "Files" },
		{ id: "index", label: "Index" },
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
								<button type="button" onClick={() => setShowDrive((s) => !s)} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold">+ Drive</button>
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

						{showDrive && (
							<div className="bg-panel border border-line rounded-xl p-4 mb-3">
								{driveStatus?.connected ? (
									<>
										<div className="flex gap-2 mb-2 flex-wrap">
											<input
												value={driveQuery}
												onChange={(e) => setDriveQuery(e.target.value)}
												onKeyDown={(e) => { if (e.key === "Enter") searchDrive(); }}
												placeholder="Search Google Drive"
												className="flex-1 min-w-[12rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm"
											/>
											<button type="button" onClick={searchDrive} disabled={driveLoading} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold disabled:opacity-50">
												{driveLoading ? "Searching..." : "Search"}
											</button>
											<button type="button" onClick={() => setShowDrive(false)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Cancel</button>
										</div>
										{driveFiles.length > 0 && (
											<div className="flex flex-col gap-2 mt-3">
												{driveFiles.map((f) => {
													const supported = supportedDriveFile(f);
													return (
														<div key={f.id} className="bg-paper border border-line rounded-lg p-3 flex items-start justify-between gap-3">
															<div className="min-w-0">
																<div className="text-sm font-semibold truncate">{f.name}</div>
																<div className="text-xs text-muted truncate">{f.mimeType}</div>
															</div>
															<button
																type="button"
																disabled={!supported || importingDriveId === f.id}
																onClick={() => importDriveFile(f)}
																className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
															>
																{importingDriveId === f.id ? "Importing..." : supported ? "Import" : "Unsupported"}
															</button>
														</div>
													);
												})}
											</div>
										)}
									</>
								) : (
									<p className="text-sm text-muted">Connect Google Drive in Settings before importing Drive files.</p>
								)}
								{driveMsg && <div className="text-xs text-muted mt-2">{driveMsg}</div>}
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
			{subTab === "memory" && <MemorySection instanceId={instanceId} active={subTab === "memory"} />}

			{/* Files */}
			{subTab === "files" && (
				<FilesSection
					instanceId={instanceId}
					active={subTab === "files"}
					refreshKey={filesRefresh}
					jobs={uploader.jobs}
					onUpload={uploadFile}
					onPause={uploader.pause}
					onResume={uploader.resume}
					onCancel={uploader.cancel}
				/>
			)}

			{/* Index — what's in the vector store + a live test search */}
			{subTab === "index" && <VectorsSection instanceId={instanceId} active={subTab === "index"} />}

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
