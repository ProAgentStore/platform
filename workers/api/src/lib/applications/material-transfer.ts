/**
 * #1010's deliberately narrow escape hatch for a reviewed material set behind a paused edge.
 * It persists a receipt before touching the existing delivery pump, keeps the edge paused, and
 * sends only a review-only event.  No document bytes are read or copied by the service.
 */
import { HttpError } from "../auth.js";
import { capabilitiesForInstance } from "../agent-capabilities.js";
import { enqueueDelivery, getDelivery, idempotencyKey, type DeliveryRow } from "../connection-deliveries.js";
import { attemptDelivery } from "../connections.js";
import { MATERIALS_READY_EVENT } from "../local-artifact/contract.js";
import { getOwnedApplication, type JobApplication } from "../local-artifact/store.js";
import { getApplyRunByRequest } from "../local-apply/store.js";
import type { Env } from "../../types.js";

const HASH = /^[a-f0-9]{64}$/i;
const now = () => Date.now();

interface ReceiptRow {
	id: string;
	user_id: string;
	source_application_id: string;
	source_tailor_instance_id: string;
	destination_runner_instance_id: string;
	connection_id: string;
	source_state_version: number;
	resume_sha256: string;
	cover_letter_sha256: string;
	idempotency_key: string;
	transfer_event_id: string;
	event_payload: string;
	delivery_id: string | null;
	created_at: number;
	updated_at: number;
}

export interface PreparedTransferInput {
	applicationId: string;
	expectedStatus: string;
	expectedVersion: number;
	resumeSha256: string;
	coverLetterSha256: string;
	destinationRunnerInstanceId: string;
	connectionId: string;
	idempotencyKey: string;
}

export interface TransferReceipt {
	id: string;
	sourceApplicationId: string;
	destinationApplicationId: string;
	destinationRunnerInstanceId: string;
	connectionId: string;
	stateVersion: number;
	resumeSha256: string;
	coverLetterSha256: string;
	deliveryId: string | null;
	deliveryStatus: string | null;
	runId: string | null;
	status: "queued" | "delivered" | "retrying" | "dead" | "consumed";
}

function artifactHash(a: unknown, kind: "resume" | "cover_letter"): string | null {
	if (!a || typeof a !== "object" || Array.isArray(a)) return null;
	const x = a as Record<string, unknown>;
	if (x.kind !== kind || typeof x.path !== "string" || !x.path.startsWith("~/") || typeof x.sha256 !== "string" || !HASH.test(x.sha256)) return null;
	return x.sha256.toLowerCase();
}

