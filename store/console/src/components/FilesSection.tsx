/**
 * The Knowledge tab's Files sub-tab, extracted: upload button, live resumable
 * upload rows (progress / pause / resume / cancel — see lib/use-uploader), the
 * file list with per-file preview + download + delete. KnowledgeTab keeps only
 * the upload ROUTING (small vs multipart) since its Documents tab shares it.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { UploadJob } from "../lib/use-uploader";
import { buttonClass } from "../lib/control-classes";
import Button from "./Button";
import Card from "./Card";
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
		const shouldReload = active && Number.isFinite(refreshKey);
		if (shouldReload) loadFiles();
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
				{/* A <label> wrapping a hidden file input, not a <button> — clicking a real button
				    cannot open the file picker. It still has to LOOK like one, so it takes the same
				    class table rather than a fifteenth hand-written copy of the secondary shape. */}
				<label className={buttonClass("secondary", "md", "cursor-pointer")}>
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
						<Card key={j.localId}>
							<div className="flex justify-between items-center gap-3 mb-1.5">
								<div className="text-sm font-semibold truncate">{j.fileName}</div>
								<div className="flex gap-1.5 shrink-0 items-center">
									<span className="text-xs text-muted">
										{j.status === "done" ? "Done ✓" : `${fmtBytes(j.uploaded)} / ${fmtBytes(j.size)}`}
									</span>
									{j.status === "uploading" && (
										<Button size="sm" onClick={() => onPause(j.localId)}>Pause</Button>
									)}
									{(j.status === "paused" || j.status === "error") && (
										<Button size="sm" variant="primary" onClick={() => onResume(j.localId)}>Resume</Button>
									)}
									{j.status !== "done" && (
										<Button size="sm" variant="danger" onClick={() => onCancel(j.localId)}>Cancel</Button>
									)}
								</div>
							</div>
							<div className="h-1.5 bg-line rounded-full overflow-hidden">
								<div
									className={`h-full rounded-full transition-all ${j.status === "error" ? "bg-danger" : j.status === "paused" ? "bg-muted" : "bg-accent"}`}
									style={{ width: `${Math.min(100, Math.round((j.uploaded / Math.max(1, j.size)) * 100))}%` }}
								/>
							</div>
							{j.error && <div className="text-xs text-danger mt-1">{j.error}</div>}
						</Card>
					))}
				</div>
			)}

			{files.length === 0 ? (
				<p className="text-center py-4 text-muted-soft text-sm">No files uploaded yet.</p>
			) : (
				<div className="flex flex-col gap-2">
					{files.map((f) => (
						<Card key={f.id} className="flex justify-between items-center gap-3">
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
								<Button size="sm" onClick={() => setPreview(f)}>Preview</Button>
								<button type="button" onClick={() => deleteFile(f.id)} className="text-xs text-danger">Delete</button>
							</div>
						</Card>
					))}
				</div>
			)}

			{preview && <FilePreview instanceId={instanceId} file={preview} onClose={() => setPreview(null)} />}
		</div>
	);
}
