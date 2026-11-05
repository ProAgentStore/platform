import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type { FileChooser, Page } from "playwright";
import { observeUploadSelection } from "./upload-selection-observation.js";

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
	chooserId?: string;
	dispose?(): Promise<void>;
	markUncertain?(): void;
	/** Selection is a browser fact, never proof of acceptance by the receiving website. */
	verify?(options?: { uncertain?: boolean }): Promise<{ error?: string; selection?: UploadSelectionReceipt }>;
}

/** Bound independent observations/cleanup too; a deadline does not cancel their underlying work. */
async function boundedObservation<T>(operation: Promise<T>, timeoutMs = 2_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native upload observation deadline")), timeoutMs); })]); }
	finally { if (timer) clearTimeout(timer); }
}

/** No website text is interpreted here, and no receipt attests receiving-site acceptance. */
export interface UploadSelectionReceipt {
	status: "selected";
	evidence: "input_event" | "retained_files";
	inputConnected: boolean;
	inputRetainsSelection: boolean;
	ariaInvalid: boolean;
	nativeValid: boolean;
	customError: boolean;
	/** Untrusted native validation text, bounded to 2,000 characters. */
	validationMessage: string;
	websiteAcceptance: "unconfirmed";
}

/** Bind validation to the exact native chooser, including hidden inputs and iframe inputs. */
export class UploadVerifier {
	private readonly pending = new WeakMap<Page, FileChooser>();
	private readonly identities = new WeakMap<FileChooser, string>();
	private readonly uncertain = new WeakMap<Page, FileChooser>();
	private readonly listeners = new Map<Page, { chooser: (chooser: FileChooser) => void; close: () => void }>();

	track(page: Page): void {
		if (this.listeners.has(page)) return;
		const chooser = (value: FileChooser) => { this.identities.set(value, randomUUID()); this.pending.set(page, value); };
		const close = () => { page.off("filechooser", chooser); this.listeners.delete(page); this.pending.delete(page); this.uncertain.delete(page); };
		this.listeners.set(page, { chooser, close });
		page.on("filechooser", chooser);
		page.once("close", close);
	}

	/** Opaque identity from a real native event, scoped to this exact live page. */
	pendingId(page: Page | undefined): string | null {
		const chooser = page && !page.isClosed() ? this.pending.get(page) : undefined;
		return chooser ? this.identities.get(chooser) ?? null : null;
	}
	chooserId(chooser: FileChooser): string | null { return this.identities.get(chooser) ?? null; }

	clear(page: Page): void { this.pending.delete(page); }
	stop(): void {
		for (const [page, listener] of this.listeners) {
			page.off("filechooser", listener.chooser);
			page.off("close", listener.close);
			this.pending.delete(page);
			this.uncertain.delete(page);
		}
		this.listeners.clear();
	}

	async prepare(page: Page | undefined, paths: string[]): Promise<PreparedUpload> {
		if (page && this.uncertain.has(page)) return { error: "The previous native upload has an unknown selection outcome. No repeated upload was dispatched. Recover its original response and inspect the current page; a new chooser does not resolve that uncertainty." };
		const chooser = page && this.pending.get(page);
		if (!page || !chooser) return { error: "No verified file chooser is open. Click the intended document upload control first." };
		try {
			const input = chooser.element();
			const accept = await input.getAttribute("accept") ?? "";
			const shownAccept = accept.length > 200 ? "accepted-types list omitted because it exceeds 200 characters; inspect the upload control" : accept;
			if (paths.length > 1 && !chooser.isMultiple()) return { error: "This upload field accepts only one file." };
			if (paths.some((path) => !acceptsUpload(path, accept))) return { error: `The approved document format does not match this upload field's accepted types (${shownAccept}). No file was attached. Request an approved artifact in a supported format; do not rename its extension.` };
			const expected = paths.map((path) => basename(path)).sort();
			const observation = await observeUploadSelection(input, expected);
			let disposed: Promise<void> | undefined;
			const dispose = () => disposed ??= boundedObservation(observation.dispose()).catch(() => undefined);
			return { chooserId: this.chooserId(chooser) ?? undefined, dispose,
				markUncertain: () => { this.uncertain.set(page, chooser); if (this.pending.get(page) === chooser) this.clear(page); },
				verify: async () => {
				if (this.pending.get(page) === chooser) this.clear(page);
				try {
					const after = await boundedObservation(observation.read());
					const retained = after.connected && JSON.stringify(after.files.sort()) === JSON.stringify(expected);
					if (!retained && !after.selected) return { error: "The approved file selection could not be observed in the intended input. The action may have run; inspect the page before deciding whether to retry. Website acceptance is unconfirmed." };
					if (this.uncertain.get(page) === chooser) this.uncertain.delete(page);
					return { selection: { status: "selected", evidence: after.selected ? "input_event" : "retained_files", inputConnected: after.connected, inputRetainsSelection: retained, ariaInvalid: after.ariaInvalid, nativeValid: after.nativeValid, customError: after.customError, validationMessage: after.validationMessage, websiteAcceptance: "unconfirmed" } };
				} catch {
					return { error: "The upload field is no longer available for verification. Inspect the page before retrying; website acceptance is unconfirmed." };
				} finally { await dispose(); }
			} };
		} catch {
			return { error: "The upload field could not be inspected. Reopen the intended document upload control before proceeding." };
		}
	}
}