function parsePayload(row: ReceiptRow): Record<string, unknown> {
	try {
		const value = JSON.parse(row.event_payload);
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch { /* validated on insertion; a corrupt receipt is fail-closed below */ }
	throw new HttpError(409, "This transfer receipt is unreadable and cannot be replayed safely.");
}

async function receiptFor(env: Env, uid: string, input: PreparedTransferInput): Promise<ReceiptRow | null> {
	return await env.DB.prepare("SELECT * FROM application_material_transfers WHERE user_id = ?1 AND idempotency_key = ?2")
		.bind(uid, input.idempotencyKey).first<ReceiptRow>();
}

function sameRequest(row: ReceiptRow, input: PreparedTransferInput): boolean {
	return row.source_application_id === input.applicationId && row.destination_runner_instance_id === input.destinationRunnerInstanceId && row.connection_id === input.connectionId && row.source_state_version === input.expectedVersion && row.resume_sha256 === input.resumeSha256.toLowerCase() && row.cover_letter_sha256 === input.coverLetterSha256.toLowerCase();
}

async function validate(env: Env, uid: string, tailorInstanceId: string, input: PreparedTransferInput): Promise<{ app: JobApplication; payload: Record<string, unknown>; config: Record<string, unknown> }> {
	if (input.expectedStatus !== "materials_ready") throw new HttpError(400, "expected_status must be materials_ready for a reviewed material transfer.");
	if (!HASH.test(input.resumeSha256) || !HASH.test(input.coverLetterSha256)) throw new HttpError(400, "resume_sha256 and cover_letter_sha256 must be 64-character SHA-256 hex digests.");
	if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 300) throw new HttpError(400, "idempotency_key is required and must be at most 300 characters.");
	const app = await getOwnedApplication(env, uid, input.applicationId);
	if (!app || app.instanceId !== tailorInstanceId) throw new HttpError(404, "That reviewed application is not owned by this Application Tailor.");
	if (app.status !== "materials_ready" || app.stateVersion !== input.expectedVersion) throw new HttpError(409, `stale: this application is ${app.status} (version ${app.stateVersion}); reload its reviewed materials before transferring.`);
	if (app.submitAttemptedAt || app.fillRunId) throw new HttpError(409, "This material set has already entered a fill or submit path and cannot be transferred again.");
	if ((await capabilitiesForInstance(env, tailorInstanceId, uid))?.runtime !== "local_artifact") throw new HttpError(409, "The source instance is not an Application Tailor.");
	if ((await capabilitiesForInstance(env, input.destinationRunnerInstanceId, uid))?.runtime !== "local_apply") throw new HttpError(409, "The selected destination is not an Application Runner.");
	const resume = artifactHash(app.resumeArtifact, "resume");
	const cover = artifactHash(app.coverLetterArtifact, "cover_letter");
	if (!resume || !cover || !app.readyEvent) throw new HttpError(409, "The reviewed material handles are incomplete or unreadable; re-tailor this application instead.");
	if (resume !== input.resumeSha256.toLowerCase() || cover !== input.coverLetterSha256.toLowerCase()) throw new HttpError(409, "The reviewed material hashes changed; reload and review the exact current set before transferring.");
	const eventResume = artifactHash((app.readyEvent.artifacts as Record<string, unknown> | undefined)?.resume, "resume");
	const eventCover = artifactHash((app.readyEvent.artifacts as Record<string, unknown> | undefined)?.coverLetter, "cover_letter");
	if (eventResume !== resume || eventCover !== cover || app.readyEvent.applicationId !== app.id || app.readyEvent.tailorInstanceId !== tailorInstanceId) throw new HttpError(409, "The stored material provenance no longer matches this application; it will not be transferred.");
	const connection = await env.DB.prepare(
		"SELECT config FROM agent_connections WHERE id = ?1 AND user_id = ?2 AND source_instance_id = ?3 AND target_instance_id = ?4 AND event_type = ?5 AND action = 'start_application_fill' AND enabled = 0",
	).bind(input.connectionId, uid, tailorInstanceId, input.destinationRunnerInstanceId, MATERIALS_READY_EVENT).first<{ config: string | null }>();
	if (!connection) throw new HttpError(409, "The selected connection is not this owner's paused Tailor-to-Runner materials_ready edge.");
	let config: Record<string, unknown> = {};
	try { const parsed = connection.config ? JSON.parse(connection.config) : {}; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>; } catch { throw new HttpError(409, "The selected connection has invalid routing configuration."); }
	return { app, payload: app.readyEvent, config };
}

function view(row: ReceiptRow, delivery: DeliveryRow | null, runId: string | null): TransferReceipt {
	const deliveryStatus = delivery?.status ?? null;
	return {
		id: row.id, sourceApplicationId: row.source_application_id, destinationApplicationId: row.source_application_id,
		destinationRunnerInstanceId: row.destination_runner_instance_id, connectionId: row.connection_id,
		stateVersion: row.source_state_version, resumeSha256: row.resume_sha256, coverLetterSha256: row.cover_letter_sha256,
		deliveryId: row.delivery_id, deliveryStatus, runId,
		status: runId ? "consumed" : deliveryStatus === "delivered" ? "delivered" : deliveryStatus === "dead" ? "dead" : deliveryStatus === "pending" ? "retrying" : "queued",
	};
}

