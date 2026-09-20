// Per-instance write-consent for connector tools (issue #90). Reads are allowed
// once a connector is connected; writes require an explicit consent row. All queries
// parameterized. See migrations 0051 (the row) and 0155 (its `mode`).
import type { ConsentMode, ConsentRow } from "../agent-types.js";
import type { Env } from "../types.js";

export type ConnectorScope = "write";

/**
 * `ConsentMode` and `ConsentRow` are declared in the import-free `agent-types.ts` and re-exported
 * here, where their queries live, so existing importers are unchanged. They are declared there
 * because this module imports `Env` — which names `D1Database` and the rest of the Workers
 * globals — and the console's type-parity test has to import the producer of a shape to compare
 * against it. See the note on `ConsentRow` for the whole argument.
 */
export type { ConsentMode, ConsentRow };

/** The stored value is text, so a row can carry anything; anything unrecognised reads as the
 *  safe end. A row that says something we do not understand must not dispatch silently. */
export function normalizeConsentMode(raw: unknown): ConsentMode {
	return raw === "ask" ? "ask" : "always";
}

/**
 * The consent verdict for one (instance, connector, scope): the mode, or `null` for "no row".
 *
 * Fail-closed on ANY uncertainty — no instance context, no row, or a store that threw — because
 * this is the answer `runRegistryTool` turns into "may this agent act with your credential".
 * `null` and a thrown query are the same answer on purpose: a gate that opens when its store
 * hiccups is not a gate.
 */
export async function consentModeFor(
	env: Env,
	instanceId: string | undefined,
	connector: string,
	scope: ConnectorScope,
): Promise<ConsentMode | null> {
	if (!instanceId) return null;
	try {
		const row = await env.DB.prepare(
			"SELECT mode FROM instance_connector_consent WHERE instance_id = ?1 AND connector = ?2 AND scope = ?3",
		).bind(instanceId, connector, scope).first<{ mode: string | null }>();
		return row ? normalizeConsentMode(row.mode) : null;
	} catch {
		return null;
	}
}

/**
 * Does this instance have consent for <connector> <scope>? Fail-closed on any error.
 *
 * Deliberately TRUE for `ask` as well as `always`: this answers "has the owner granted this
 * connector", which is what the tool listing reports and what a revocation removes. WHETHER a
 * given call dispatches is a second question, and `consentModeFor` is the one that answers it —
 * folding the two together would report an ask-mode tool as unavailable in the console while it
 * is in fact available and merely queued.
 */
export async function hasConsent(
	env: Env,
	instanceId: string | undefined,
	connector: string,
	scope: ConnectorScope,
): Promise<boolean> {
	return (await consentModeFor(env, instanceId, connector, scope)) !== null;
}

/**
 * Grant a write consent, or re-set the mode of one that exists.
 *
 * This is the EXPLICIT path: the owner named the position they want. Use {@link ensureConsent}
 * for a grant implied by some other action — that one must not overwrite a mode nobody asked it
 * to touch.
 */
export async function setConsent(
	env: Env,
	instanceId: string,
	userId: string,
	connector: string,
	scope: ConnectorScope,
	mode: ConsentMode = "always",
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO instance_connector_consent (instance_id, user_id, connector, scope, mode)
		 VALUES (?1, ?2, ?3, ?4, ?5)
		 ON CONFLICT(instance_id, connector, scope) DO UPDATE SET mode = excluded.mode`,
	).bind(instanceId, userId, connector, scope, mode).run();
}

/**
 * Grant a write consent only if there is not one already — never touching an existing row's mode.
 *
 * For grants that are IMPLIED by another action rather than chosen. Granting one MCP server, for
 * instance, satisfies the outer `mcp` write gate as a side effect; with a plain upsert that side
 * effect would also silently reset a connector the owner had deliberately set to "Ask each time"
 * back to "Always allow" — quietly removing a gate as a consequence of an unrelated click, which
 * is the one thing a consent store must never do.
 */
export async function ensureConsent(env: Env, instanceId: string, userId: string, connector: string, scope: ConnectorScope): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO instance_connector_consent (instance_id, user_id, connector, scope, mode)
		 VALUES (?1, ?2, ?3, ?4, 'always')
		 ON CONFLICT(instance_id, connector, scope) DO NOTHING`,
	).bind(instanceId, userId, connector, scope).run();
}

export async function revokeConsent(env: Env, instanceId: string, connector: string, scope: ConnectorScope): Promise<void> {
	await env.DB.prepare(
		"DELETE FROM instance_connector_consent WHERE instance_id = ?1 AND connector = ?2 AND scope = ?3",
	).bind(instanceId, connector, scope).run();
}

export async function listConsents(env: Env, instanceId: string): Promise<ConsentRow[]> {
	const res = await env.DB.prepare(
		"SELECT instance_id, user_id, connector, scope, mode, created_at FROM instance_connector_consent WHERE instance_id = ?1",
	).bind(instanceId).all<ConsentRow>();
	return (res.results ?? []).map((r) => ({ ...r, mode: normalizeConsentMode(r.mode) }));
}

/** Admin: every connector consent across all users (with owner login). */
export async function listAllConsents(env: Env): Promise<Array<ConsentRow & { owner_login: string | null }>> {
	const res = await env.DB.prepare(
		`SELECT c.instance_id, c.user_id, c.connector, c.scope, c.mode, c.created_at, u.github_login AS owner_login
		 FROM instance_connector_consent c LEFT JOIN users u ON u.id = c.user_id
		 ORDER BY c.created_at DESC`,
	).all<ConsentRow & { owner_login: string | null }>();
	// The admin panel reports what a grant PERMITS; a grant that queues its calls for approval is
	// a materially different grant from one that dispatches them, so the mode travels with it.
	return (res.results ?? []).map((r) => ({ ...r, mode: normalizeConsentMode(r.mode) }));
}
