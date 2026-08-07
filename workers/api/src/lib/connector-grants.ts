import { HttpError } from "./auth.js";
import type { Env } from "../types.js";

// Widened to `string` (#86): connectors now cover resource types beyond drive/workdrive
// (repos, spreadsheets, …). The known ingest providers stay documented for reference.
// Known values: "google_drive" | "zoho_workdrive" | (any connector id with grantModel:"instance-resource").
export type ConnectorProvider = string;

export interface ConnectorGrant {
	id: string;
	instanceId: string;
	userId: string;
	provider: ConnectorProvider;
	resourceId: string;
	resourceName: string;
	resourceType: string;
	resourceUrl?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ConnectorGrantInput {
	provider: ConnectorProvider;
	resourceId: string;
	resourceName: string;
	resourceType?: string;
	resourceUrl?: string | null;
}

interface GrantRow {
	id: string;
	instance_id: string;
	user_id: string;
	provider: ConnectorProvider;
	resource_id: string;
	resource_name: string;
	resource_type: string;
	resource_url: string | null;
	created_at: string;
	updated_at: string;
}

function normalizeGrant(row: GrantRow): ConnectorGrant {
	return {
		id: row.id,
		instanceId: row.instance_id,
		userId: row.user_id,
		provider: row.provider,
		resourceId: row.resource_id,
		resourceName: row.resource_name,
		resourceType: row.resource_type,
		resourceUrl: row.resource_url,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function listConnectorGrants(
	env: Env,
	instanceId: string,
	userId: string,
	provider: ConnectorProvider,
): Promise<ConnectorGrant[]> {
	const rows = await env.DB.prepare(
		`SELECT id, instance_id, user_id, provider, resource_id, resource_name, resource_type, resource_url, created_at, updated_at
     FROM instance_connector_grants
     WHERE instance_id = ?1 AND user_id = ?2 AND provider = ?3
     ORDER BY created_at DESC`,
	)
		.bind(instanceId, userId, provider)
		.all<GrantRow>();
	return (rows.results ?? []).map(normalizeGrant);
}

export async function upsertConnectorGrant(
	env: Env,
	instanceId: string,
	userId: string,
	input: ConnectorGrantInput,
): Promise<ConnectorGrant> {
	const resourceId = input.resourceId.trim();
	if (!resourceId) throw new HttpError(400, "resourceId required");
	const name = input.resourceName.trim() || resourceId;
	const type = (input.resourceType || "folder").trim() || "folder";
	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO instance_connector_grants
       (id, instance_id, user_id, provider, resource_id, resource_name, resource_type, resource_url, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), datetime('now'))
     ON CONFLICT(instance_id, provider, resource_id) DO UPDATE SET
       resource_name = excluded.resource_name,
       resource_type = excluded.resource_type,
       resource_url = excluded.resource_url,
       updated_at = datetime('now')`,
	)
		.bind(id, instanceId, userId, input.provider, resourceId, name, type, input.resourceUrl ?? null)
		.run();
	const grant = await findConnectorGrantByResource(env, instanceId, userId, input.provider, resourceId);
	if (!grant) throw new HttpError(500, "Could not save connector grant");
	return grant;
}

export async function deleteConnectorGrant(
	env: Env,
	instanceId: string,
	userId: string,
	provider: ConnectorProvider,
	grantId: string,
): Promise<void> {
	await env.DB.prepare(
		"DELETE FROM instance_connector_grants WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND provider = ?4",
	)
		.bind(grantId, instanceId, userId, provider)
		.run();
}

/** How many grants a user holds for one connector, and across how many agents. */
export interface ConnectorGrantReach {
	grants: number;
	instances: number;
}

/**
 * The blast radius of an account-level disconnect (#357).
 *
 * Until this existed, NOTHING queried grants by (user_id, provider) — grants were only ever
 * read per instance — which is precisely why disconnecting a connector could delete the token
 * and leave every folder grant standing, invisible, ready to be re-armed by a reconnect. The
 * `(user_id, provider, created_at)` index from migration 0044 makes this cheap.
 */
export async function connectorGrantReach(
	env: Env,
	userId: string,
	provider: ConnectorProvider,
): Promise<ConnectorGrantReach> {
	const rows = await env.DB.prepare(
		"SELECT instance_id FROM instance_connector_grants WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(userId, provider)
		.all<{ instance_id: string }>();
	const results = rows.results ?? [];
	return { grants: results.length, instances: new Set(results.map((r) => r.instance_id)).size };
}

/**
 * The same blast radius, for every grant-holding connector at once (#355).
 *
 * The account page lists all connectors together, so asking `connectorGrantReach` per connector
 * would be one round trip per row to answer a question one GROUP BY answers. Providers with no
 * grants are simply absent — the caller reads a missing entry as zero, which is what it is.
 */
export async function connectorGrantReachByProvider(
	env: Env,
	userId: string,
): Promise<Map<string, ConnectorGrantReach>> {
	const rows = await env.DB.prepare(
		`SELECT provider, COUNT(*) AS grants, COUNT(DISTINCT instance_id) AS instances
     FROM instance_connector_grants WHERE user_id = ?1 GROUP BY provider`,
	)
		.bind(userId)
		.all<{ provider: string; grants: number; instances: number }>();
	return new Map(
		(rows.results ?? []).map((r) => [r.provider, { grants: Number(r.grants) || 0, instances: Number(r.instances) || 0 }]),
	);
}

/**
 * Disconnecting revokes: every grant this user made for this connector, on every agent.
 *
 * That is the meaning the product now commits to, and the confirmation says so before you
 * click. The alternative — keep the rows — is only safe if reconnecting re-asks, and it
 * didn't: it silently re-armed every grant, months later, possibly for a different account.
 *
 * Returns the reach that was revoked so the caller can report it. Counted first rather than
 * read off `meta.changes`, so the number is the same one the confirmation quoted.
 */
export async function revokeUserConnectorGrants(
	env: Env,
	userId: string,
	provider: ConnectorProvider,
): Promise<ConnectorGrantReach> {
	const reach = await connectorGrantReach(env, userId, provider);
	if (reach.grants > 0) {
		await env.DB.prepare(
			"DELETE FROM instance_connector_grants WHERE user_id = ?1 AND provider = ?2",
		)
			.bind(userId, provider)
			.run();
	}
	return reach;
}

export async function requireConnectorGrant(
	env: Env,
	instanceId: string,
	userId: string,
	provider: ConnectorProvider,
	grantId: string,
): Promise<ConnectorGrant> {
	const row = await env.DB.prepare(
		`SELECT id, instance_id, user_id, provider, resource_id, resource_name, resource_type, resource_url, created_at, updated_at
     FROM instance_connector_grants
     WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND provider = ?4`,
	)
		.bind(grantId, instanceId, userId, provider)
		.first<GrantRow>();
	if (!row) throw new HttpError(403, "Connector grant does not allow this agent to access that resource");
	return normalizeGrant(row);
}

export async function findConnectorGrantByResource(
	env: Env,
	instanceId: string,
	userId: string,
	provider: ConnectorProvider,
	resourceId: string,
): Promise<ConnectorGrant | null> {
	const row = await env.DB.prepare(
		`SELECT id, instance_id, user_id, provider, resource_id, resource_name, resource_type, resource_url, created_at, updated_at
     FROM instance_connector_grants
     WHERE instance_id = ?1 AND user_id = ?2 AND provider = ?3 AND resource_id = ?4`,
	)
		.bind(instanceId, userId, provider, resourceId)
		.first<GrantRow>();
	return row ? normalizeGrant(row) : null;
}
