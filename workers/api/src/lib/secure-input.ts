// Secure input request storage for ephemeral secrets / one-time handoff (#906)
//
// Secrets are envelope-encrypted (KEY_ENCRYPTION_KEY) and stored for agents to reference
// by opaque request ID. The plaintext exists only during atomic one-shot consumption and
// is never returned by any API route, logged, or visible in chat/traces/audit.
// Metadata audit only: who, when, status, success/failure — never the value.
//
// Note: instance_id references agent_instances (the user's subscription), not agents (the template).
// See migration 0170 for the FK correction from agents → agent_instances.

import type { Env } from "../types.js";
import { decryptKey, encryptKey } from "./crypto.js";
import { logError } from "./error-log.js";
import { sqlTime, sqlTimeMs, sqlTimeToIso } from "./sql-time.js";

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
	source_node: string | null;
	consumed_node: string | null;
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
	/**
	 * Who supplies the value (#929): `owner` types it in the console; `deposit` was read off a machine
	 * by `tmux_secure_put` (#918). Stated rather than inferred from `sourceNode`, which a deposit made
	 * over a connection with no node name does not have.
	 */
	kind: "owner" | "deposit";
	/** The runner node a machine deposit (`tmux_secure_put`, #918) was read on. Absent = typed in the console. */
	sourceNode?: string;
	/** The runner node that wrote the value out (`tmux_secure_get`). */
	consumedNode?: string;
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

/** The longest a machine deposit may wait for its retrieval. Shorter than the console path's day on purpose. */
export const DEPOSIT_MAX_TTL_MS = TTL_MS;

const VIEW_COLUMNS =
	"id, instance_id, user_id, status, label, purpose, destination_scope, one_shot, expires_at, created_at, updated_at, consumed_at, source_node, consumed_node";

