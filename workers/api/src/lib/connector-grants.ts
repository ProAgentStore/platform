import { HttpError } from "./auth.js";
import type { Env } from "../types.js";

export type ConnectorProvider = "google_drive" | "zoho_workdrive";

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
