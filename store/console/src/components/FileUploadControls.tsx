/** Shared private Files upload picker and resumable progress, used by Knowledge and Tailor. */
import type { UploadJob } from "../lib/use-uploader";
import { buttonClass } from "../lib/control-classes";
import Button from "./Button";
import Card from "./Card";

const fmtBytes = (n: number) =>
	n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

export function uploadSelectedFiles(input: { files: ArrayLike<File> | null; value: string }, onUpload: (file: File) => void): void {
	for (const file of Array.from(input.files ?? [])) onUpload(file);
	input.value = "";
}

export interface FileUploadControlsProps {
	title?: string;
	jobs: UploadJob[];
	onUpload: (file: File) => void;
	onPause: (localId: string) => void;
	onResume: (localId: string) => void;
	onCancel: (localId: string) => void;
}

export default function FileUploadControls({ title = "Files", jobs, onUpload, onPause, onResume, onCancel }: FileUploadControlsProps) {
	return <div>
			<div className="flex justify-between items-center gap-2 mb-3">
				<h3 className="text-base font-bold">{title}</h3>
				{/* A <label> wrapping a hidden file input, not a <button> — clicking a real button
				    cannot open the file picker. It still has to LOOK like one, so it takes the same
				    class table rather than a fifteenth hand-written copy of the secondary shape. */}
				<label className={buttonClass("secondary", "md", "cursor-pointer")}>
					Upload files
					<input type="file" multiple className="hidden" onChange={(e) => uploadSelectedFiles(e.currentTarget, onUpload)} />
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

	</div>;
}
