/** Application document receipts backed by the existing private instance Files store (#1468).
 * D1 holds identities only. Bytes cross the authenticated relay and DO binding, never run logs.
 */
import type { Env } from "../../types.js";
import { sha256Hex } from "../../agent-storage-utils.js";
import { callRuntime, runtimeJson, type RuntimeRow } from "../../routes/instances-runtime.js";
import { HttpError } from "../auth.js";
import { cliAtLeast } from "../runner-upgrade.js";
import type { CloudArtifactReference, LocalArtifactResultEnvelope } from "./contract.js";
import { LOCAL_ARTIFACT_DOCUMENTS_PATH, PORTABLE_DOCUMENT_BYTES, PORTABLE_DOCUMENTS_MIN_CLI, type PortableDocument, type PortableDocumentRole } from "./document-contract.js";
import type { JobApplication, TailorRun } from "./store.js";

type Scope = { userId: string; instanceId: string; applicationId: string; runId: string };
interface DocumentRow { role: PortableDocumentRole; file_id: string; name: string; mime_type: PortableDocument["mimeType"]; version: string; sha256: string; bytes: number }
export class InvalidCloudDocuments extends Error {}
const ROLES: readonly PortableDocumentRole[] = ["resume", "cover_letter", "profile", "answers"];

export function cloudDocumentsRunnerProblem(version: string | null | undefined, node?: string | null): string | null {
	return cliAtLeast(version, PORTABLE_DOCUMENTS_MIN_CLI) ? null : `The runner on ${node || "this machine"} needs CLI ${PORTABLE_DOCUMENTS_MIN_CLI} or newer to store and use application documents in PAGS. Update the runner and retry; local files will not be substituted.`;
}
async function rowsFor(env: Pick<Env, "DB">, scope: Scope): Promise<DocumentRow[]> {
	const { results } = await env.DB.prepare("SELECT role, file_id, name, mime_type, version, sha256, bytes FROM application_documents WHERE user_id = ?1 AND instance_id = ?2 AND application_id = ?3 AND tailoring_run_id = ?4 ORDER BY role")
		.bind(scope.userId, scope.instanceId, scope.applicationId, scope.runId).all<DocumentRow>();
	return results ?? [];
}
function reference(instanceId: string, row: DocumentRow): CloudArtifactReference {
	return { instanceId, fileId: row.file_id, name: row.name, version: row.version, sha256: row.sha256, bytes: row.bytes };
}
async function validatedDocuments(raw: unknown): Promise<PortableDocument[]> {
	if (!Array.isArray(raw) || raw.length < 3 || raw.length > 4) throw new InvalidCloudDocuments("The prepared document set is incomplete.");
	const out: PortableDocument[] = [];
	for (const value of raw) {
		const d = value as PortableDocument;
		if (!d || !ROLES.includes(d.role) || out.some((p) => p.role === d.role) || !/^[A-Za-z0-9_.-]{1,100}$/.test(d.name) || !["text/markdown", "text/plain"].includes(d.mimeType) || !/^[a-f0-9]{64}$/.test(d.sha256) || !Number.isInteger(d.bytes) || d.bytes < 1 || d.bytes > PORTABLE_DOCUMENT_BYTES || typeof d.contentBase64 !== "string" || d.contentBase64.length > Math.ceil(PORTABLE_DOCUMENT_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(d.contentBase64)) throw new InvalidCloudDocuments("The prepared document transport is invalid.");
		const bytes = Uint8Array.from(atob(d.contentBase64), (c) => c.charCodeAt(0));
		if (bytes.length !== d.bytes || await sha256Hex(bytes.buffer) !== d.sha256) throw new InvalidCloudDocuments("The prepared document hash does not match its bytes.");
		out.push({ role: d.role, name: d.name, mimeType: d.mimeType, sha256: d.sha256, bytes: d.bytes, contentBase64: d.contentBase64 });
	}
	if (!["resume", "cover_letter", "profile"].every((r) => out.some((d) => d.role === r))) throw new InvalidCloudDocuments("The prepared document set is incomplete.");
	return out;
}

/** Retryable before terminal settlement. Each role has one immutable receipt even across polling. */
export async function persistCloudDocuments(env: Env, runtime: RuntimeRow, userId: string, run: TailorRun, result: LocalArtifactResultEnvelope, now: number): Promise<void> {
	const token = crypto.randomUUID();
	const claim = await env.DB.prepare("INSERT INTO application_document_leases (tailoring_run_id, token, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(tailoring_run_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at WHERE application_document_leases.expires_at <= ?4 RETURNING token")
		.bind(run.id, token, now + 5 * 60_000, now).first<{ token: string }>();
	if (claim?.token !== token) throw new Error("Prepared documents are being stored by another poll.");
	try { await persistClaimedDocuments(env, runtime, userId, run, result, now); }
	finally { await env.DB.prepare("DELETE FROM application_document_leases WHERE tailoring_run_id = ?1 AND token = ?2").bind(run.id, token).run(); }
}
async function persistClaimedDocuments(env: Env, runtime: RuntimeRow, userId: string, run: TailorRun, result: LocalArtifactResultEnvelope, now: number): Promise<void> {
	const scope = { userId, instanceId: run.instanceId, applicationId: run.applicationId, runId: run.id };
	const rows = await rowsFor(env, scope);
	const expected = [...result.artifacts.map((a) => ({ role: a.kind, sha256: a.sha256, bytes: a.bytes })), ...result.sourceHashes.filter((s) => s.role === "profile" || s.role === "answers")];
	// Recover a crash after the final receipt but before the run/application CAS, even if the
	// export endpoint is temporarily unavailable. A complete verified Files set is authoritative.
	if (rows.length === expected.length && rows.length >= 3 && expected.some((d) => d.role === "profile") && expected.every((d) => rows.some((r) => r.role === d.role && r.sha256 === d.sha256 && r.bytes === d.bytes))) {
		for (const artifact of result.artifacts) artifact.cloud = reference(run.instanceId, rows.find((r) => r.role === artifact.kind)!);
		try { await loadCloudDocuments(env, userId, { id: run.applicationId, instanceId: run.instanceId, tailoringRunId: run.id, resumeArtifact: result.artifacts.find((a) => a.kind === "resume"), coverLetterArtifact: result.artifacts.find((a) => a.kind === "cover_letter") } as JobApplication, PORTABLE_DOCUMENTS_MIN_CLI); }
		catch (error) {
			if (error instanceof HttpError && error.status === 409) throw new InvalidCloudDocuments("The stored prepared document set is missing or changed.");
			throw error;
		}
		return;
	}
	const response = await callRuntime(env, runtime, LOCAL_ARTIFACT_DOCUMENTS_PATH, { method: "POST", body: JSON.stringify({ runId: run.id }) });
	if (!response.ok) {
		if (response.status >= 400 && response.status < 500) throw new InvalidCloudDocuments("The runner cannot export the exact prepared document set. Re-run tailoring.");
		throw new Error("The runner's prepared documents are not available for storage yet.");
	}
	const body = await runtimeJson(response) as { runId?: string; instanceId?: string; documents?: unknown };
	if (body.runId !== run.id || body.instanceId !== run.instanceId) throw new InvalidCloudDocuments("Prepared documents belong to another run.");
	const docs = await validatedDocuments(body.documents);
	if (docs.length !== expected.length || !expected.every((d) => docs.some((got) => got.role === d.role && got.sha256 === d.sha256 && got.bytes === d.bytes))) throw new InvalidCloudDocuments("The exported document roles do not exactly match the completed run.");
	for (const d of docs) {
		const expected = d.role === "resume" || d.role === "cover_letter" ? result.artifacts.find((a) => a.kind === d.role) : result.sourceHashes.find((a) => a.role === d.role);
		if (!expected || expected.sha256 !== d.sha256 || expected.bytes !== d.bytes) throw new InvalidCloudDocuments("Prepared documents do not match the completed run's approved hashes.");
	}
	const stub = env.AGENT.get(env.AGENT.idFromName(run.instanceId));
	for (const d of docs) {
		let row = rows.find((r) => r.role === d.role);
		if (!row) {
			const uploaded = await stub.fetch(new Request("https://agent/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `${run.id}-${d.name}`, contentBase64: d.contentBase64, mime_type: d.mimeType, user_id: userId, tags: ["application-document", run.applicationId, run.id, d.role], extract_text: false }) }));
			if (!uploaded.ok) throw new Error("PAGS could not store the prepared documents. It will retry before filling.");
			const meta = await uploaded.json<{ id?: string; userId?: string; name?: string; r2Version?: string; originalSha256?: string; size?: number }>();
			if (!meta.id || !meta.r2Version || meta.userId !== userId || meta.originalSha256 !== d.sha256 || meta.size !== d.bytes) throw new InvalidCloudDocuments("PAGS could not verify the stored document receipt.");
			await env.DB.prepare("INSERT OR IGNORE INTO application_documents (user_id, instance_id, application_id, tailoring_run_id, role, file_id, name, mime_type, version, sha256, bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")
				.bind(userId, run.instanceId, run.applicationId, run.id, d.role, meta.id, meta.name ?? d.name, d.mimeType, meta.r2Version, d.sha256, d.bytes, now).run();
			row = (await rowsFor(env, scope)).find((r) => r.role === d.role);
		}
		if (!row || row.sha256 !== d.sha256 || row.bytes !== d.bytes) throw new InvalidCloudDocuments("The stored document receipt conflicts with this run.");
		const artifact = result.artifacts.find((a) => a.kind === d.role);
		if (artifact) artifact.cloud = reference(run.instanceId, row);
	}
}

/** Revalidate exact Files bytes before each first/queued dispatch; never use another machine's path. */
export async function loadCloudDocuments(env: Env, userId: string, app: JobApplication, runnerVersion?: string | null): Promise<PortableDocument[] | undefined> {
	if (!app.resumeArtifact?.cloud && !app.coverLetterArtifact?.cloud) {
		// Missing public handles do not erase the producer's cloud-only decision or its receipts.
		const cloud = await env.DB.prepare("SELECT 1 AS present FROM local_artifact_runs WHERE user_id = ?1 AND instance_id = ?2 AND application_id = ?3 AND (?4 IS NULL OR id = ?4) AND json_extract(policy, '$.cloudDocuments') = 1 UNION SELECT 1 AS present FROM application_documents WHERE user_id = ?1 AND instance_id = ?2 AND application_id = ?3 AND (?4 IS NULL OR tailoring_run_id = ?4) LIMIT 1")
			.bind(userId, app.instanceId, app.id, app.tailoringRunId ?? null).first();
		if (cloud) throw new HttpError(409, "Prepared cloud document references are missing. Re-run tailoring before filling; no local files were used.");
		return undefined; // verified legacy application
	}
	const problem = cloudDocumentsRunnerProblem(runnerVersion);
	if (problem) throw new HttpError(409, problem);
	const unavailable = () => new HttpError(409, "Prepared documents stored in PAGS are missing or changed. Re-run tailoring before filling; no local files were used.");
	if (!app.tailoringRunId || !app.resumeArtifact?.cloud || !app.coverLetterArtifact?.cloud) throw unavailable();
	const rows = await rowsFor(env, { userId, instanceId: app.instanceId, applicationId: app.id, runId: app.tailoringRunId });
	const docs: PortableDocument[] = [];
	const stub = env.AGENT.get(env.AGENT.idFromName(app.instanceId));
	for (const row of rows) {
		if (row.role === "resume" || row.role === "cover_letter") {
			const artifact = row.role === "resume" ? app.resumeArtifact : app.coverLetterArtifact;
			const ref = artifact.cloud;
			if (!ref || ref.instanceId !== app.instanceId || ref.fileId !== row.file_id || ref.version !== row.version || artifact.sha256 !== row.sha256 || ref.sha256 !== row.sha256 || ref.bytes !== row.bytes) throw unavailable();
		}
		const response = await stub.fetch(new Request(`https://agent/files/${encodeURIComponent(row.file_id)}/application-document`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId, version: row.version, sha256: row.sha256, bytes: row.bytes }) }));
		if (response.status >= 500) throw new HttpError(503, "PAGS document storage is temporarily unavailable. Retry before filling.");
		if (!response.ok) throw unavailable();
		const body = await response.json<{ contentBase64: string }>();
		docs.push({ role: row.role, name: row.role === "cover_letter" ? "cover-letter.md" : `${row.role}.md`, mimeType: row.mime_type, bytes: row.bytes, sha256: row.sha256, contentBase64: body.contentBase64 });
	}
	try { return await validatedDocuments(docs); } catch { throw unavailable(); }
}