function rowToView(row: Omit<SecureInputRow, "secret_ciphertext" | "dek_wrapped" | "iv">, now: number): SecureInputView {
	let status: "pending" | "ready" | "consumed" | "expired" = (row.status as "pending" | "ready" | "consumed" | "expired") || "pending";
	if (status !== "consumed" && sqlTimeMs(row.expires_at) < now) {
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
		// A deposit always writes `source_node` — `""` when its machine had no name — and an owner request never does.
		kind: row.source_node === null ? "owner" : "deposit",
	};

	if (row.purpose) view.purpose = row.purpose;
	if (row.consumed_at) view.consumedAt = row.consumed_at;
	if (row.source_node) view.sourceNode = row.source_node;
	if (row.consumed_node) view.consumedNode = row.consumed_node;

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

/** One instance's owner-facing requests still waiting for a value (#934). */
export interface PendingOwnerInputs {
	instanceId: string;
	pending: number;
	/** The OLDEST waiting request — the one to answer first, and the card's deep link. */
	requestId: string;
	label: string;
}

/**
 * Every instance of this user with an owner-facing request still waiting for a value (#934).
 *
 * Owner-facing = `status = 'pending'`: an owner request is created `pending` and turns `ready` when
 * the owner enters it, while a machine deposit (#918) is created `ready` — nothing for the owner to
 * type. Expired rows are excluded by time, because the stored status is not rewritten on expiry.
 */
export async function pendingOwnerInputs(env: Env, userId: string, now: number = Date.now()): Promise<PendingOwnerInputs[]> {
	const res = await env.DB.prepare(
		`SELECT id, instance_id, label FROM secure_input_requests
		  WHERE user_id = ?1 AND status = 'pending' AND expires_at > ?2
		  ORDER BY created_at ASC LIMIT 500`,
	)
		.bind(userId, sqlTime(now))
		.all<{ id: string; instance_id: string; label: string }>();
	const byInstance = new Map<string, PendingOwnerInputs>();
	for (const r of res.results ?? []) {
		const row = byInstance.get(r.instance_id);
		if (row) row.pending++;
		else byInstance.set(r.instance_id, { instanceId: r.instance_id, pending: 1, requestId: r.id, label: r.label });
	}
	return [...byInstance.values()];
}

/**
 * The open requests, or with `all` (#929 finding 8) the history too — consumed and expired rows,
 * which is where "Moved from X to Y" lives once a handoff completes. Still metadata only.
 */
const statusFilter = (all: boolean) => (all ? "1 = 1" : "status IN ('pending', 'ready')");

/**
 * List secure input requests for an instance (metadata only) — one page, newest first. Its total
 * is {@link countSecureInputRequests}, so a page never reads as every request (#954).
 */
export async function listSecureInputRequests(env: Env, instanceId: string, userId: string, limit = 20, offset = 0, all = false): Promise<SecureInputView[]> {
	const res = await env.DB.prepare(
		`SELECT ${VIEW_COLUMNS} FROM secure_input_requests
     WHERE instance_id = ?1 AND user_id = ?2 AND ${statusFilter(all)}
     ORDER BY created_at DESC LIMIT ?3 OFFSET ?4`,
	)
		.bind(instanceId, userId, Math.min(Math.max(1, limit), 50), Math.max(0, Math.trunc(offset)))
		.all<Omit<SecureInputRow, "secret_ciphertext" | "dek_wrapped" | "iv">>();

	const now = Date.now();
	return (res.results ?? []).map((r) => rowToView(r, now));
}

/** How many pending/ready requests the instance has in all — the denominator of a list page (#954). */
export async function countSecureInputRequests(env: Env, instanceId: string, userId: string, all = false): Promise<number> {
	const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM secure_input_requests WHERE instance_id = ?1 AND user_id = ?2 AND ${statusFilter(all)}`)
		.bind(instanceId, userId)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
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

	if (existing?.status !== "pending") {
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
 * Deposit a value that a MACHINE read (#918 — `tmux_secure_put`), straight into `ready`.
 *
 * The console path is two steps (request, then the owner submits); a machine deposit has no human
 * in it, so the row is born encrypted. Returns the opaque handle — the only thing the caller may
 * hand back to the model.
 */
export async function depositSecureInput(
	env: Env,
	input: { instanceId: string; userId: string; label: string; purpose?: string; sourceNode: string | null; ttlMs: number; value: string },
): Promise<{ id: string; expiresAt: string }> {
	if (!env.KEY_ENCRYPTION_KEY) throw new Error("Key encryption not configured");
	const id = crypto.randomUUID();
	const expiresAt = sqlTime(Date.now() + Math.min(Math.max(input.ttlMs, 60_000), DEPOSIT_MAX_TTL_MS));
	const { ciphertext, dekWrapped, iv } = await encryptKey(input.value, env.KEY_ENCRYPTION_KEY);
	await env.DB.prepare(
		`INSERT INTO secure_input_requests (
      id, instance_id, user_id, status, label, purpose, destination_scope, secret_ciphertext, dek_wrapped, iv,
      one_shot, expires_at, created_at, updated_at, source_node
    ) VALUES (?1, ?2, ?3, 'ready', ?4, ?5, 'file', ?6, ?7, ?8, 1, ?9, datetime('now'), datetime('now'), ?10)`,
	)
		.bind(id, input.instanceId, input.userId, input.label, input.purpose ?? null, ciphertext, dekWrapped, iv, expiresAt, input.sourceNode ?? "")
		.run();
	return { id, expiresAt: sqlTimeToIso(expiresAt) };
}

/**
 * Put a consumed value back to `ready` when the destination could not be written (#918).
 *
 * A one-shot handle that is spent on a failed write leaves the owner nothing to retry with. Only a
 * row THIS consume emptied qualifies (`consumed` with no ciphertext), and its expiry is untouched.
 */
export async function restoreConsumedSecureInput(env: Env, requestId: string, userId: string, value: string): Promise<boolean> {
	if (!env.KEY_ENCRYPTION_KEY) return false;
	const { ciphertext, dekWrapped, iv } = await encryptKey(value, env.KEY_ENCRYPTION_KEY);
	const res = await env.DB.prepare(
		`UPDATE secure_input_requests
     SET status = 'ready', secret_ciphertext = ?1, dek_wrapped = ?2, iv = ?3, consumed_at = NULL, consumed_node = NULL, updated_at = datetime('now')
     WHERE id = ?4 AND user_id = ?5 AND status = 'consumed' AND secret_ciphertext IS NULL`,
	)
		.bind(ciphertext, dekWrapped, iv, requestId, userId)
		.run();
	return res.meta.changes === 1;
}

/**
 * Atomically consume a secure input request: retrieve the plaintext secret and delete the row.
 * This is the ONLY place the plaintext is exposed. It is never returned to the model,
 * never logged, never put in a tool result — the caller (runner/tmux handler) injects it
 * directly into the destination and the plaintext is immediately discarded.
 *
 * `instanceId: null` consumes any of the OWNER's handles — the machine-to-machine handoff (#918),
 * where machine B's operator retrieves what machine A's operator deposited. Same owner is the
 * authorization: `user_id` is matched either way, and handles are unguessable UUIDs.
 *
 * Returns the plaintext secret, or null if not found / not ready / already consumed / expired.
 */
export async function consumeSecureInput(
	env: Env,
	requestId: string,
	instanceId: string | null,
	userId: string,
	opts: { consumedNode?: string | null } = {},
): Promise<string | null> {
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
     WHERE id = ?1 AND user_id = ?3 AND (?2 IS NULL OR instance_id = ?2)`,
	)
		.bind(requestId, instanceId, userId)
		.first<SecureInputRow>();

	if (!row) return null;

	// Validate status and expiry
	if (row.status !== "ready") return null;
	if (sqlTimeMs(row.expires_at) < Date.now()) {
		// Expired — mark as such and clean up
		await env.DB.prepare(
			`UPDATE secure_input_requests SET status = 'expired' WHERE id = ?1`,
		)
			.bind(requestId)
			.run();
		return null;
	}

	if (!row.secret_ciphertext || !row.dek_wrapped || !row.iv) return null;
	const sealed = { c: new Uint8Array(row.secret_ciphertext), d: new Uint8Array(row.dek_wrapped), i: new Uint8Array(row.iv) };

	// CLAIM first, conditionally: the one-shot guarantee is this predicate. Two concurrent consumers
	// both read `ready` above; only one of them moves the row, and the other gets null (#918 — a
	// handle on two machines' operators is exactly the case where two gets can race).
	const claimed = await env.DB.prepare(
		`UPDATE secure_input_requests SET status = 'consumed', consumed_at = datetime('now'), consumed_node = ?2,
     secret_ciphertext = NULL, dek_wrapped = NULL, iv = NULL
     WHERE id = ?1 AND status = 'ready'`,
	)
		.bind(requestId, opts.consumedNode ?? null)
		.run();
	if (claimed.meta.changes !== 1) return null;

	let plaintext: string;
	try {
		plaintext = await decryptKey(sealed.c, sealed.d, sealed.i, env.KEY_ENCRYPTION_KEY);
	} catch (e) {
		await logError(env, {
			source: "secure_input",
			message: `Failed to decrypt secure input request: ${e instanceof Error ? e.message : String(e)}`,
		}).catch(() => undefined);
		return null;
	}

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
