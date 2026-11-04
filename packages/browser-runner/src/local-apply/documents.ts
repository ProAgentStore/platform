import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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

type ArtifactPath = (kind: LocalApplyArtifactKind) => { path: string; sha256: string } | { error: string };
export function prepareApplyDocuments(envelope: LocalApplyTaskEnvelope, dir: string, home: string, emit: (event: Omit<LocalApplyEvent, "at">) => void): { blocks: SourceBlock[]; artifactPath: ArtifactPath } {
	const blocks: SourceBlock[] = [];
	if (envelope.cloudDocuments) {
		const requestedFolder = join(dir, "documents");
		mkdirSync(requestedFolder, { mode: 0o700 });
		const folder = realpathSync(requestedFolder);
		const documents = new Map<PortableDocument["role"], { document: PortableDocument; path: string }>();
		for (const document of envelope.cloudDocuments) {
			// Markdown is UTF-8 text. Keep every byte, including markup, while using the
			// plain-text extension that text-compatible employer inputs can accept (#1473).
			const stagedName = `${document.role.replace("_", "-")}.txt`;
			const path = join(folder, stagedName);
			const bytes = Buffer.from(document.contentBase64, "base64");
			writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
			documents.set(document.role, { document, path });
			blocks.push({ label: document.role, text: bytes.toString("utf8") });
			if (document.role === "resume" || document.role === "cover_letter") emit({ type: "artifact.staged", detail: { kind: document.role, source: document.name, path: stagedName, sha256: document.sha256, bytes: document.bytes } });
			if (document.role === "profile" || document.role === "answers") emit({ type: "source.read", detail: { role: document.role, path: `cloud/${document.role}`, sha256: document.sha256, bytes: document.bytes } });
		}
		return { blocks, artifactPath: (kind) => {
			const selected = documents.get(kind);
			if (!selected) return { error: `No approved ${kind} for this application.` };
			try {
				if (!lstatSync(selected.path).isFile() || realpathSync(selected.path) !== selected.path) return { error: "The staged document is no longer a regular file." };
				const bytes = readFileSync(selected.path);
				if (bytes.length !== selected.document.bytes || hash(bytes) !== selected.document.sha256) return { error: "The staged document changed; it will not be uploaded." };
				return { path: selected.path, sha256: selected.document.sha256 };
			} catch { return { error: "The staged document could not be read." }; }
		} };
	}
	let workspace: string;
	try { workspace = resolveWorkspacePath(envelope.workspace, home); }
	catch (error) { throw new Blocked("source_unavailable", [`The workspace ${envelope.workspace} cannot be used: ${error instanceof Error ? error.message : String(error)}`]); }
	const missing: string[] = [];
	if (!envelope.sources.some((source) => source.role === "profile")) missing.push("No profile source is configured. Choose one in the Application Runner settings.");
	for (const source of envelope.sources) {
		const shown = `${envelope.workspace}/${source.path}`;
		try {
			const bytes = readFileSync(resolveSource(workspace, source.path));
			if (!bytes.length || bytes.length > PORTABLE_DOCUMENT_BYTES) throw new Error("empty or too large");
			blocks.push({ label: source.role, text: bytes.toString("utf8") });
			emit({ type: "source.read", detail: { role: source.role, path: shown, sha256: hash(bytes), bytes: bytes.length } });
		} catch { missing.push(`Your ${source.role} at ${shown} could not be read. Add it, or choose another file in the Application Runner settings.`); }
	}
	if (missing.length) throw new Blocked("source_unavailable", missing);
	for (const artifact of envelope.artifacts) {
		const verified = verifyArtifact(workspace, home, artifact);
		if ("error" in verified) throw new Blocked("artifact_changed", [`${verified.error} Re-run tailoring for this application.`]);
		blocks.push({ label: artifact.kind, text: verified.text });
	}
	return { blocks, artifactPath: (kind) => {
		const artifact = envelope.artifacts.find((item) => item.kind === kind);
		if (!artifact) return { error: `No approved ${kind.replace("_", " ")} for this application.` };
		const verified = verifyArtifact(workspace, home, artifact);
		return "error" in verified ? verified : { path: verified.path, sha256: artifact.sha256 };
	} };
}

/** Remove payloads before journaling; terminal hydration needs only identity and result metadata. */
export function clearCloudDocuments(envelope: LocalApplyTaskEnvelope, dir: string): void {
	if (!envelope.cloudDocuments) return;
	for (const document of envelope.cloudDocuments) document.contentBase64 = "";
	delete envelope.cloudDocuments;
	try { rmSync(join(dir, "documents"), { recursive: true, force: true }); } catch { /* Keep the execution receipt even if OS cleanup fails. */ }
}
