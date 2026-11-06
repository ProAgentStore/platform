import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { PDF_RENDERER_REVISION, renderDocumentPdf, renderWithSignal, type DocumentPdfRenderer } from "./document-pdf.js";
import { RunnerInputError } from "../errors.js";
import { PORTABLE_DOCUMENT_BYTES, type PortableDocument } from "../local-artifact/document-contract.js";
import { resolveSource } from "../local-artifact/runtime.js";
import { resolveWorkspacePath } from "../local-browser/runtime.js";
import type { LocalApplyArtifact, LocalApplyArtifactKind, LocalApplyBlockReason, LocalApplyEvent, LocalApplyTaskEnvelope } from "./contract.js";
import type { SourceBlock } from "./engine.js";

export class Blocked extends Error {
	constructor(readonly reason: LocalApplyBlockReason, readonly questions: string[]) { super(reason); }
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ROLES = ["resume", "cover_letter", "profile", "answers"] as const;

/** Validate before any browser/CLI starts; partial cloud bundles never fall back to local files. */
export function parseCloudDocuments(raw: unknown, artifacts: LocalApplyArtifact[]): PortableDocument[] | undefined {
	if (raw === undefined) return undefined;
	const bad = () => new RunnerInputError("Invalid application cloud documents: a complete, bounded, hash-verified document set is required.");
	if (!Array.isArray(raw) || raw.length < 3 || raw.length > 4) throw bad();
	const documents: PortableDocument[] = [];
	for (const entry of raw) {
		const d = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
		if (!ROLES.includes(d.role as never) || documents.some((document) => document.role === d.role)) throw bad();
		if (typeof d.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(d.name) || (d.mimeType !== "text/markdown" && d.mimeType !== "text/plain")) throw bad();
		if (typeof d.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(d.sha256) || !Number.isInteger(d.bytes) || (d.bytes as number) < 1 || (d.bytes as number) > PORTABLE_DOCUMENT_BYTES) throw bad();
		if (typeof d.contentBase64 !== "string" || d.contentBase64.length > 4 * Math.ceil(PORTABLE_DOCUMENT_BYTES / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(d.contentBase64)) throw bad();
		const bytes = Buffer.from(d.contentBase64, "base64");
		if (bytes.length !== d.bytes || hash(bytes) !== d.sha256 || bytes.toString("base64") !== d.contentBase64) throw bad();
		try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw bad(); }
		if (d.role === "resume" || d.role === "cover_letter") {
			const approved = artifacts.find((artifact) => artifact.kind === d.role);
			if (!approved || approved.sha256 !== d.sha256) throw bad();
		}
		documents.push({ role: d.role as PortableDocument["role"], name: d.name, mimeType: d.mimeType, sha256: d.sha256, bytes: d.bytes as number, contentBase64: d.contentBase64 });
	}
	if (!["resume", "cover_letter", "profile"].every((role) => documents.some((document) => document.role === role))) throw bad();
	return documents;
}

/** Existing local mode: only the previously approved file inside applications/ may be attached. */
export function verifyArtifact(workspace: string, home: string, artifact: LocalApplyArtifact): { path: string; text: string } | { error: string } {
	const label = artifact.kind.replace("_", " ");
	try {
		const real = realpathSync(resolve(realpathSync(home), artifact.path.slice(2)));
		if (!real.startsWith(join(workspace, "applications") + sep)) return { error: `The approved ${label} is not inside the workspace's applications/ folder.` };
		const bytes = readFileSync(real);
		if (hash(bytes) !== artifact.sha256) return { error: `The approved ${label} at ${artifact.path} has changed since it was generated; it will not be uploaded.` };
		return { path: real, text: bytes.toString("utf8") };
	} catch { return { error: `The approved ${label} at ${artifact.path} could not be read.` }; }
}

export interface PreparedUpload {
	path: string;
	/** Actual bytes selected by the file chooser. Never the Markdown source hash. */
	sha256: string;
	sourceSha256?: string;
	rendererRevision?: string;
	mimeType?: "application/pdf";
	bytes?: number;
}
type ArtifactPath = (kind: LocalApplyArtifactKind) => PreparedUpload | { error: string };
export async function prepareApplyDocuments(envelope: LocalApplyTaskEnvelope, dir: string, home: string, emit: (event: Omit<LocalApplyEvent, "at">) => void, renderPdf: DocumentPdfRenderer = renderDocumentPdf, signal?: AbortSignal): Promise<{ blocks: SourceBlock[]; artifactPath: ArtifactPath }> {
	const blocks: SourceBlock[] = [];
	const entries = new Map<LocalApplyArtifactKind, { name: string; text: string; sourceSha256: string; markdown: boolean; verify: () => boolean }>();
	const requestedFolder = join(dir, "documents");
	mkdirSync(requestedFolder, { mode: 0o700 });
	const folder = realpathSync(requestedFolder);
	try {
	if (envelope.cloudDocuments) {
		for (const document of envelope.cloudDocuments) {
			const sourcePath = join(folder, `${document.role}.source.${document.mimeType === "text/markdown" ? "md" : "txt"}`);
			const bytes = Buffer.from(document.contentBase64, "base64");
			if (bytes.length !== document.bytes || hash(bytes) !== document.sha256) throw new Blocked("artifact_changed", ["An approved cloud source changed before PDF rendering. Re-run tailoring."]);
			writeFileSync(sourcePath, bytes, { flag: "wx", mode: 0o600 });
			const text = bytes.toString("utf8");
			blocks.push({ label: document.role, text });
			if (document.role === "resume" || document.role === "cover_letter") {
				if (envelope.artifacts.find((artifact) => artifact.kind === document.role)?.sha256 !== document.sha256) throw new Blocked("artifact_changed", ["A cloud source does not match the approved application artifact."]);
				entries.set(document.role, { name: document.name, text, sourceSha256: document.sha256, markdown: document.mimeType === "text/markdown", verify: () => {
					try { return lstatSync(sourcePath).isFile() && realpathSync(sourcePath) === sourcePath && hash(readFileSync(sourcePath)) === document.sha256; } catch { return false; }
				} });
			} else emit({ type: "source.read", detail: { role: document.role, path: `cloud/${document.role}`, sha256: document.sha256, bytes: document.bytes } });
		}
	} else {
		let workspace: string;
		try { workspace = resolveWorkspacePath(envelope.workspace, home); }
		catch (error) { throw new Blocked("source_unavailable", [`The workspace ${envelope.workspace} cannot be used: ${error instanceof Error ? error.message : String(error)}`]); }
		const missing: string[] = [];
		if (!envelope.sources.some((source) => source.role === "profile")) missing.push("No profile source is configured. Choose one in the Application Runner settings.");
		for (const source of envelope.sources) {
			try {
				const bytes = readFileSync(resolveSource(workspace, source.path));
				if (!bytes.length || bytes.length > PORTABLE_DOCUMENT_BYTES) throw new Error("empty or too large");
				blocks.push({ label: source.role, text: bytes.toString("utf8") });
				emit({ type: "source.read", detail: { role: source.role, path: `${envelope.workspace}/${source.path}`, sha256: hash(bytes), bytes: bytes.length } });
			} catch { missing.push(`Your ${source.role} source could not be read. Add it, or choose another file in the Application Runner settings.`); }
		}
		if (missing.length) throw new Blocked("source_unavailable", missing);
		for (const artifact of envelope.artifacts) {
			const verified = verifyArtifact(workspace, home, artifact);
			if ("error" in verified) throw new Blocked("artifact_changed", [`${verified.error} Re-run tailoring for this application.`]);
			if (![".md", ".markdown", ".txt"].includes(extname(verified.path).toLowerCase())) throw new Blocked("source_unavailable", ["This approved local artifact format cannot be used as a grounded PDF source. Existing PDF/binary artifacts need explicit text provenance; no text-file upload or binary-as-text fallback was used."]);
			const bytes = readFileSync(verified.path);
			if (hash(bytes) !== artifact.sha256) throw new Blocked("artifact_changed", ["The approved local source changed before rendering."]);
			let text: string;
			try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Blocked("source_unavailable", ["The approved local document is not valid UTF-8 text. No attachment was prepared."]); }
			if (!bytes.length || bytes.length > PORTABLE_DOCUMENT_BYTES) throw new Blocked("source_unavailable", ["The approved local text document is empty or too large to render safely."]);
			blocks.push({ label: artifact.kind, text });
			entries.set(artifact.kind, { name: `${artifact.kind}${extname(verified.path)}`, text, sourceSha256: artifact.sha256, markdown: extname(verified.path).toLowerCase() !== ".txt", verify: () => !("error" in verifyArtifact(workspace, home, artifact)) });
		}
	}
	const uploads = new Map<LocalApplyArtifactKind, PreparedUpload>();
	for (const [kind, source] of entries) {
		if (!source.verify()) throw new Blocked("artifact_changed", ["The approved source changed before PDF rendering."]);
		let bytes: Buffer;
		try {
			bytes = await renderWithSignal(renderPdf, source.text, source.markdown, signal, Math.min((envelope.policy.browserCommandTimeoutSeconds ?? 600) * 1000, envelope.limits.maxMinutes * 60000));
			if (!Buffer.isBuffer(bytes) || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || !bytes.includes(Buffer.from("%%EOF"))) throw new Error("No complete PDF was produced");
		} catch (error) { if (signal?.aborted || error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Blocked("source_unavailable", ["PDF preparation stopped or reached this run’s time limit. No employer-browser action or text-file fallback occurred."]); throw new Blocked("source_unavailable", ["The approved document could not be rendered into a real PDF. Ensure Chromium or Chrome is installed and retry; no TXT or Markdown attachment fallback was used."]); }
		if (!source.verify()) throw new Blocked("artifact_changed", ["The approved source changed during PDF rendering."]);
		const name = `${kind.replace("_", "-")}.pdf`, path = join(folder, name);
		writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
		const upload: PreparedUpload = { path, sha256: hash(bytes), sourceSha256: source.sourceSha256, rendererRevision: PDF_RENDERER_REVISION, mimeType: "application/pdf", bytes: bytes.length };
		uploads.set(kind, upload);
		emit({ type: "artifact.staged", detail: { kind, source: source.name, path: name, sha256: upload.sha256, sourceSha256: source.sourceSha256, rendererRevision: PDF_RENDERER_REVISION, mimeType: "application/pdf", bytes: bytes.length } });
	}
	return { blocks, artifactPath: (kind) => {
		const upload = uploads.get(kind), source = entries.get(kind);
		if (!upload || !source) return { error: `No approved ${kind} PDF for this application.` };
		try {
			if (!source.verify() || !lstatSync(upload.path).isFile() || realpathSync(upload.path) !== upload.path || hash(readFileSync(upload.path)) !== upload.sha256) return { error: "The approved source or rendered PDF changed; it will not be uploaded." };
			return { ...upload };
		} catch { return { error: "The approved source or rendered PDF could not be read." }; }
	} };
	} catch (error) {
		try { rmSync(folder, { recursive: true, force: true }); } catch { /* Fail closed even if OS cleanup is unavailable. */ }
		throw error;
	}
}

/** Remove payloads before journaling; terminal hydration needs only identity and result metadata. */
export function clearCloudDocuments(envelope: LocalApplyTaskEnvelope, dir: string): void {
	if (envelope.policy.toolAccess === "full") { try { rmSync(join(dir, "native-documents"), { recursive: true, force: true }); } catch { /* Preserve the terminal receipt even if cleanup fails. */ } }
	for (const document of envelope.cloudDocuments ?? []) document.contentBase64 = "";
	delete envelope.cloudDocuments;
	try { rmSync(join(dir, "documents"), { recursive: true, force: true }); } catch { /* Keep the execution receipt even if OS cleanup fails. */ }
}
