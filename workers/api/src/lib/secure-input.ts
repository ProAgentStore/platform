// Secure input request storage for ephemeral secrets / one-time handoff (#906)
//
// Secrets are envelope-encrypted (KEY_ENCRYPTION_KEY) and stored for agents to reference
// by opaque request ID. The plaintext exists only during atomic one-shot consumption and
// is never returned by any API route, logged, or visible in chat/traces/audit.
// Metadata audit only: who, when, status, success/failure — never the value.

import type { Env } from "../types.js";
import { decryptKey, encryptKey } from "./crypto.js";
import { logError } from "./error-log.js";
import { sqlTime, sqlTimeToIso } from "./sql-time.js";

const TTL_MS = 24 * 60 * 60_000; // 24 hours for one-time input

/** What a secure input request looks like from storage. */
interface SecureInputRow {
	id: string;
	instance_id: string;
	user_id: string;
	status: string;
	label: string;
	purpose: string | null;
	destination_scope: string;
	secret_ciphertext: ArrayBuffer | null;
	dek_wrapped: ArrayBuffer | null;
	iv: ArrayBuffer | null;
	one_shot: number;
	expires_at: string;
	created_at: string;
	updated_at: string;
	consumed_at: string | null;
}

/** What a client (console or agent) sees — metadata only, never the secret. */
export interface SecureInputView {
	id: string;
	status: "pending" | "ready" | "consumed" | "expired";
	label: string;
	purpose?: string;
	destinationScope: string;
	oneShot: boolean;
	expiresAt: string;
	createdAt: string;
	consumedAt?: string;
}

/** Input to create a new secure input request. */
export interface CreateSecureInputInput {
	instanceId: string;
	userId: string;
	label: string;
	purpose?: string;
	destinationScope: "tmux" | "env" | "stdin" | "file";
	oneShot?: boolean;
}

const VIEW_COLUMNS =
	"id, instance_id, user_id, status, label, purpose, destination_scope, one_shot, expires_at, created_at, updated_at, consumed_at";

function rowToView(row: Omit<SecureInputRow, "secret_ciphertext" | "dek_wrapped" | "iv">, now: number): SecureInputView {
	let status: "pending" | "ready" | "consumed" | "expired" = (row.status as any) || "pending";
	if (status !== "consumed" && new Date(row.expires_at).getTime() < now) {
		status = "expired";
	}

	const view: SecureInputView = {
		id: row.id,
		status,
		label: row.label,
		destinationScope: row.destination_scope,
		oneShot: Boolean(row.one_shot),
		expiresAt: sqlTimeToIso(row.expires_at),
		createdAt: row.created_at,
	};

	if (row.purpose) view.purpose = row.purpose;
	if (row.consumed_at) view.consumedAt = row.consumed_at;

	return view;
}

/**
 * Create a new secure input request.
 * Returns the request ID (opaque reference for agent to use in inject call).
 */
export async function createSecureInputRequest(env: Env, input: CreateSecureInputInput): Promise<string> {
	if (!env.KEY_ENCRYPTION_KEY) throw new Error("Key encryption not configured");

	const id = crypto.randomUUID();
	const expiresAt = sqlTime(Date.now() + TTL_MS);

	await env.DB.prepare(
		`INSERT INTO secure_input_requests (
      id, instance_id, user_id, status, label, purpose, destination_scope,
      one_shot, expires_at, created_at, updated_at
    ) VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, datetime('now'), datetime('now'))`,
	)
		.bind(id, input.instanceId, input.userId, input.label, input.purpose ?? null, input.destinationScope, input.oneShot ? 1 : 0, expiresAt)
		.run();

	return id;
}

/**
 * Get the status of a secure input request (metadata only — never the secret).
 * Returns null if not found or belongs to a different user.
 */
export async function getSecureInputStatus(env: Env, requestId: string, instanceId: string, userId: string): Promise<SecureInputView | null> {
	const row = await env.DB.prepare(
		`SELECT ${VIEW_COLUMNS} FROM secure_input_requests WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3`,
	)
		.bind(requestId, instanceId, userId)
		.first<Omit<SecureInputRow, "secret_ciphertext" | "dek_wrapped" | "iv">>();

	if (!row) return null;

	const now = Date.now();
	return rowToView(row, now);
}

/**
 * List secure input requests for an instance (metadata only).
 */
