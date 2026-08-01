// Per-instance write-consent for connector tools (issue #90). Reads are allowed
// once a connector is connected; writes require an explicit consent row. All queries
// parameterized. See migration 0051.
import type { Env } from "../types.js";

export type ConnectorScope = "write";

/** Does this instance have consent for <connector> <scope>? Fail-closed on any error. */
export async function hasConsent(
	env: Env,
	instanceId: string | undefined,
	connector: string,
	scope: ConnectorScope,
): Promise<boolean> {
	if (!instanceId) return false;
	try {
		const row = await env.DB.prepare(
			"SELECT 1 AS ok FROM instance_connector_consent WHERE instance_id = ?1 AND connector = ?2 AND scope = ?3",
		).bind(instanceId, connector, scope).first<{ ok: number }>();
		return !!row;
	} catch {
		return false;
	}
}

export async function setConsent(env: Env, instanceId: string, userId: string, connector: string, scope: ConnectorScope): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO instance_connector_consent (instance_id, user_id, connector, scope)
		 VALUES (?1, ?2, ?3, ?4)
		 ON CONFLICT(instance_id, connector, scope) DO NOTHING`,
	).bind(instanceId, userId, connector, scope).run();
}

export async function revokeConsent(env: Env, instanceId: string, connector: string, scope: ConnectorScope): Promise<void> {
	await env.DB.prepare(
		"DELETE FROM instance_connector_consent WHERE instance_id = ?1 AND connector = ?2 AND scope = ?3",
	).bind(instanceId, connector, scope).run();
}

export interface ConsentRow { instance_id: string; user_id: string; connector: string; scope: string; created_at: string }

export async function listConsents(env: Env, instanceId: string): Promise<ConsentRow[]> {
	const res = await env.DB.prepare(
		"SELECT instance_id, user_id, connector, scope, created_at FROM instance_connector_consent WHERE instance_id = ?1",
	).bind(instanceId).all<ConsentRow>();
	return res.results ?? [];
}

/** Admin: every connector consent across all users (with owner login). */
export async function listAllConsents(env: Env): Promise<Array<ConsentRow & { owner_login: string | null }>> {
	const res = await env.DB.prepare(
		`SELECT c.instance_id, c.user_id, c.connector, c.scope, c.created_at, u.github_login AS owner_login
		 FROM instance_connector_consent c LEFT JOIN users u ON u.id = c.user_id
		 ORDER BY c.created_at DESC`,
	).all<ConsentRow & { owner_login: string | null }>();
	return res.results ?? [];
}
