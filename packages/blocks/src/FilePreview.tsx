/**
 * In-app document preview (#187) — standard/browser-native renderers only: PDFs use the browser's
 * built-in viewer (an iframe over a blob URL), images use <img>, text formats render as text
 * (markdown through the SDK's renderMd). Anything else gets a download-only card. Files over 50MB
 * are download-only.
 *
 * Prop-driven: the caller owns the network (`fetchBlob`, told whether it is for a preview or a download so its error can say which — an iframe can't carry Authorization
 * headers, so the caller fetches with its token), the button component, and what a failed
 * download does (`onDownloadError`; it was a native alert before the block was lifted out).
 */
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { useModalLock } from "@proagentstore/sdk/hooks";
import { renderMd } from "@proagentstore/sdk/ui";
import { SafeHtmlView } from "@proagentstore/sdk/ui-react";
import { Download, X } from "lucide-react";

export const PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

export interface PreviewFile {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
}

export type PreviewKind = "pdf" | "image" | "markdown" | "text" | "none";

export function previewKind(f: PreviewFile): PreviewKind {
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

/** The slice of the console's Button this block uses. */
export type PreviewButton = ComponentType<{
	onClick: () => void;
	title: string;
	size?: "icon";
	"aria-label"?: string;
	children: ReactNode;
}>;

export function FilePreview({ file, fetchBlob, onClose, onDownloadError, Button }: {
	file: PreviewFile;
	fetchBlob: (file: PreviewFile, purpose: "preview" | "download") => Promise<Blob>;
	onClose: () => void;
	onDownloadError: (message: string) => void;
	Button: PreviewButton;
}) {
	const kind = previewKind(file);
	const tooBig = (file.size ?? 0) > PREVIEW_MAX_BYTES;
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(kind !== "none" && !tooBig);
	const panelRef = useRef<HTMLDivElement>(null);
	useModalLock(panelRef);

	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the file's identity, not the fetchBlob closure a caller may rebuild each render.
	useEffect(() => {
		if (kind === "none" || tooBig) return;
		let url: string | null = null;
		let alive = true;
		(async () => {
			try {
				const blob = await fetchBlob(file, "preview");
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
	}, [file.id, kind, tooBig]);

	const download = async () => {
		try {
			const url = URL.createObjectURL(await fetchBlob(file, "download"));
			const a = document.createElement("a");
			a.href = url;
			a.download = file.name;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} catch (e) {
			onDownloadError(e instanceof Error ? e.message : String(e));
		}
	};

		return (
			<div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-3 sm:p-6">
				<button type="button" aria-label="Close preview" className="absolute inset-0 cursor-default" onClick={onClose}>
					<span className="sr-only">Close preview</span>
				</button>
				<div ref={panelRef} role="dialog" aria-modal="true" aria-label={`Preview of ${file.name}`} className="relative bg-panel border border-line rounded-xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden">
					<div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-line shrink-0">
						<div className="text-sm font-semibold truncate">{file.name}</div>
						<div className="flex items-center gap-1.5 shrink-0">
							<Button onClick={download} title="Download">
								<Download size={13} /> Download
							</Button>
							<Button size="icon" onClick={onClose} title="Close" aria-label="Close preview">
								<X size={14} />
							</Button>
						</div>
					</div>
				{/* biome-ignore lint/a11y/useSemanticElements: a <section> would not make this scroller focusable; the role + tabindex pair is the axe `scrollable-region-focusable` remedy. */}
				{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must take focus, or Safari has no keyboard route to the rest of a long preview (End/PageDown scroll the focused scroller). */}
				<div role="region" tabIndex={0} aria-label="Preview content" className="flex-1 min-h-0 overflow-auto bg-paper">
					{loading && <p className="text-center py-10 text-muted text-sm">Loading preview…</p>}
					{error && <p className="text-center py-10 text-danger text-sm">{error}</p>}
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
								<img src={blobUrl} alt={file.name} width={960} height={640} className="max-w-full max-h-full object-contain" />
						</div>
					)}
					{text !== null && kind === "markdown" && (
						<SafeHtmlView className="p-4 msg-md text-sm" html={renderMd(text)} />
					)}
					{text !== null && kind === "text" && (
						<pre className="p-4 text-xs whitespace-pre-wrap break-words">{text}</pre>
					)}
				</div>
			</div>
		</div>
	);
}