export async function listSecureInputRequests(env: Env, instanceId: string, userId: string, limit = 20): Promise<SecureInputView[]> {
	const res = await env.DB.prepare(
		`SELECT ${VIEW_COLUMNS} FROM secure_input_requests
     WHERE instance_id = ?1 AND user_id = ?2 AND status IN ('pending', 'ready')
     ORDER BY created_at DESC LIMIT ?3`,
	)
		.bind(instanceId, userId, Math.min(Math.max(1, limit), 50))
		.all<Omit<SecureInputRow, "secret_ciphertext" | "dek_wrapped" | "iv">>();

	const now = Date.now();
	return (res.results ?? []).map((r) => rowToView(r, now));
}

/**
 * Store an encrypted secret value for a pending request.
 * Called when user submits the secret via the console UI.
 */
export async function storeSecretValue(
	env: Env,
	requestId: string,
	instanceId: string,
	userId: string,
	secretValue: string,
): Promise<boolean> {
	if (!env.KEY_ENCRYPTION_KEY) throw new Error("Key encryption not configured");

	// Verify the request exists and is pending
	const existing = await env.DB.prepare(
		`SELECT id, status FROM secure_input_requests WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3`,
	)
		.bind(requestId, instanceId, userId)
		.first<{ id: string; status: string }>();

	if (!existing || existing.status !== "pending") {
		return false; // Not found or already consumed
	}

	// Encrypt the secret
	const { ciphertext, dekWrapped, iv } = await encryptKey(secretValue, env.KEY_ENCRYPTION_KEY);

	// Update the request with encrypted secret and mark as 'ready'
	await env.DB.prepare(
		`UPDATE secure_input_requests
     SET status = 'ready', secret_ciphertext = ?1, dek_wrapped = ?2, iv = ?3, updated_at = datetime('now')
     WHERE id = ?4 AND instance_id = ?5 AND user_id = ?6`,
	)
		.bind(ciphertext, dekWrapped, iv, requestId, instanceId, userId)
		.run();

	return true;
}

/**
 * Atomically consume a secure input request: retrieve the plaintext secret and delete the row.
 * This is the ONLY place the plaintext is exposed. It is never returned to the model,
 * never logged, never put in a tool result — the caller (runner/tmux handler) injects it
 * directly into the destination and the plaintext is immediately discarded.
 *
 * Returns the plaintext secret, or null if not found / not ready / already consumed / expired.
 */
export async function consumeSecureInput(env: Env, requestId: string, instanceId: string, userId: string): Promise<string | null> {
	if (!env.KEY_ENCRYPTION_KEY) {
		await logError(env, {
			source: "secure_input",
			message: `Cannot decrypt secure input: KEY_ENCRYPTION_KEY not configured`,
		}).catch(() => undefined);
		return null;
	}

	// Fetch the row with all encrypted columns
	const row = await env.DB.prepare(
		`SELECT id, status, secret_ciphertext, dek_wrapped, iv, expires_at FROM secure_input_requests
     WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3`,
	)
		.bind(requestId, instanceId, userId)
		.first<SecureInputRow>();

	if (!row) return null;

	// Validate status and expiry
	if (row.status !== "ready") return null;
	if (new Date(row.expires_at).getTime() < Date.now()) {
		// Expired — mark as such and clean up
		await env.DB.prepare(
			`UPDATE secure_input_requests SET status = 'expired' WHERE id = ?1`,
		)
			.bind(requestId)
			.run();
		return null;
	}

	// Decrypt the secret
	let plaintext: string;
	try {
		if (!row.secret_ciphertext || !row.dek_wrapped || !row.iv) {
			return null;
		}
		plaintext = await decryptKey(
			new Uint8Array(row.secret_ciphertext),
			new Uint8Array(row.dek_wrapped),
			new Uint8Array(row.iv),
			env.KEY_ENCRYPTION_KEY,
		);
	} catch (e) {
		await logError(env, {
			source: "secure_input",
			message: `Failed to decrypt secure input request: ${e instanceof Error ? e.message : String(e)}`,
		}).catch(() => undefined);
		return null;
	}

	// Atomically mark as consumed and delete ciphertext (one-shot)
	await env.DB.prepare(
		`UPDATE secure_input_requests SET status = 'consumed', consumed_at = datetime('now'),
     secret_ciphertext = NULL, dek_wrapped = NULL, iv = NULL
     WHERE id = ?1`,
	)
		.bind(requestId)
		.run();

	// Return plaintext (caller must not log it or put it in any response)
	return plaintext;
}

/**
 * Clean up expired requests (run by a scheduled task or manually).
 */
export async function purgeExpiredSecureInputs(env: Env): Promise<number> {
	const result = await env.DB.prepare(
		`DELETE FROM secure_input_requests WHERE expires_at < datetime('now')`,
	).run();
	return result.meta.changes;
}
