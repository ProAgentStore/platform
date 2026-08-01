import { Hono } from "hono";
import { HttpError, requireAdmin } from "../lib/auth.js";
import type { Env } from "../types.js";

/**
 * Admin "Coding session detail" — a single coding_sessions row plus its joins and
 * its persisted append-only timeline. Behind the admin gate (network perimeter is
 * the /v1/admin/* Cloudflare Access middleware in index.ts; this enforces the ROLE).
 *
 * Cross-tenant on purpose: this is the operator view, so it is NOT owner-scoped
 * (unlike the per-user /v1/instances/:id/coding routes). All SQL is parameterized.
 */
export const adminCodingSessionRoutes = new Hono<{ Bindings: Env }>();

interface SessionRow {
	id: string;
	instance_id: string;
	repo_id: string;
	user_id: string;
	runner_node: string | null;
	client_type: string;
	status: string;
	issue_number: number | null;
	issue_title: string | null;
	launch_command: string | null;
	started_at: string;
	updated_at: string;
	repo_name: string | null;
	owner_login: string | null;
}

interface TimelineRow {
	seq: number;
	type: string;
	content: string;
	created_at: string;
}

/**
 * GET /coding-sessions/:sid → the session (with joined repo name + owner login) and
 * the last ~100 timeline entries (seq-ordered, oldest→newest). 404 if unknown.
 *
 * NOTE on columns: coding_sessions has no `created_at`; the create stamp is
 * `started_at` (migration 0020). `launch_command` = 0028, `runner_node` = 0040.
 */
adminCodingSessionRoutes.get("/coding-sessions/:sid", async (c) => {
	await requireAdmin(c);
	const sid = c.req.param("sid");

	const session = await c.env.DB.prepare(
		`SELECT s.id, s.instance_id, s.repo_id, s.user_id, s.runner_node, s.client_type,
		        s.status, s.issue_number, s.issue_title, s.launch_command,
		        s.started_at, s.updated_at,
		        r.name AS repo_name, u.github_login AS owner_login
		 FROM coding_sessions s
		 LEFT JOIN coding_repos r ON r.id = s.repo_id
		 LEFT JOIN agent_instances i ON i.id = s.instance_id
		 LEFT JOIN users u ON u.id = i.user_id
		 WHERE s.id = ?1`,
	)
		.bind(sid)
		.first<SessionRow>();

	if (!session) throw new HttpError(404, "Coding session not found");

	// Last ~100 timeline entries, seq-DESC then reversed to oldest→newest for display.
	const { results } = await c.env.DB.prepare(
		`SELECT seq, type, content, created_at
		 FROM coding_timeline
		 WHERE session_id = ?1
		 ORDER BY seq DESC
		 LIMIT 100`,
	)
		.bind(sid)
		.all<TimelineRow>();
	const timeline = (results ?? [])
		.map((r) => ({ seq: r.seq, type: r.type, content: r.content, createdAt: r.created_at }))
		.reverse();

	return c.json({
		session: {
			id: session.id,
			instanceId: session.instance_id,
			repoId: session.repo_id,
			userId: session.user_id,
			runnerNode: session.runner_node,
			engine: session.client_type,
			status: session.status,
			issueNumber: session.issue_number,
			issueTitle: session.issue_title,
			launchCommand: session.launch_command,
			startedAt: session.started_at,
			updatedAt: session.updated_at,
			repoName: session.repo_name,
			ownerLogin: session.owner_login,
		},
		timeline,
	});
});
