/**
 * Explicit uploaded-source selections for Application Tailor (#1004).
 *
 * A selection is an owner decision about one immutable Instance Files identity, not an inference
 * from a filename or a knowledge-search result. This module stores only handle-shaped provenance;
 * source bytes, R2 keys and extraction text stay in the Agent DO/R2 path.
 */
import type { Env } from "../../types.js";
import { LOCAL_ARTIFACT_CAPS, type LocalArtifactUploadedSource } from "./contract.js";

type DB = Pick<Env, "DB">;

export const UPLOADED_TAILOR_SOURCE_ROLES = ["resume", "profile"] as const;
export type UploadedTailorSourceRole = (typeof UPLOADED_TAILOR_SOURCE_ROLES)[number];

export interface UploadedTailorFileSnapshot {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	extractionStatus?: "none" | "extracted" | "unsupported" | "failed";
	extractedTextLength?: number;
	indexedTextLength?: number;
	textTruncated?: boolean;
	extractionError?: string;
	/** Immutable object/version evidence observed by the Files service at selection time. */
	fileVersion?: string;
	fileEtag?: string;
	originalSha256?: string;
	extractedTextSha256?: string;
	extractedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface UploadedTailorSourceSelection extends UploadedTailorFileSnapshot {
	role: UploadedTailorSourceRole;
	selectedAt: number;
}

interface Row {
	role: UploadedTailorSourceRole;
	file_id: string;
	file_name: string;
	mime_type: string;
	file_size: number;
	extraction_status: UploadedTailorFileSnapshot["extractionStatus"] | null;
	extracted_text_length: number | null;
	indexed_text_length: number | null;
	text_truncated: number;
	extraction_error: string | null;
	file_version: string | null;
	file_etag: string | null;
	original_sha256: string | null;
	extracted_text_sha256: string | null;
	extracted_at: string | null;
	file_created_at: string;
	file_updated_at: string;
	selected_at: number;
}

function present(row: Row): UploadedTailorSourceSelection {
	return {
		role: row.role,
		id: row.file_id,
		name: row.file_name,
		mimeType: row.mime_type,
		size: Number(row.file_size),
		...(row.extraction_status ? { extractionStatus: row.extraction_status } : {}),
		...(row.extracted_text_length === null ? {} : { extractedTextLength: Number(row.extracted_text_length) }),
		...(row.indexed_text_length === null ? {} : { indexedTextLength: Number(row.indexed_text_length) }),
		...(row.text_truncated ? { textTruncated: true } : {}),
		...(row.extraction_error ? { extractionError: row.extraction_error } : {}),
		...(row.file_version ? { fileVersion: row.file_version } : {}),
		...(row.file_etag ? { fileEtag: row.file_etag } : {}),
		...(row.original_sha256 ? { originalSha256: row.original_sha256 } : {}),
		...(row.extracted_text_sha256 ? { extractedTextSha256: row.extracted_text_sha256 } : {}),
		...(row.extracted_at ? { extractedAt: row.extracted_at } : {}),
		createdAt: row.file_created_at,
		updatedAt: row.file_updated_at,
		selectedAt: Number(row.selected_at),
	};
}

export function isUploadedTailorSourceRole(value: string): value is UploadedTailorSourceRole {
	return (UPLOADED_TAILOR_SOURCE_ROLES as readonly string[]).includes(value);
}

export async function listUploadedTailorSourceSelections(env: DB, instanceId: string, userId: string): Promise<UploadedTailorSourceSelection[]> {
	const { results } = await env.DB.prepare(
		`SELECT role, file_id, file_name, mime_type, file_size, extraction_status,
		        extracted_text_length, indexed_text_length, text_truncated, extraction_error,
		        file_version, file_etag, original_sha256, extracted_text_sha256, extracted_at,
		        file_created_at, file_updated_at, selected_at
		   FROM application_tailor_uploaded_sources
		  WHERE instance_id = ?1 AND user_id = ?2
		  ORDER BY CASE role WHEN 'resume' THEN 0 ELSE 1 END`,
	).bind(instanceId, userId).all<Row>();
	return (results ?? []).map(present);
}

/** Replace exactly one role's selection with the File metadata observed through the owning DO. */
export async function selectUploadedTailorSource(
	env: DB,
	input: { instanceId: string; userId: string; role: UploadedTailorSourceRole; file: UploadedTailorFileSnapshot; now: number },
): Promise<UploadedTailorSourceSelection> {
	const { instanceId, userId, role, file, now } = input;
	await env.DB.prepare(
		`INSERT INTO application_tailor_uploaded_sources (
		    instance_id, user_id, role, file_id, file_name, mime_type, file_size,
		    extraction_status, extracted_text_length, indexed_text_length, text_truncated,
		    extraction_error, file_version, file_etag, original_sha256, extracted_text_sha256, extracted_at,
		    file_created_at, file_updated_at, selected_at
		 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
		 ON CONFLICT(instance_id, user_id, role) DO UPDATE SET
		    file_id = excluded.file_id, file_name = excluded.file_name, mime_type = excluded.mime_type,
		    file_size = excluded.file_size, extraction_status = excluded.extraction_status,
		    extracted_text_length = excluded.extracted_text_length, indexed_text_length = excluded.indexed_text_length,
		    text_truncated = excluded.text_truncated, extraction_error = excluded.extraction_error,
		    file_version = excluded.file_version, file_etag = excluded.file_etag,
		    original_sha256 = excluded.original_sha256, extracted_text_sha256 = excluded.extracted_text_sha256,
		    extracted_at = excluded.extracted_at,
		    file_created_at = excluded.file_created_at, file_updated_at = excluded.file_updated_at,
		    selected_at = excluded.selected_at`,
	)
		.bind(
			instanceId, userId, role, file.id, file.name, file.mimeType, file.size,
			file.extractionStatus ?? null, file.extractedTextLength ?? null, file.indexedTextLength ?? null,
			file.textTruncated ? 1 : 0, file.extractionError ?? null,
			file.fileVersion ?? null, file.fileEtag ?? null, file.originalSha256 ?? null,
			file.extractedTextSha256 ?? null, file.extractedAt ?? null,
			file.createdAt, file.updatedAt, now,
		)
		.run();
	return { role, ...file, selectedAt: now };
}

export async function clearUploadedTailorSource(env: DB, instanceId: string, userId: string, role: UploadedTailorSourceRole): Promise<boolean> {
	const result = await env.DB.prepare(
		"DELETE FROM application_tailor_uploaded_sources WHERE instance_id = ?1 AND user_id = ?2 AND role = ?3",
	).bind(instanceId, userId, role).run();
	return (result.meta?.changes ?? 0) > 0;
}

/** Fetch the exact R2-backed extraction through the owning DO, never the capped search index. */
export async function materializeUploadedTailorSources(
	env: Pick<Env, "DB" | "AGENT">,
	instanceId: string,
	userId: string,
	expected?: ReadonlyArray<Omit<LocalArtifactUploadedSource, "text">>,
): Promise<LocalArtifactUploadedSource[]> {
	if (!env.AGENT) throw new Error("Instance Files are unavailable");
	const selected = await listUploadedTailorSourceSelections(env, instanceId, userId);
	if (selected.length !== 2 || !selected.some((source) => source.role === "resume") || !selected.some((source) => source.role === "profile")) {
		throw new Error("Select one readable uploaded resume and one readable uploaded profile before tailoring.");
	}
	if (expected?.some((wanted) => {
		const current = selected.find((source) => source.role === wanted.role);
		return !current || current.id !== wanted.fileId || current.fileVersion !== wanted.version || current.originalSha256 !== wanted.originalSha256 || current.extractedTextSha256 !== wanted.extractedTextSha256 || current.extractedAt !== wanted.extractedAt;
	})) throw new Error("Uploaded source selection changed while this run waited; reselect and start again.");
	const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
	const sources: LocalArtifactUploadedSource[] = [];
	for (const choice of selected) {
		const response = await stub.fetch(new Request(`https://agent/files/${encodeURIComponent(choice.id)}/tailor-source`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }),
		}));
		const value = await response.json().catch(() => null) as { error?: unknown; text?: unknown; source?: Record<string, unknown> } | null;
		if (!response.ok || !value || typeof value.text !== "string" || !value.source) throw new Error(typeof value?.error === "string" ? value.error : `The selected uploaded ${choice.role} could not be read.`);
		const source = value.source;
		if (source.id !== choice.id || source.name !== choice.name || source.r2Version !== choice.fileVersion || source.r2Etag !== choice.fileEtag || source.originalSha256 !== choice.originalSha256 || source.extractedTextSha256 !== choice.extractedTextSha256 || source.extractedAt !== choice.extractedAt) throw new Error(`The selected uploaded ${choice.role} changed; reselect its exact version before tailoring.`);
		const bytes = new TextEncoder().encode(value.text).byteLength;
		if (!bytes || bytes > LOCAL_ARTIFACT_CAPS.sourceBytes) throw new Error(`The selected uploaded ${choice.role} has ${bytes} extracted UTF-8 bytes; the secure runner transfer limit is ${LOCAL_ARTIFACT_CAPS.sourceBytes} bytes.`);
		if (!choice.fileVersion || !choice.originalSha256 || !choice.extractedTextSha256 || !choice.extractedAt) throw new Error(`The selected uploaded ${choice.role} has incomplete provenance; re-upload and reselect it.`);
		sources.push({ role: choice.role, fileId: choice.id, version: choice.fileVersion, originalSha256: choice.originalSha256, extractedTextSha256: choice.extractedTextSha256, extractedAt: choice.extractedAt, text: value.text });
	}
	return sources;
}
