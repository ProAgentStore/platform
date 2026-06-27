import type { Env } from "../types.js";

/**
 * Cloudflare Named Tunnel provisioning — production-grade replacement for
 * quick tunnels (trycloudflare.com). Creates a per-user tunnel under the
 * PAGS CF account, configures ingress, creates a DNS CNAME, and returns
 * the connector token the CLI hands to `cloudflared tunnel run --token`.
 *
 * Requires env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_TUNNEL_TOKEN (an API
 * token with Cloudflare Tunnel:Edit + DNS:Edit permissions).
 * Zone ID is hardcoded (proagentstore.online).
 */

const ZONE_ID = "5218405cf882986cb05bfc600edbc7af";
const TUNNEL_DOMAIN = "proagentstore.online";
/** The port the runner listens on (must match the CLI's default). */
const RUNNER_PORT = 49171;

export function namedTunnelConfigured(env: Env): boolean {
	return Boolean((env as Record<string, unknown>).CLOUDFLARE_ACCOUNT_ID && (env as Record<string, unknown>).CLOUDFLARE_TUNNEL_TOKEN);
}

function accountId(env: Env): string {
	return (env as Record<string, unknown>).CLOUDFLARE_ACCOUNT_ID as string;
}

function apiToken(env: Env): string {
	return (env as Record<string, unknown>).CLOUDFLARE_TUNNEL_TOKEN as string;
}

async function cfApi(env: Env, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; result: unknown; errors?: Array<{ message: string }> }> {
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${apiToken(env)}`,
			"Content-Type": "application/json",
			...(init.headers as Record<string, string> | undefined),
		},
	});
	const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: Array<{ message: string }> };
	return { ok: data.success !== false && res.ok, status: res.status, result: data.result ?? data, errors: data.errors };
}

/** Generate a short, URL-safe identifier for tunnel names + hostnames. */
function tunnelSlug(userId: string): string {
	// Take a deterministic but short hash of the user id.
	const hash = Array.from(userId).reduce((h, c) => (((h << 5) - h) + c.charCodeAt(0)) | 0, 0);
	return `r${Math.abs(hash).toString(36).slice(0, 8)}`;
}

export interface TunnelInfo {
	tunnelId: string;
	tunnelName: string;
	hostname: string;
	connectorToken: string;
	dnsRecordId?: string;
}

/**
 * Provision a named tunnel for a user. Idempotent — returns the existing
 * tunnel if one is already provisioned. Steps:
 * 1. Create the tunnel (CF API)
 * 2. Configure ingress (route hostname → localhost:PORT)
 * 3. Create DNS CNAME (hostname → tunnelId.cfargotunnel.com)
 * 4. Fetch the connector token
 * 5. Store in D1
 */
export async function provisionTunnel(env: Env, userId: string): Promise<TunnelInfo> {
	if (!namedTunnelConfigured(env)) throw new Error("Named tunnels not configured (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_TUNNEL_TOKEN required)");

	// Check for existing tunnel
	const existing = await env.DB.prepare("SELECT tunnel_id, tunnel_name, hostname, dns_record_id FROM user_tunnels WHERE user_id = ?1 AND status = 'active'")
		.bind(userId).first<{ tunnel_id: string; tunnel_name: string; hostname: string; dns_record_id: string | null }>();
	if (existing) {
		// Tunnel exists — just fetch a fresh connector token and return.
		const token = await getConnectorToken(env, existing.tunnel_id);
		return { tunnelId: existing.tunnel_id, tunnelName: existing.tunnel_name, hostname: existing.hostname, connectorToken: token, dnsRecordId: existing.dns_record_id ?? undefined };
	}

	const slug = tunnelSlug(userId);
	const tunnelName = `pags-${slug}`;
	const hostname = `${slug}.${TUNNEL_DOMAIN}`;

	// 1. Create the tunnel
	const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
	const createRes = await cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel`, {
		method: "POST",
		body: JSON.stringify({ name: tunnelName, tunnel_secret: secret }),
	});
	if (!createRes.ok) {
		// Tunnel might already exist (name collision from a previous partial provision)
		const listRes = await cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`);
		const tunnels = Array.isArray((listRes.result as { tunnels?: unknown[] })?.tunnels)
			? (listRes.result as { tunnels: Array<{ id: string }> }).tunnels
			: Array.isArray(listRes.result) ? (listRes.result as Array<{ id: string }>) : [];
		if (!tunnels.length) throw new Error(`Failed to create tunnel: ${createRes.errors?.map(e => e.message).join(", ") || createRes.status}`);
		// Reuse the existing CF tunnel
		return finalizeTunnel(env, userId, tunnels[0].id, tunnelName, hostname);
	}
	const tunnelId = (createRes.result as { id: string }).id;
	return finalizeTunnel(env, userId, tunnelId, tunnelName, hostname);
}

async function finalizeTunnel(env: Env, userId: string, tunnelId: string, tunnelName: string, hostname: string): Promise<TunnelInfo> {
	// 2. Configure ingress
	await cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel/${tunnelId}/configurations`, {
		method: "PUT",
		body: JSON.stringify({
			config: {
				ingress: [
					{ hostname, service: `http://localhost:${RUNNER_PORT}` },
					{ service: "http_status:404" },
				],
			},
		}),
	});

	// 3. Create DNS CNAME (idempotent — skip if it already exists)
	let dnsRecordId: string | undefined;
	const dnsRes = await cfApi(env, `/zones/${ZONE_ID}/dns_records`, {
		method: "POST",
		body: JSON.stringify({
			type: "CNAME",
			name: hostname,
			content: `${tunnelId}.cfargotunnel.com`,
			proxied: true,
			comment: `PAGS runner tunnel for ${userId}`,
		}),
	});
	if (dnsRes.ok) {
		dnsRecordId = (dnsRes.result as { id?: string })?.id;
	}
	// If DNS creation failed with 409/duplicate, look it up
	if (!dnsRecordId) {
		const lookupRes = await cfApi(env, `/zones/${ZONE_ID}/dns_records?name=${encodeURIComponent(hostname)}&type=CNAME`);
		const records = Array.isArray(lookupRes.result) ? (lookupRes.result as Array<{ id: string }>) : [];
		if (records.length) dnsRecordId = records[0].id;
	}

	// 4. Fetch connector token
	const connectorToken = await getConnectorToken(env, tunnelId);

	// 5. Store in D1
	await env.DB.prepare(
		`INSERT INTO user_tunnels (user_id, tunnel_id, tunnel_name, hostname, dns_record_id, status, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, 'active', datetime('now'), datetime('now'))
		 ON CONFLICT(user_id) DO UPDATE SET
		   tunnel_id = excluded.tunnel_id,
		   tunnel_name = excluded.tunnel_name,
		   hostname = excluded.hostname,
		   dns_record_id = excluded.dns_record_id,
		   status = 'active',
		   updated_at = datetime('now')`,
	).bind(userId, tunnelId, tunnelName, hostname, dnsRecordId ?? null).run();

	return { tunnelId, tunnelName, hostname, connectorToken, dnsRecordId };
}

