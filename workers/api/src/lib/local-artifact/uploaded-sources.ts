/**
 * Explicit uploaded-source selections for Application Tailor (#1004).
 *
 * A selection is an owner decision about one immutable Instance Files identity, not an inference
 * from a filename or a knowledge-search result. This module stores only handle-shaped provenance;
 * source bytes, R2 keys and extraction text stay in the Agent DO/R2 path.
 */
import type { Env } from "../../types.js";

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
		    extraction_error, file_created_at, file_updated_at, selected_at
		 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
		 ON CONFLICT(instance_id, user_id, role) DO UPDATE SET
		    file_id = excluded.file_id, file_name = excluded.file_name, mime_type = excluded.mime_type,
		    file_size = excluded.file_size, extraction_status = excluded.extraction_status,
		    extracted_text_length = excluded.extracted_text_length, indexed_text_length = excluded.indexed_text_length,
		    text_truncated = excluded.text_truncated, extraction_error = excluded.extraction_error,
		    file_created_at = excluded.file_created_at, file_updated_at = excluded.file_updated_at,
		    selected_at = excluded.selected_at`,
	)
		.bind(
			instanceId, userId, role, file.id, file.name, file.mimeType, file.size,
			file.extractionStatus ?? null, file.extractedTextLength ?? null, file.indexedTextLength ?? null,
			file.textTruncated ? 1 : 0, file.extractionError ?? null, file.createdAt, file.updatedAt, now,
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
