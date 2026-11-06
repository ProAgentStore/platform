import { cliAtLeast } from "../runner-upgrade.js";

/** First CLI that produces PDF upload artifacts from approved application documents (#1570). */
export const PDF_DOCUMENT_MIN_CLI = "0.4.228";

/** Independent of the cloud Tailor document transport: every new browser fill needs PDF support. */
export function pdfDocumentRunnerProblem(version: string | null | undefined): string | null {
	if (typeof version === "string" && /^v?\d+\.\d+\.\d+$/.test(version.trim()) && cliAtLeast(version, PDF_DOCUMENT_MIN_CLI)) return null;
	return `Application PDF uploads require CLI ${PDF_DOCUMENT_MIN_CLI} or newer; this runner reports ${version || "unknown"}. Update and restart the runner before retrying. No application browser action was dispatched; older runners may upload plain-text documents.`;
}