async function reconcile(env: Env, uid: string, row: ReceiptRow): Promise<TransferReceipt> {
	const delivery = row.delivery_id ? await getDelivery(env, uid, row.delivery_id) : null;
	const run = await getApplyRunByRequest(env, row.destination_runner_instance_id, uid, row.transfer_event_id);
	return view(row, delivery, run?.id ?? null);
}

/** Create or recover ONE receipt then use the normal durable pump with its review-only flag. */
export async function transferPreparedApplication(env: Env, uid: string, tailorInstanceId: string, input: PreparedTransferInput): Promise<TransferReceipt> {
	const existing = await receiptFor(env, uid, input);
	if (existing) {
		if (!sameRequest(existing, input)) throw new HttpError(409, "This idempotency key belongs to a different material transfer.");
		return await reconcile(env, uid, existing);
	}
	const { app, payload: basePayload, config } = await validate(env, uid, tailorInstanceId, input);
	const id = crypto.randomUUID();
	const transferEventId = `transfer:${id}`;
	const payload = { ...basePayload, eventId: transferEventId, transferReceiptId: id };
	const time = now();
	await env.DB.prepare(
		`INSERT OR IGNORE INTO application_material_transfers
		(id, user_id, source_application_id, source_tailor_instance_id, destination_runner_instance_id, connection_id, source_state_version, resume_sha256, cover_letter_sha256, idempotency_key, transfer_event_id, event_payload, created_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`,
	).bind(id, uid, app.id, tailorInstanceId, input.destinationRunnerInstanceId, input.connectionId, app.stateVersion, input.resumeSha256.toLowerCase(), input.coverLetterSha256.toLowerCase(), input.idempotencyKey, transferEventId, JSON.stringify(payload), time).run();
	const row = await receiptFor(env, uid, input);
	if (!row) throw new HttpError(503, "The transfer receipt could not be recorded; nothing was sent.");
	if (!sameRequest(row, input)) throw new HttpError(409, "A concurrent request used this idempotency key for different material.");
	if (!row.delivery_id) {
		const savedPayload = parsePayload(row);
		const transferConfig = { ...config, reviewOnly: true, transferReceiptId: row.id };
		const traceId = row.transfer_event_id;
		const claim = await enqueueDelivery(env, { connectionId: row.connection_id, userId: uid, sourceInstanceId: row.source_tailor_instance_id, targetInstanceId: row.destination_runner_instance_id, eventType: MATERIALS_READY_EVENT, action: "start_application_fill", payload: savedPayload, config: transferConfig, traceId, claimedInline: true });
		const outboxKey = idempotencyKey(row.connection_id, traceId, savedPayload);
		const delivery = claim
			? await env.DB.prepare("SELECT * FROM agent_connection_deliveries WHERE id = ?1").bind(claim.id).first<DeliveryRow>()
			: await env.DB.prepare("SELECT * FROM agent_connection_deliveries WHERE user_id = ?1 AND idempotency_key = ?2").bind(uid, outboxKey).first<DeliveryRow>();
		if (!delivery) throw new HttpError(503, "The transfer delivery could not be recovered safely; retry with the same idempotency key.");
		if (!row.delivery_id) await env.DB.prepare("UPDATE application_material_transfers SET delivery_id = ?1, updated_at = ?2 WHERE id = ?3 AND delivery_id IS NULL").bind(delivery.id, now(), row.id).run();
		if (claim) await attemptDelivery(env, { claim, attempts: 0, connectionId: row.connection_id, userId: uid, sourceInstanceId: row.source_tailor_instance_id, targetInstanceId: row.destination_runner_instance_id, eventType: MATERIALS_READY_EVENT, action: "start_application_fill", config: transferConfig, payload: savedPayload, traceId, source: "connection" });
	}
	const settled = await receiptFor(env, uid, input);
	if (!settled) throw new HttpError(503, "The transfer receipt disappeared; no retry is attempted automatically.");
	return await reconcile(env, uid, settled);
}
