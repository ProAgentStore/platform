import { Hono } from "hono";
import { HttpError, requireAdmin } from "../lib/auth.js";
import type { Env } from "../types.js";

/**
 * Admin "Instance detail" drill-down (companion to the /v1/admin/instances list in
 * admin.ts). Mounted at /v1/admin so the final URL is /v1/admin/instances/:id/detail.
 * The `/detail` suffix keeps it from colliding with the list router's /instances.
 *
 * Every route is behind requireAdmin. All SQL is parameterized. We never decrypt or
 * return any secret/token/credential — `config` is returned verbatim because it holds
 * only client-side prefs (no secrets), and we explicitly omit the runtime-node token
 * columns (token_ciphertext / token_dek_wrapped / token_iv / token_plaintext).
 */
export const adminInstanceDetailRoutes = new Hono<{ Bindings: Env }>();

interface InstanceRow {
	id: string;
	agent_id: string;
	user_id: string;
	status: string;
	config: string;
	created_at: string;
	updated_at: string;
	agent_name: string | null;
	agent_slug: string | null;
	owner_login: string | null;
}

/** GET /v1/admin/instances/:id/detail — one instance's full operational picture. */
adminInstanceDetailRoutes.get("/instances/:id/detail", async (c) => {
	await requireAdmin(c);
	const id = c.req.param("id");

	// Core row + joined agent + owner login. All scoped by the instance id.
	const instance = await c.env.DB.prepare(
		`SELECT i.id, i.agent_id, i.user_id, i.status, i.config, i.created_at, i.updated_at,
		        a.name AS agent_name, a.slug AS agent_slug,
		        u.github_login AS owner_login
		 FROM agent_instances i
		 LEFT JOIN agents a ON a.id = i.agent_id
		 LEFT JOIN users u ON u.id = i.user_id
		 WHERE i.id = ?1`,
	).bind(id).first<InstanceRow>();
	if (!instance) throw new HttpError(404, "Instance not found");

	const ownerId = instance.user_id;

	const [nodes, board, consents, errors, usage] = await Promise.all([
		// Runtime nodes — token columns deliberately omitted (never expose secrets).
		c.env.DB.prepare(
			`SELECT runner_node, placement, status, last_seen_at, runner_version, capabilities, created_at, updated_at
			 FROM instance_runtime_nodes
			 WHERE instance_id = ?1
			 ORDER BY updated_at DESC`,
		).bind(id).all<{
			runner_node: string;
			placement: string;
			status: string;
			last_seen_at: string | null;
			runner_version: string;
			capabilities: string;
			created_at: string;
			updated_at: string;
		}>(),

		// Board items for this instance (the durable job/kanban cards).
		c.env.DB.prepare(
			`SELECT job_key, user_status, title, subtitle, url, updated_at
			 FROM board_items
			 WHERE instance_id = ?1
			 ORDER BY updated_at DESC`,
		).bind(id).all<{
			job_key: string;
			user_status: string | null;
			title: string;
			subtitle: string;
			url: string;
			updated_at: string;
		}>(),

		// Connector write-consents granted to this instance.
		c.env.DB.prepare(
			`SELECT connector, scope, created_at
			 FROM instance_connector_consent
			 WHERE instance_id = ?1
			 ORDER BY created_at DESC`,
		).bind(id).all<{ connector: string; scope: string; created_at: string }>(),

		// Recent errors for the instance owner (error_log has no instance_id column;
		// last 20 rows for the owner's user_id, per the spec).
		c.env.DB.prepare(
			`SELECT id, created_at, source, status, message, context
			 FROM error_log
			 WHERE user_id = ?1
			 ORDER BY created_at DESC
			 LIMIT 20`,
		).bind(ownerId).all<{
			id: string;
			created_at: string;
			source: string;
			status: number | null;
			message: string;
			context: string | null;
		}>(),

		// 30-day usage/cost rollup, scoped to this instance.
		c.env.DB.prepare(
			`SELECT COUNT(*) AS calls,
			        COALESCE(SUM(input_tokens), 0) AS input_tokens,
			        COALESCE(SUM(output_tokens), 0) AS output_tokens,
			        COALESCE(SUM(cost_micros), 0) AS cost_micros
			 FROM ai_usage
			 WHERE instance_id = ?1 AND created_at >= ?2`,
		).bind(id, thirtyDaysAgo()).first<{
			calls: number;
			input_tokens: number;
			output_tokens: number;
			cost_micros: number;
		}>(),
	]);

	return c.json({
		instance: {
			id: instance.id,
			agent_id: instance.agent_id,
			user_id: instance.user_id,
			status: instance.status,
			config: instance.config,
			created_at: instance.created_at,
			updated_at: instance.updated_at,
			agent_name: instance.agent_name,
			agent_slug: instance.agent_slug,
			owner_login: instance.owner_login,
		},
		runtimeNodes: nodes.results ?? [],
		boardItems: board.results ?? [],
		consents: consents.results ?? [],
		recentErrors: errors.results ?? [],
		usage30d: usage ?? { calls: 0, input_tokens: 0, output_tokens: 0, cost_micros: 0 },
	});
});

/** SQLite "YYYY-MM-DD HH:MM:SS" timestamp 30 days ago (matches datetime('now') format). */
function thirtyDaysAgo(): string {
	return new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}
