/**
 * In-console document preview — standard/browser-native renderers only:
 * PDFs use the browser's BUILT-IN viewer (iframe over a blob URL — Chrome,
 * Safari, and Firefox all ship one), images use <img>, text formats render as
 * text (markdown through the existing renderMd). Anything else gets a
 * download-only card. The blob is fetched with the bearer token (an iframe
 * can't carry Authorization headers), so previews are capped at 50MB —
 * larger files are download-only.
 */
import { useEffect, useState } from "react";
import { API, getToken } from "@proagentstore/sdk/client";
import { renderMd } from "@proagentstore/sdk/ui";
import { X, Download } from "lucide-react";

const PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

export interface PreviewFile {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
}

type Kind = "pdf" | "image" | "markdown" | "text" | "none";

function kindOf(f: PreviewFile): Kind {
	const mime = (f.mimeType || "").toLowerCase();
	const name = f.name.toLowerCase();
	if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
	if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|avif)$/.test(name)) return "image";
	if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
	if (
		mime.startsWith("text/") ||
		/\.(txt|csv|json|html?|xml|yml|yaml|toml|log|js|ts|tsx|css|py|go|rs|sh|sql)$/.test(name)
	) return "text";
	return "none";
}

export default function FilePreview({ instanceId, file, onClose }: {
	instanceId: string;
	file: PreviewFile;
	onClose: () => void;
}) {
	const kind = kindOf(file);
	const tooBig = (file.size ?? 0) > PREVIEW_MAX_BYTES;
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(kind !== "none" && !tooBig);

	useEffect(() => {
		if (kind === "none" || tooBig) return;
		let url: string | null = null;
		let alive = true;
		(async () => {
			try {
				const res = await fetch(`${API}/v1/instances/${instanceId}/files/${encodeURIComponent(file.id)}`, {
					headers: { Authorization: `Bearer ${getToken() ?? ""}` },
				});
				if (!res.ok) throw new Error(`Preview failed (HTTP ${res.status})`);
				const blob = await res.blob();
				if (!alive) return;
				if (kind === "markdown" || kind === "text") {
					setText(await blob.text());
				} else {
					// The browser's native viewers take object URLs; ensure the PDF blob
					// carries the right type so the built-in PDF renderer engages.
					url = URL.createObjectURL(kind === "pdf" ? new Blob([blob], { type: "application/pdf" }) : blob);
					setBlobUrl(url);
				}
			} catch (e) {
				if (alive) setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (alive) setLoading(false);
			}
		})();
		return () => {
			alive = false;
			if (url) URL.revokeObjectURL(url);
		};
	}, [instanceId, file.id, kind, tooBig]);

	const download = async () => {
		try {
			const res = await fetch(`${API}/v1/instances/${instanceId}/files/${encodeURIComponent(file.id)}`, {
				headers: { Authorization: `Bearer ${getToken() ?? ""}` },
			});
			if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
			const url = URL.createObjectURL(await res.blob());
			const a = document.createElement("a");
			a.href = url;
			a.download = file.name;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-3 sm:p-6" onClick={onClose}>
			<div
				className="bg-panel border border-line rounded-xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-line shrink-0">
					<div className="text-sm font-semibold truncate">{file.name}</div>
					<div className="flex items-center gap-1.5 shrink-0">
						<button type="button" onClick={download} title="Download" className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold flex items-center gap-1.5"><Download size={13} /> Download</button>
						<button type="button" onClick={onClose} title="Close" className="text-xs px-2 py-1.5 rounded-lg border border-line text-muted hover:text-accent"><X size={14} /></button>
					</div>
				</div>
				<div className="flex-1 min-h-0 overflow-auto bg-paper">
					{loading && <p className="text-center py-10 text-muted text-sm">Loading preview…</p>}
					{error && <p className="text-center py-10 text-red text-sm">{error}</p>}
					{!loading && !error && (kind === "none" || tooBig) && (
						<p className="text-center py-10 text-muted text-sm">
							{tooBig ? "Too large to preview — use Download." : "No preview for this format — use Download."}
						</p>
					)}
					{blobUrl && kind === "pdf" && (
						<iframe src={blobUrl} title={file.name} className="w-full h-full border-0" />
					)}
					{blobUrl && kind === "image" && (
						<div className="flex items-center justify-center h-full p-4">
							<img src={blobUrl} alt={file.name} className="max-w-full max-h-full object-contain" />
						</div>
					)}
					{text !== null && kind === "markdown" && (
						<div className="p-4 msg-md text-sm" dangerouslySetInnerHTML={{ __html: renderMd(text) }} />
					)}
					{text !== null && kind === "text" && (
						<pre className="p-4 text-xs whitespace-pre-wrap break-words">{text}</pre>
					)}
				</div>
			</div>
		</div>
	);
}
