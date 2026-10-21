// Worker-backed email connector (#1269) — connection storage, resolution and inbound dedupe.
//
// WHY A DEDICATED TABLE RATHER THAN user_api_keys. The reasoning is identical to
// mcp-credentials.ts: the "provider" dimension for this connector is a WORKER ENDPOINT the owner
// supplies, not a fixed id, so a single `(user_id, provider)` vault slot would let a secret meant
// for one worker reach whichever worker a later call happened to name. `email_worker_connections`
// keys on `(user_id, endpoint, account_id)` for the same reason `mcp_credentials` does (migration
// 0270 is the one-column-simpler sibling of 0267 — bearer-only, no OAuth columns, because the
// adapter contract names exactly one credential shape: a pasted bearer secret for that Worker).
//
// WHY THE TOOLS (connectors/email-worker.ts) DO NOT TAKE AN ENDPOINT ARGUMENT, unlike MCP's
// `mcp_call_tool`. The outbound MCP connector's server is a tool INPUT because an agent may
// legitimately want to reach several different MCP servers in one conversation. A mailbox is not
// like that: issue #1269 asks for the same shape Gmail already has — "pin ONE mailbox to this
// agent instance" — so the model is never shown an endpoint or a secret, and the pin is resolved
// here, server-side, from the instance's own config. {@link resolveEmailWorkerConnection} is the
// one place that answers "which connection does THIS instance use", mirroring the refusal
// discipline connector-accounts.ts states for the single-dimension case: refusing beats picking,
// a stale pin refuses rather than falls back, and one connection resolves with no configuration.
import type { Env } from "../types.js";
import { decryptKey, encryptKey } from "./crypto.js";

/** The contract version this build of the platform speaks against. Recorded on a connection only
 *  as a fact the Worker reported — never asserted by the owner — so a console can show a Worker
 *  claiming an older or newer contract than the one PAGS currently calls. */
export const EMAIL_WORKER_CONTRACT_VERSION = "email-worker/v1";

/** Credential-free connection metadata — the shape a route may return. */
export interface EmailWorkerConnectionInfo {
	endpoint: string;
	/** '' = the unnamed default account on this endpoint. */
	accountId: string;
	accountLabel: string | null;
	contractVersion: string | null;
	webhookUrl: string;
	createdAt: string;
	updatedAt: string;
}

interface ConnRow {
	endpoint: string;
	account_id: string;
	account_label: string | null;
	contract_version: string | null;
	webhook_token: string;
	created_at: string;
	updated_at: string;
}

