import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { RunnerInputError } from "../errors.js";
import type { LocalArtifactResultEnvelope } from "./contract.js";
import { PORTABLE_DOCUMENT_BYTES, type LocalArtifactDocumentsResponse, type PortableDocument, type PortableDocumentRole } from "./document-contract.js";
import type { SourceText } from "./engine.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const filename = (role: PortableDocumentRole) => `${role.replace("_", "-")}.md`;
function document(role: PortableDocumentRole, bytes: Buffer): PortableDocument {
	if (!bytes.length || bytes.length > PORTABLE_DOCUMENT_BYTES) throw new RunnerInputError(`The ${role} document exceeds the portable document bounds.`, 409);
	return { role, name: filename(role), mimeType: "text/markdown", sha256: hash(bytes), bytes: bytes.length, contentBase64: bytes.toString("base64") };
}

/** Captured from the exact source blocks given to the CLI, never reread from mutable master files. */
export function snapshotAnswerSources(texts: SourceText[]): PortableDocument[] {
	return texts.filter((source) => source.role === "profile" || source.role === "answers").map((source) => document(source.role as "profile" | "answers", Buffer.from(source.text, "utf8")));
}

/** No caller-controlled path. Only completed artifacts the runtime already generated may leave. */
export function exportArtifactDocuments(input: {
	runId: string; instanceId: string; caller?: string; result?: LocalArtifactResultEnvelope;
	outDir?: string; sources?: PortableDocument[];
}): LocalArtifactDocumentsResponse {
	if (input.caller && input.caller !== input.instanceId) throw new RunnerInputError("This document run belongs to another instance.", 403);
	if (input.result?.outcome !== "completed" || !input.outDir || !input.sources?.some((source) => source.role === "profile")) throw new RunnerInputError("Documents are available only after this tailoring run completes.", 409);
	let documents: PortableDocument[];
	try {
		const root = realpathSync(input.outDir);
		documents = input.result.artifacts.map((artifact) => {
			const path = join(root, filename(artifact.kind));
			const info = lstatSync(path);
			if (!info.isFile() || realpathSync(path) !== path || !path.startsWith(root + sep)) throw new RunnerInputError("The generated document is no longer a regular file.", 409);
			if (info.size !== artifact.bytes || info.size > PORTABLE_DOCUMENT_BYTES) throw new RunnerInputError("The generated document changed or exceeds the portable bounds.", 409);
			const exported = document(artifact.kind, readFileSync(path));
			if (exported.sha256 !== artifact.sha256 || exported.bytes !== artifact.bytes) throw new RunnerInputError("The generated document changed; it cannot be stored as the approved material.", 409);
			return exported;
		});
	} catch (error) {
		if (error instanceof RunnerInputError) throw error;
		throw new RunnerInputError("A generated document could not be read; the approved materials cannot be stored.", 409);
	}
	return { runId: input.runId, instanceId: input.instanceId, documents: [...documents, ...input.sources.map((source) => ({ ...source }))] };
}
