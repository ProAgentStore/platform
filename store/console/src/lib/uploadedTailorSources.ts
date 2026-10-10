/**
 * The owner-visible contract for Application Tailor's uploaded source choice.
 *
 * These helpers deliberately carry file handles and extraction provenance only.  A Console page
 * must never fetch or render the résumé text itself; the Worker is the authorization boundary.
 */

export type UploadedTailorSourceRole = "resume" | "profile";

export interface UploadedTailorFile {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
}

export interface UploadedTailorSource {
	role: UploadedTailorSourceRole;
	id: string;
	name: string;
	mimeType: string;
	size: number;
	extractionStatus?: "none" | "extracted" | "unsupported" | "failed";
	fileVersion?: string;
	originalSha256?: string;
	extractedTextSha256?: string;
	extractedAt?: string;
}

export interface UploadedTailorReadinessSource {
	role: UploadedTailorSourceRole;
	selected: UploadedTailorSource | null;
	uploaded: boolean;
	extracted: boolean;
	availableToRunner: boolean;
	ready: boolean;
	isStale: boolean;
	provenance: {
		filename: string;
		fileId: string;
		version: string | null;
		originalHash: string | null;
		extractedHash: string | null;
		extractedAt: string | null;
	} | null;
	blockers: string[];
}

export interface UploadedTailorReadiness {
	mode: "uploaded";
	sources: UploadedTailorReadinessSource[];
	runner: { available: boolean };
	ready: boolean;
	blockers: string[];
}

export type ApiRequest = <T>(path: string, opts?: RequestInit) => Promise<T>;

const base = (instanceId: string) => `/v1/instances/${encodeURIComponent(instanceId)}/application-tailor/uploaded-sources`;

/** Request builders are kept here so the component and its behavioural tests share one contract. */
export const uploadedTailorSourcesApi = {
	listFiles: (request: ApiRequest, instanceId: string) => request<{ files: UploadedTailorFile[] }>(`/v1/instances/${encodeURIComponent(instanceId)}/files`),
	listSelections: (request: ApiRequest, instanceId: string) => request<{ sources: UploadedTailorSource[] }>(base(instanceId)),
	readiness: (request: ApiRequest, instanceId: string) => request<UploadedTailorReadiness>(`${base(instanceId)}/readiness`),
	select: (request: ApiRequest, instanceId: string, role: UploadedTailorSourceRole, fileId: string) =>
		request<{ source: UploadedTailorSource }>(`${base(instanceId)}/${role}`, { method: "PUT", body: JSON.stringify({ fileId }) }),
	clear: (request: ApiRequest, instanceId: string, role: UploadedTailorSourceRole) =>
		request<{ cleared: boolean }>(`${base(instanceId)}/${role}`, { method: "DELETE" }),
};

/** The UI statement must be based on the server's readiness, never inferred from a selected name. */
export function uploadedTailorReadinessMessage(readiness: UploadedTailorReadiness): string {
	if (readiness.ready) return "Uploaded sources are ready for the runner.";
	if (readiness.sources.some((source) => source.isStale)) return "A selected uploaded source changed or was deleted. Select the exact current file again.";
	if (readiness.blockers.includes("runner_unavailable")) return "Your runner is offline. Reconnect it before uploaded sources can be used.";
	if (readiness.sources.some((source) => source.blockers.includes("materialization_unsupported"))) return "Uploaded sources are selected but are not yet transferable to the runner. Tailoring will fail closed and will not use local or historical files.";
	return "Uploaded sources are not ready. Resolve the listed blockers before tailoring.";
}

export const shortHash = (hash: string | null | undefined) => hash ? `${hash.slice(0, 12)}…` : "unavailable";