function toInfo(r: ConnRow, origin: string): EmailWorkerConnectionInfo {
	return {
		endpoint: r.endpoint,
		accountId: r.account_id ?? "",
		accountLabel: r.account_label,
		contractVersion: r.contract_version,
		webhookUrl: `${origin}/v1/email-worker/inbound/${r.webhook_token}`,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

/** Every worker-backed email connection the owner holds, across every endpoint. Credential-free. */
export async function listEmailWorkerConnections(env: Env, userId: string, origin: string): Promise<EmailWorkerConnectionInfo[]> {
	const res = await env.DB.prepare(
		"SELECT endpoint, account_id, account_label, contract_version, webhook_token, created_at, updated_at FROM email_worker_connections WHERE user_id = ?1 ORDER BY endpoint, account_id",
	)
		.bind(userId)
		.all<ConnRow>();
	return (res.results ?? []).map((r) => toInfo(r, origin));
}

export interface SaveEmailWorkerConnectionInput {
	userId: string;
	/** Already normalized by the caller (see {@link normalizeEmailWorkerEndpoint}) — one parser. */
	endpoint: string;
	accountId?: string;
	secret: string;
	accountLabel?: string | null;
	contractVersion?: string | null;
}

/**
 * Store (or REPLACE — AC1) the connection for one (endpoint, account). A fresh row mints its own
 * `webhook_token`; replacing an existing connection's secret keeps the SAME token, so the owner's
 * Worker config (the inbound URL they pasted into their own code) survives a credential rotation.
 */
export async function saveEmailWorkerConnection(env: Env, input: SaveEmailWorkerConnectionInput): Promise<{ webhookToken: string }> {
	if (!env.KEY_ENCRYPTION_KEY) throw new Error("Key encryption not configured");
	const accountId = input.accountId ?? "";
	const existing = await env.DB.prepare("SELECT webhook_token FROM email_worker_connections WHERE user_id = ?1 AND endpoint = ?2 AND account_id = ?3")
		.bind(input.userId, input.endpoint, accountId)
		.first<{ webhook_token: string }>();
	const webhookToken = existing?.webhook_token ?? makeWebhookToken();
	const { ciphertext, dekWrapped, iv } = await encryptKey(input.secret, env.KEY_ENCRYPTION_KEY);
	await env.DB.prepare(
		`INSERT INTO email_worker_connections (user_id, endpoint, account_id, secret_ciphertext, secret_dek_wrapped, secret_iv, account_label, contract_version, webhook_token, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), datetime('now'))
		 ON CONFLICT(user_id, endpoint, account_id) DO UPDATE SET
		   secret_ciphertext = excluded.secret_ciphertext,
		   secret_dek_wrapped = excluded.secret_dek_wrapped,
		   secret_iv = excluded.secret_iv,
		   account_label = excluded.account_label,
		   contract_version = excluded.contract_version,
		   updated_at = datetime('now')`,
	)
		.bind(input.userId, input.endpoint, accountId, ciphertext, dekWrapped, iv, input.accountLabel ?? null, input.contractVersion ?? null, webhookToken)
		.run();
	return { webhookToken };
}

/** Update only the recorded contract version — called after a standalone test probe, so a
 *  connection's "what it claims to speak" stays current without re-pasting the secret. */
export async function updateEmailWorkerContractVersion(env: Env, userId: string, endpoint: string, accountId: string, contractVersion: string): Promise<void> {
	await env.DB.prepare("UPDATE email_worker_connections SET contract_version = ?4, updated_at = datetime('now') WHERE user_id = ?1 AND endpoint = ?2 AND account_id = ?3")
		.bind(userId, endpoint, accountId, contractVersion)
		.run();
}

/** Forget one connection. Returns false when there was nothing to forget. */
export async function deleteEmailWorkerConnection(env: Env, userId: string, endpoint: string, accountId: string = ""): Promise<boolean> {
	const res = await env.DB.prepare("DELETE FROM email_worker_connections WHERE user_id = ?1 AND endpoint = ?2 AND account_id = ?3")
		.bind(userId, endpoint, accountId)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/** The decrypted bearer secret for one connection, or null if there is none / decryption fails.
 *  Never logged, never returned by a route — lives only on its way into an Authorization header. */
export async function resolveEmailWorkerSecret(env: Env, userId: string, endpoint: string, accountId: string = ""): Promise<string | null> {
	if (!env.KEY_ENCRYPTION_KEY) return null;
	try {
		const row = await env.DB.prepare(
			"SELECT secret_ciphertext, secret_dek_wrapped, secret_iv FROM email_worker_connections WHERE user_id = ?1 AND endpoint = ?2 AND account_id = ?3",
		)
			.bind(userId, endpoint, accountId)
			.first<{ secret_ciphertext: ArrayBuffer; secret_dek_wrapped: ArrayBuffer; secret_iv: ArrayBuffer }>();
		if (!row) return null;
		return await decryptKey(new Uint8Array(row.secret_ciphertext), new Uint8Array(row.secret_dek_wrapped), new Uint8Array(row.secret_iv), env.KEY_ENCRYPTION_KEY);
	} catch {
		return null;
	}
}

/** Strip query/fragment and lowercase the host, exactly like `normalizeMcpEndpoint` — same
 *  discipline, so a credential or a pin cannot be dodged onto a second bucket with `?v=2`. */
export function normalizeEmailWorkerEndpoint(raw: string): string {
	const u = new URL(raw);
	u.search = "";
	u.hash = "";
	u.hostname = u.hostname.toLowerCase();
	return u.toString().replace(/\/$/, "");
}

function makeWebhookToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Per-instance pin: which ONE connection this instance uses ────────────────────────────────

/** The compound identity of a connection, as stored in an instance's pin. */
export interface EmailWorkerPin {
	endpoint: string;
	accountId: string;
}

/** `agent_instances.config.emailWorkerAccount`, if it names a well-formed pin. */
export function pinnedEmailWorkerConnectionFrom(config: unknown): EmailWorkerPin | undefined {
	if (typeof config !== "object" || config === null) return undefined;
	const raw = (config as { emailWorkerAccount?: unknown }).emailWorkerAccount;
	if (typeof raw !== "object" || raw === null) return undefined;
	const endpoint = (raw as { endpoint?: unknown }).endpoint;
	const accountId = (raw as { accountId?: unknown }).accountId;
	if (typeof endpoint !== "string" || !endpoint.trim()) return undefined;
	return { endpoint, accountId: typeof accountId === "string" ? accountId : "" };
}

export async function pinnedEmailWorkerConnectionFor(env: Env, instanceId: string | undefined): Promise<EmailWorkerPin | undefined> {
	if (!instanceId) return undefined;
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1").bind(instanceId).first<{ config: string | null }>();
	if (!row?.config) return undefined;
	try {
		return pinnedEmailWorkerConnectionFrom(JSON.parse(row.config));
	} catch {
		return undefined;
	}
}

export type EmailWorkerResolution =
	| { ok: true; endpoint: string; accountId: string; label: string }
	| { ok: false; reason: "not_connected" | "ambiguous" | "pinned_account_gone"; message: string };

/** The minimal shape {@link resolveEmailWorkerConnectionFrom} needs — satisfied by both the
 *  internal D1 row and the public, credential-free {@link EmailWorkerConnectionInfo}, so a route
 *  that already listed connections for display can resolve against the SAME values it rendered
 *  rather than re-querying in a shape only this module can name. */
export interface EmailWorkerAccountLike {
	endpoint: string;
	accountId: string;
	accountLabel: string | null;
}

function describeAccount(r: EmailWorkerAccountLike): string {
	return r.accountLabel?.trim() || `${r.endpoint}${r.accountId ? ` (${r.accountId})` : ""}`;
}

/**
 * Which connection a call from THIS instance should use. PURE decision over the accounts the
 * caller supplies, so it is testable without a database — same shape as
 * {@link resolveConnectorAccount}.
 *
 * Refuses rather than picks with more than one connection and no pin; a stale pin (naming a
 * connection the owner has since revoked) refuses rather than falling back to another. See the
 * module header for why: a wrong-mailbox pick here is not a degraded answer, it is mail read or
 * sent under the wrong name.
 */
export function resolveEmailWorkerConnectionFrom(accounts: readonly EmailWorkerAccountLike[], pinned: EmailWorkerPin | undefined): EmailWorkerResolution {
	if (accounts.length === 0) {
		return { ok: false, reason: "not_connected", message: "No worker-backed email connection is configured." };
	}
	if (pinned) {
		const match = accounts.find((r) => r.endpoint === pinned.endpoint && r.accountId === pinned.accountId);
		if (match) return { ok: true, endpoint: match.endpoint, accountId: match.accountId, label: describeAccount(match) };
		return {
			ok: false,
			reason: "pinned_account_gone",
			message: `This agent is set to use the worker-backed email connection "${pinned.endpoint}", which is no longer connected. Reconnect it, or choose a different connection for this agent in its Settings.`,
		};
	}
	if (accounts.length === 1) return { ok: true, endpoint: accounts[0].endpoint, accountId: accounts[0].accountId, label: describeAccount(accounts[0]) };
	return {
		ok: false,
		reason: "ambiguous",
		message:
			`You have ${accounts.length} worker-backed email connections configured and this agent is not set to use one of them: ` +
			`${accounts.map(describeAccount).join(", ")}. Choose which connection this agent should use in its Settings — nothing is read or sent until you do.`,
	};
}

/** {@link resolveEmailWorkerConnectionFrom}, reading its own inputs from D1. */
export async function resolveEmailWorkerConnection(env: Env, userId: string, instanceId: string | undefined): Promise<EmailWorkerResolution> {
	const [rows, pinned] = await Promise.all([
		env.DB.prepare("SELECT endpoint, account_id, account_label FROM email_worker_connections WHERE user_id = ?1")
			.bind(userId)
			.all<{ endpoint: string; account_id: string; account_label: string | null }>()
			.then((r) => (r.results ?? []).map((row) => ({ endpoint: row.endpoint, accountId: row.account_id ?? "", accountLabel: row.account_label }))),
		pinnedEmailWorkerConnectionFor(env, instanceId),
	]);
	return resolveEmailWorkerConnectionFrom(rows, pinned);
}

// ── Inbound dedupe (#1269 AC5) ────────────────────────────────────────────────────────────────

/** Find the connection a webhook token belongs to, or null for an unrecognised/revoked token. */
export async function connectionForWebhookToken(
	env: Env,
	token: string,
): Promise<{ userId: string; endpoint: string; accountId: string; label: string } | null> {
	const row = await env.DB.prepare("SELECT user_id, endpoint, account_id, account_label FROM email_worker_connections WHERE webhook_token = ?1")
		.bind(token)
		.first<{ user_id: string; endpoint: string; account_id: string; account_label: string | null }>();
	if (!row) return null;
	return { userId: row.user_id, endpoint: row.endpoint, accountId: row.account_id ?? "", label: row.account_label?.trim() || row.endpoint };
}

/** Record one inbound provider event as seen. Returns true the FIRST time an event id is
 *  recorded for this connection, false on a repeat — so a caller writes an audit receipt once
 *  and fires anything downstream once, however many times the Worker retries the delivery. */
export async function recordInboundEventOnce(env: Env, userId: string, endpoint: string, accountId: string, providerEventId: string): Promise<boolean> {
	const res = await env.DB.prepare(
		"INSERT OR IGNORE INTO email_worker_inbound_events (user_id, endpoint, account_id, provider_event_id) VALUES (?1, ?2, ?3, ?4)",
	)
		.bind(userId, endpoint, accountId, providerEventId)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}
