/** Private document transport over the authenticated runner relay (#1468).
 * Mirror: workers/api/src/lib/local-artifact/document-contract.ts.
 * Bytes belong in Files storage; never in a run result, event or terminal journal.
 */
export const LOCAL_ARTIFACT_DOCUMENTS_PATH = "/local-artifact/documents";
export const PORTABLE_DOCUMENTS_MIN_CLI = "0.4.205";
export const PORTABLE_DOCUMENT_BYTES = 256 * 1024;
export type PortableDocumentRole = "resume" | "cover_letter" | "profile" | "answers";
export interface PortableDocument {
	role: PortableDocumentRole;
	name: string;
	mimeType: "text/markdown" | "text/plain";
	sha256: string;
	bytes: number;
	contentBase64: string;
}
export interface LocalArtifactDocumentsResponse {
	runId: string;
	instanceId: string;
	documents: PortableDocument[];
}