async function getConnectorToken(env: Env, tunnelId: string): Promise<string> {
	const res = await cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel/${tunnelId}/token`);
	if (!res.ok) throw new Error(`Failed to get connector token: ${res.errors?.map(e => e.message).join(", ") || res.status}`);
	return res.result as string;
}

/** Get the user's tunnel info (if provisioned). */
export async function getUserTunnel(env: Env, userId: string): Promise<{ tunnelId: string; hostname: string; status: string } | null> {
	return env.DB.prepare("SELECT tunnel_id, hostname, status FROM user_tunnels WHERE user_id = ?1")
		.bind(userId).first<{ tunnel_id: string; hostname: string; status: string }>() ?? null;
}

/** Delete a user's tunnel (CF API + DNS + D1). */
export async function deleteTunnel(env: Env, userId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT tunnel_id, dns_record_id FROM user_tunnels WHERE user_id = ?1")
		.bind(userId).first<{ tunnel_id: string; dns_record_id: string | null }>();
	if (!row) return false;

	// Delete DNS record
	if (row.dns_record_id) {
		await cfApi(env, `/zones/${ZONE_ID}/dns_records/${row.dns_record_id}`, { method: "DELETE" }).catch(() => undefined);
	}
	// Delete the tunnel (marks it deleted, connectors disconnect)
	await cfApi(env, `/accounts/${accountId(env)}/cfd_tunnel/${row.tunnel_id}`, { method: "DELETE" }).catch(() => undefined);
	// Remove from D1
	await env.DB.prepare("DELETE FROM user_tunnels WHERE user_id = ?1").bind(userId).run();
	return true;
}
