// Interactive outbound-MCP calls (#264) — the STORAGE half. The decisions are pure and live in
// lib/mcp-elicitation.ts; this is the D1 record that lets a paused call survive the minutes a
// human takes to answer, plus the two helpers the connector and the route each need.
//
// The rule this module exists to keep: to RETRY a call we must remember it, and the thing worth
// remembering is the remote tool's arguments — the most PII-dense thing the connector touches.
// They are envelope-encrypted (lib/crypto.ts), the answer is never stored at all, and nothing here
// logs a value. See migration 0094 for the full reasoning.
import type { Env } from "../types.js";
import { decryptKey, encryptKey } from "./crypto.js";
import { redactText } from "./redact.js";
import { INPUT_TTL_MS, MAX_ROUNDS, resolveInputStatus, type McpInputAsk, type McpInputField, type McpInputStatus } from "./mcp-elicitation.js";

/** The paused call, as it is held between the ask and the answer. */
export interface PausedMcpCall {
	args: Record<string, unknown>;
	/** Whether the original call sent the endpoint's credential. Preserved so a resume reproduces
	 *  the call exactly — a retry that quietly switched to `auth:"none"` would fail differently
	 *  from the call the user is answering for, which is the confusing kind of bug. */
	useAuth: boolean;
}

export interface OpenMcpInputRequestInput {
	userId: string;
	instanceId: string;
	traceId?: string | null;
	/** Already normalized by the caller — this module never re-derives it, so there is one parser. */
	endpoint: string;
	tool: string;
	round: number;
	ask: McpInputAsk;
	call: PausedMcpCall;
}

/** What a console may see: everything needed to render the form, and nothing the user supplied. */
export interface McpInputRequestView {
	id: string;
	endpoint: string;
	tool: string;
	status: McpInputStatus;
	round: number;
	maxRounds: number;
	message: string;
	fields: McpInputField[];
	traceId: string | null;
	expiresAt: string;
	createdAt: string;
}

interface RequestRow {
	id: string;
	instance_id: string;
	user_id: string;
	endpoint: string;
	tool: string;
	trace_id: string | null;
	status: string;
	round: number;
	message: string;
	schema_json: string;
	use_auth: number;
	call_ciphertext: ArrayBuffer | null;
	dek_wrapped: ArrayBuffer | null;
	iv: ArrayBuffer | null;
	expires_at: string;
	created_at: string;
}

const VIEW_COLUMNS = "id, instance_id, user_id, endpoint, tool, trace_id, status, round, message, schema_json, use_auth, expires_at, created_at";

function toView(row: RequestRow, now: number): McpInputRequestView {
	let fields: McpInputField[] = [];
	try {
		const parsed = JSON.parse(row.schema_json) as unknown;
		if (Array.isArray(parsed)) fields = parsed as McpInputField[];
	} catch {
		// A row whose schema will not parse is shown as a confirmation rather than dropped: the
		// pending call is real either way, and hiding it would leave a paused run with nothing on
		// screen to explain why it is waiting.
	}
	return {
		id: row.id,
		endpoint: row.endpoint,
		tool: row.tool,
		status: resolveInputStatus({ status: row.status, expiresAt: row.expires_at }, now),
		round: row.round,
		maxRounds: MAX_ROUNDS,
		message: row.message,
		fields,
		traceId: row.trace_id,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
	};
}

/**
 * Record one pending ask and return its id.
 *
 * The MESSAGE is redacted on the way in. It is remote text heading for a database, a JSON response
 * and a rendered page, and a server that echoes our `Authorization` header into its own prompt must
 * not put a credential in all three.
 */
export async function openMcpInputRequest(env: Env, input: OpenMcpInputRequestInput): Promise<string> {
	if (!env.KEY_ENCRYPTION_KEY) throw new Error("Key encryption not configured");
	const id = crypto.randomUUID();
	const { ciphertext, dekWrapped, iv } = await encryptKey(JSON.stringify(input.call), env.KEY_ENCRYPTION_KEY);
	const expiresAt = new Date(Date.now() + INPUT_TTL_MS).toISOString();
	await env.DB.prepare(
		`INSERT INTO mcp_input_requests (id, instance_id, user_id, endpoint, tool, trace_id, status, round, message, schema_json, use_auth, call_ciphertext, dek_wrapped, iv, expires_at, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, datetime('now'))`,
	)
		.bind(
			id,
			input.instanceId,
			input.userId,
			input.endpoint,
			input.tool,
			input.traceId ?? null,
			input.round,
			redactText(input.ask.message).slice(0, 2000),
			JSON.stringify(input.ask.fields),
			input.call.useAuth ? 1 : 0,
			ciphertext,
			dekWrapped,
			iv,
			expiresAt,
		)
		.run();
	return id;
}

