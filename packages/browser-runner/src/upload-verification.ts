import { basename, extname } from "node:path";
import type { FileChooser, Page } from "playwright";

// Document MIME types used by approved application artifacts. Unknown types require an
// explicit extension match; never relabel bytes to satisfy a site's accept attribute.
const DOCUMENT_MIME: Record<string, string> = {
	".txt": "text/plain", ".md": "text/markdown", ".pdf": "application/pdf",
	".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".odt": "application/vnd.oasis.opendocument.text", ".rtf": "application/rtf",
};

export function acceptsUpload(path: string, accept: string): boolean {
	const tokens = accept.toLowerCase().split(",").map((part) => part.trim()).filter(Boolean);
	if (!tokens.length) return true;
	const extension = extname(path).toLowerCase();
	const mime = DOCUMENT_MIME[extension];
	return tokens.some((token) => token.startsWith(".") ? basename(path).toLowerCase().endsWith(token) : !!mime && (token === mime || (token.endsWith("/*") && mime.startsWith(token.slice(0, -1)))));
}

export interface PreparedUpload {
	error?: string;
	/** Selection is a browser fact, never proof of acceptance by the receiving website. */
	verify?(): Promise<{ error?: string }>;
}

/** Bind validation to the exact native chooser, including hidden inputs and iframe inputs. */
export class UploadVerifier {
	private readonly pending = new WeakMap<Page, FileChooser>();
	private readonly listeners = new Map<Page, { chooser: (chooser: FileChooser) => void; close: () => void }>();

	track(page: Page): void {
		if (this.listeners.has(page)) return;
		const chooser = (value: FileChooser) => this.pending.set(page, value);
		const close = () => { page.off("filechooser", chooser); this.listeners.delete(page); this.pending.delete(page); };
		this.listeners.set(page, { chooser, close });
		page.on("filechooser", chooser);
		page.once("close", close);
	}

	clear(page: Page): void { this.pending.delete(page); }
	stop(): void {
		for (const [page, listener] of this.listeners) {
			page.off("filechooser", listener.chooser);
			page.off("close", listener.close);
			this.pending.delete(page);
		}
		this.listeners.clear();
	}

	async prepare(page: Page | undefined, paths: string[]): Promise<PreparedUpload> {
		const chooser = page && this.pending.get(page);
		if (!page || !chooser) return { error: "No verified file chooser is open. Click the intended document upload control first." };
		try {
			const input = chooser.element();
			const accept = await input.getAttribute("accept") ?? "";
			const shownAccept = accept.length > 200 ? "accepted-types list omitted because it exceeds 200 characters; inspect the upload control" : accept;
			if (paths.length > 1 && !chooser.isMultiple()) return { error: "This upload field accepts only one file." };
			if (paths.some((path) => !acceptsUpload(path, accept))) return { error: `The approved document format does not match this upload field's accepted types (${shownAccept}). No file was attached. Request an approved artifact in a supported format; do not rename its extension.` };
			const inspect = () => input.evaluate((element) => {
				const el = element as HTMLInputElement;
				const ids = `${el.getAttribute("aria-describedby") ?? ""} ${el.getAttribute("aria-errormessage") ?? ""}`.trim().split(/\s+/);
				const alerts = ids.map((id) => el.ownerDocument.getElementById(id)).filter((node) => node?.getAttribute("role") === "alert" && node.getClientRects().length).map((node) => node?.textContent?.trim() ?? "").filter(Boolean);
				return { connected: el.isConnected, files: Array.from(el.files ?? [], (file) => file.name), invalid: el.getAttribute("aria-invalid") === "true" || !!el.validity?.customError, alerts };
			});
			const before = await inspect();
			return { verify: async () => {
				this.clear(page);
				try {
					const after = await inspect();
					if (after.invalid || after.alerts.some((alert) => !before.alerts.includes(alert))) return { error: "The upload field reported a validation error after file selection. Inspect the field's feedback before proceeding; website acceptance is unconfirmed." };
					const expected = paths.map((path) => basename(path)).sort();
					if (!after.connected || JSON.stringify(after.files.sort()) !== JSON.stringify(expected)) return { error: "The approved file selection could not be verified after upload: the field was cleared or changed. Inspect the page before retrying; website acceptance is unconfirmed." };
					return {};
				} catch {
					return { error: "The upload field is no longer available for verification. Inspect the page before retrying; website acceptance is unconfirmed." };
				}
			} };
		} catch {
			return { error: "The upload field could not be inspected. Reopen the intended document upload control before proceeding." };
		}
	}
}
