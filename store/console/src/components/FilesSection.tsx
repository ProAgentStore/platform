/**
 * The Knowledge tab's Files sub-tab, extracted: upload button, live resumable
 * upload rows (progress / pause / resume / cancel — see lib/use-uploader), the
 * file list with per-file preview + download + delete. KnowledgeTab keeps only
 * the upload ROUTING (small vs multipart) since its Documents tab shares it.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { UploadJob } from "../lib/use-uploader";
import FilePreview, { type PreviewFile } from "./FilePreview";

interface FileItem {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
	createdAt?: string;
}

const fmtBytes = (n: number) =>
	n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

export default function FilesSection({ instanceId, active, refreshKey, jobs, onUpload, onPause, onResume, onCancel }: {
	instanceId: string;
	/** Only load when the Files sub-tab is actually shown. */
	active: boolean;
	/** Bumped by the parent when an upload completes → reload the list. */
	refreshKey: number;
	jobs: UploadJob[];
	onUpload: (file: File) => void;
	onPause: (localId: string) => void;
	onResume: (localId: string) => void;
	onCancel: (localId: string) => void;
}) {
	const [files, setFiles] = useState<FileItem[]>([]);
	const [preview, setPreview] = useState<PreviewFile | null>(null);

	const loadFiles = useCallback(async () => {
		try {
			const d = await api<{ files: FileItem[] }>(`/v1/instances/${instanceId}/files`);
			setFiles(d.files || []);
		} catch {}
	}, [instanceId]);

	useEffect(() => {
		if (active) loadFiles();
	}, [active, refreshKey, loadFiles]);

	const deleteFile = async (fileId: string) => {
		if (!confirm("Delete this file?")) return;
		try {
			await api(`/v1/instances/${instanceId}/files/${fileId}`, { method: "DELETE" });
			loadFiles();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div>
			<div className="flex justify-between items-center gap-2 mb-3">
				<h3 className="text-base font-bold">Files</h3>
				<label className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold cursor-pointer">
					Upload File
					<input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} />
				</label>
			</div>

			{/* In-flight resumable uploads: live progress + pause/resume/cancel. An
			    interrupted upload (disconnect, closed tab) resumes from its last
			    completed part when the same file is selected again. */}
			{jobs.length > 0 && (
				<div className="flex flex-col gap-2 mb-3">
					{jobs.map((j) => (
						<div key={j.localId} className="bg-panel border border-line rounded-lg p-3">
							<div className="flex justify-between items-center gap-3 mb-1.5">
								<div className="text-sm font-semibold truncate">{j.fileName}</div>
								<div className="flex gap-1.5 shrink-0 items-center">
									<span className="text-xs text-muted">
										{j.status === "done" ? "Done ✓" : `${fmtBytes(j.uploaded)} / ${fmtBytes(j.size)}`}
									</span>
									{j.status === "uploading" && (
										<button type="button" onClick={() => onPause(j.localId)} className="text-xs px-2 py-1 rounded border border-line text-muted hover:border-accent hover:text-accent">Pause</button>
									)}
									{(j.status === "paused" || j.status === "error") && (
										<button type="button" onClick={() => onResume(j.localId)} className="text-xs px-2 py-1 rounded bg-accent text-white font-bold">Resume</button>
									)}
									{j.status !== "done" && (
										<button type="button" onClick={() => onCancel(j.localId)} className="text-xs px-2 py-1 rounded border border-line text-red hover:bg-red/10">Cancel</button>
									)}
								</div>
							</div>
							<div className="h-1.5 bg-line rounded-full overflow-hidden">
								<div
									className={`h-full rounded-full transition-all ${j.status === "error" ? "bg-red" : j.status === "paused" ? "bg-muted" : "bg-accent"}`}
									style={{ width: `${Math.min(100, Math.round((j.uploaded / Math.max(1, j.size)) * 100))}%` }}
								/>
							</div>
							{j.error && <div className="text-xs text-red mt-1">{j.error}</div>}
						</div>
					))}
				</div>
			)}

			{files.length === 0 ? (
				<p className="text-center py-4 text-muted-soft text-sm">No files uploaded yet.</p>
			) : (
				<div className="flex flex-col gap-2">
					{files.map((f) => (
						<div key={f.id} className="bg-panel border border-line rounded-lg p-3 flex justify-between items-center gap-3">
							<button
								type="button"
								onClick={() => setPreview(f)}
								title="Preview"
								className="text-sm font-semibold truncate text-left hover:text-accent transition-colors"
							>
								{f.name}
							</button>
							<div className="flex items-center gap-2 shrink-0">
								{typeof f.size === "number" && f.size > 0 && <span className="text-xs text-muted-soft">{fmtBytes(f.size)}</span>}
								<button type="button" onClick={() => setPreview(f)} className="text-xs px-2 py-1 rounded border border-line text-muted hover:border-accent hover:text-accent">Preview</button>
								<button type="button" onClick={() => deleteFile(f.id)} className="text-xs text-red">Delete</button>
							</div>
						</div>
					))}
				</div>
			)}

			{preview && <FilePreview instanceId={instanceId} file={preview} onClose={() => setPreview(null)} />}
		</div>
	);
}