/** One instance's asks, newest first. Metadata only — the encrypted call payload is not selected,
 *  so a list route cannot become a way to read back the arguments. */
export async function listMcpInputRequests(env: Env, instanceId: string, userId: string, limit = 20): Promise<McpInputRequestView[]> {
	const res = await env.DB.prepare(
		`SELECT ${VIEW_COLUMNS} FROM mcp_input_requests WHERE instance_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT ?3`,
	)
		.bind(instanceId, userId, Math.min(Math.max(1, limit), 50))
		.all<RequestRow>();
	const now = Date.now();
	return (res.results ?? []).map((r) => toView(r, now));
}

/** One ask, scoped to its owner AND its instance — a request id from another agent must not
 *  resolve here, or an ask raised by one instance could be answered under another's authority. */
export async function readMcpInputRequest(env: Env, id: string, instanceId: string, userId: string): Promise<McpInputRequestView | null> {
	const row = await env.DB.prepare(`SELECT ${VIEW_COLUMNS} FROM mcp_input_requests WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3`)
		.bind(id, instanceId, userId)
		.first<RequestRow>();
	return row ? toView(row, Date.now()) : null;
}

/**
 * Claim a pending ask, closing it as `answered` or `cancelled`, and hand back the call it paused.
 *
 * CLAIMED WITH AN ATOMIC UPDATE, exactly as an actionable ticket is: the `status = 'pending'` guard
 * is in the same statement that closes the row, so two clicks — or a click racing the expiry
 * sweeper — cannot both retry the same remote call. A remote tool call is not idempotent; that is
 * the reason it needed consent in the first place, so "answered twice" is a real side effect rather
 * than a cosmetic double-submit.
 *
 * The payload is READ FIRST and the claim nulls it, in that order. Reading afterwards would leave
 * the winner holding nothing to retry, and reading first costs only that a LOSER decrypts arguments
 * it then does nothing with — it never reaches a dispatch, because the claim returns null.
 *
 * Returns null when the row was not pending, was not this owner's, had expired, or could not be
 * decrypted. The caller reads the current state separately to say which of those it was.
 */
export async function claimMcpInputRequest(env: Env, id: string, instanceId: string, userId: string, status: "answered" | "cancelled"): Promise<PausedMcpCall | null> {
	if (!env.KEY_ENCRYPTION_KEY) return null;
	const row = await env.DB.prepare("SELECT call_ciphertext, dek_wrapped, iv, use_auth FROM mcp_input_requests WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status = 'pending'")
		.bind(id, instanceId, userId)
		.first<{ call_ciphertext: ArrayBuffer | null; dek_wrapped: ArrayBuffer | null; iv: ArrayBuffer | null; use_auth: number }>();
	if (!row?.call_ciphertext || !row.dek_wrapped || !row.iv) return null;

	const claimed = await env.DB.prepare(
		`UPDATE mcp_input_requests SET status = ?4, resolved_at = datetime('now'), call_ciphertext = NULL, dek_wrapped = NULL, iv = NULL
		 WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status = 'pending' AND expires_at > datetime('now')
		 RETURNING id`,
	)
		.bind(id, instanceId, userId, status)
		.first<{ id: string }>();
	if (!claimed) return null;
	// A cancel needs nothing out of the payload, and must not be blocked by it: an ask whose
	// ciphertext will not decrypt is exactly the one a user most wants to be able to dismiss.
	if (status === "cancelled") return { args: {}, useAuth: row.use_auth === 1 };

	try {
		const plain = await decryptKey(new Uint8Array(row.call_ciphertext), new Uint8Array(row.dek_wrapped), new Uint8Array(row.iv), env.KEY_ENCRYPTION_KEY);
		const parsed = JSON.parse(plain) as Partial<PausedMcpCall>;
		return { args: parsed.args && typeof parsed.args === "object" ? (parsed.args as Record<string, unknown>) : {}, useAuth: parsed.useAuth !== false };
	} catch {
		// A payload we cannot decrypt is a call we cannot honestly reproduce. The row is already
		// closed, so the ask does not sit pending forever against a record nothing can act on.
		return null;
	}
}

/**
 * Expire every ask that has run out, and drop the arguments it was holding.
 *
 * Opportunistic (called from the list route, like `purgeExpiredFlows`) rather than a cron: the row
 * is already refused past its deadline by `resolveInputStatus`, so this is not enforcement — it is
 * making sure the encrypted copy of somebody's arguments does not outlive the ask that justified
 * keeping it.
 */
export async function purgeExpiredMcpInputRequests(env: Env): Promise<void> {
	await env.DB.prepare(
		`UPDATE mcp_input_requests SET status = 'expired', resolved_at = datetime('now'), call_ciphertext = NULL, dek_wrapped = NULL, iv = NULL
		 WHERE status = 'pending' AND expires_at <= datetime('now')`,
	)
		.run()
		.catch(() => undefined);
}
