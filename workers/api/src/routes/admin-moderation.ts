import { Hono } from "hono";
import type { Context } from "hono";
import { recordAdminAction } from "../lib/admin.js";
import { agentDeleteStatements, countAgentSubscribers, hasSubscriberRows } from "../lib/agent-cascade.js";
import { HttpError, requireAdmin } from "../lib/auth.js";
import { retireSubscriptionSql } from "../lib/subscription-standing.js";
import type { Env, SessionPayload } from "../types.js";

/**
 * Operator moderation (epic: PAGS Admin Portal, issue #34). Mounted at /v1/admin.
 *
 * These are the platform's destructive levers, and they deliberately break the
 * tenant-isolation invariant every other route upholds (`user_id`/`owner_id` scoping),
 * so the safety properties are load-bearing rather than decorative:
 *
 *  1. EVERY handler calls `requireAdmin` itself. Not once in shared middleware — a
 *     route that forgets a middleware still 200s, whereas a route that forgets this
 *     line fails its own test (there is a per-route non-admin assertion).
 *  2. EVERY successful mutation writes exactly one `admin_audit_log` row, including
 *     the before-state, so an action is reconstructable after the fact. Note that
 *     `recordAdminAction` is best-effort by design; auditing must not break the action.
 *  3. Destructive actions name their target EXPLICITLY. There is no filter-shaped
 *     delete, and the agent delete additionally requires the caller to echo the slug —
 *     a mistyped id then 404s or 400s instead of destroying a different agent.
 *  4. All SQL is parameterized; no id is ever interpolated.
 *  5. No secret is ever read or returned. Key revocation deletes by provider name and
 *     never decrypts.
 *
 * Issue #108 (Cloudflare Access on the /v1/admin perimeter) is still OPEN, so nothing
 * upstream can be assumed to be guarding these routes. They are safe on their own.
 */
export const adminModerationRoutes = new Hono<{ Bindings: Env }>();

/** Roles an operator may grant. A closed set — `roles` is a free-form JSON column, and
 *  an unchecked write would let a typo mint a role nothing recognises (or a made-up one
 *  a future check might honour). */
const ASSIGNABLE_ROLES = new Set(["user", "creator", "admin"]);

/** Parse a JSON body, tolerating an absent/empty one (DELETE often has none). */
async function body(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown>> {
	try {
		const v = await c.req.json();
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Load a user or 404. Returns only non-secret columns. */
async function loadUser(env: Env, id: string) {
	const row = await env.DB.prepare(
		"SELECT id, github_login, roles, suspended FROM users WHERE id = ?1",
	).bind(id).first<{ id: string; github_login: string; roles: string | null; suspended: number | null }>();
	if (!row) throw new HttpError(404, "User not found");
	return row;
}

function parseRoles(raw: string | null): string[] {
	try {
		const v = JSON.parse(raw ?? "");
		return Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : ["user"];
	} catch {
		return ["user"];
	}
}

/** Refuse an action the operator would aim at themselves. Suspending or demoting your
 *  own account locks the only operator out of the portal that fixes it — and with
 *  `requireAdmin` reading the LIVE `users.roles`, that takes effect immediately. */
function notSelf(actor: SessionPayload, targetId: string, what: string): void {
	if (actor.uid === targetId) throw new HttpError(400, `Refusing to ${what} your own account`);
}

// ── Users ──────────────────────────────────────────────────────────────────

/**
 * POST /v1/admin/users/:id/suspend { reason? } — block an account at requireUser.
 * Reversible; the reason is stored and audited so the decision is reviewable later.
 */
adminModerationRoutes.post("/users/:id/suspend", async (c) => {
	const actor = await requireAdmin(c);
	const id = c.req.param("id");
	notSelf(actor, id, "suspend");
	const user = await loadUser(c.env, id);
	// Read the body ONCE — a second c.req.json() on a consumed stream silently yields {}.
	const rawReason = (await body(c)).reason;
	const reason = typeof rawReason === "string" ? rawReason.slice(0, 500) : null;

	await c.env.DB.prepare(
		`UPDATE users SET suspended = 1, suspended_at = datetime('now'), suspended_reason = ?2,
		        updated_at = datetime('now') WHERE id = ?1`,
	).bind(id, reason).run();

	await recordAdminAction(c.env, actor, "user.suspend", { type: "user", id }, {
		login: user.github_login,
		reason,
		wasSuspended: !!user.suspended,
	});
	return c.json({ success: true, id, suspended: true, reason });
});

/** POST /v1/admin/users/:id/unsuspend — restore access. */
adminModerationRoutes.post("/users/:id/unsuspend", async (c) => {
	const actor = await requireAdmin(c);
	const id = c.req.param("id");
	const user = await loadUser(c.env, id);

	await c.env.DB.prepare(
		`UPDATE users SET suspended = 0, suspended_at = NULL, suspended_reason = NULL,
		        updated_at = datetime('now') WHERE id = ?1`,
	).bind(id).run();

	await recordAdminAction(c.env, actor, "user.unsuspend", { type: "user", id }, {
		login: user.github_login,
		wasSuspended: !!user.suspended,
	});
	return c.json({ success: true, id, suspended: false });
});

/**
 * PUT /v1/admin/users/:id/roles { roles: ["user","creator"] } — set the full role list.
 *
 * Set, not patch: a grant/revoke pair would need its own semantics for "revoke a role
 * that isn't there", and the operator UI already knows the current list. `user` is
 * always implied so a role write can't leave an account with no baseline role.
 * Takes effect on the NEXT REQUEST, not the next sign-in: `isAdmin`/`requireCreator`
 * read `users.roles` live precisely so a revoke doesn't wait 30 days for token expiry.
 */
adminModerationRoutes.put("/users/:id/roles", async (c) => {
	const actor = await requireAdmin(c);
	const id = c.req.param("id");
	const user = await loadUser(c.env, id);
	const raw = (await body(c)).roles;
	if (!Array.isArray(raw)) throw new HttpError(400, "roles must be an array");
	const roles = [...new Set(["user", ...raw.map((r) => String(r))])];
	for (const r of roles) {
		if (!ASSIGNABLE_ROLES.has(r)) throw new HttpError(400, `Unknown role: ${r}`);
	}
	const before = parseRoles(user.roles);
	// Self-demotion is the one role change that can lock the operator out mid-request.
	if (actor.uid === id && before.includes("admin") && !roles.includes("admin")) {
		throw new HttpError(400, "Refusing to remove your own admin role");
	}

	await c.env.DB.prepare("UPDATE users SET roles = ?2, updated_at = datetime('now') WHERE id = ?1")
		.bind(id, JSON.stringify(roles))
		.run();

	await recordAdminAction(c.env, actor, "user.roles", { type: "user", id }, {
		login: user.github_login,
		before,
		after: roles,
	});
	return c.json({ success: true, id, roles });
});

/**
 * POST /v1/admin/users/:id/keys/revoke { provider } — delete one stored provider key.
 *
 * The provider is REQUIRED and there is no wildcard: "revoke everything" would be one
 * omitted field away from wiping every key a user owns. The key is deleted, never
 * decrypted or returned — an operator has no business seeing a subscriber's secret,
 * and the audit row records only the provider name.
 */
adminModerationRoutes.post("/users/:id/keys/revoke", async (c) => {
	const actor = await requireAdmin(c);
	const id = c.req.param("id");
	await loadUser(c.env, id);
	const provider = (await body(c)).provider;
	if (typeof provider !== "string" || !provider.trim()) throw new HttpError(400, "provider is required");

	const res = await c.env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = ?2")
		.bind(id, provider.trim())
		.run();
	const revoked = res.meta?.changes ?? 0;
	if (!revoked) throw new HttpError(404, `No stored key for provider '${provider}'`);

	await recordAdminAction(c.env, actor, "user.key.revoke", { type: "user", id }, { provider: provider.trim() });
	return c.json({ success: true, id, provider: provider.trim(), revoked });
});

// ── Agents ─────────────────────────────────────────────────────────────────

/** POST /v1/admin/agents/:id/unpublish — pull an agent from the public catalog
 *  (visibility → draft). Non-destructive: the agent, its config and its instances
 *  survive, so this is the right first response to a bad listing. */
adminModerationRoutes.post("/agents/:id/unpublish", async (c) => {
	const actor = await requireAdmin(c);
	const id = c.req.param("id");
	const agent = await c.env.DB.prepare("SELECT id, slug, visibility, owner_id FROM agents WHERE id = ?1")
		.bind(id)
		.first<{ id: string; slug: string; visibility: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");

	await c.env.DB.prepare("UPDATE agents SET visibility = 'draft', updated_at = datetime('now') WHERE id = ?1")
		.bind(id)
		.run();

	await recordAdminAction(c.env, actor, "agent.unpublish", { type: "agent", id }, {
		slug: agent.slug,
		ownerId: agent.owner_id,
		before: agent.visibility,
		after: "draft",
	});
	return c.json({ success: true, id, visibility: "draft" });
});

/**
 * DELETE /v1/admin/agents/:id?confirm=<slug>&force=true — operator delete.
 *
 * Two guards, both because this is irreversible and cross-tenant:
 *  - `confirm` must equal the agent's own slug. A mistyped id then fails loudly
 *    instead of deleting a different creator's agent.
 *  - an agent with ANY subscriber rows is refused unless `force` — deleting it silently
 *    strands paying subscribers on a template that no longer exists. With `force`,
 *    those rows are removed in the same batch.
 *
 * Separate from the owner-or-admin DELETE in agents.ts on purpose: that one trusts
 * `session.roles`, which only sees the role baked into a token, while this goes
 * through `requireAdmin` (live roles + allowlist) and audits. THIS is the only route
 * allowed to destroy another tenant's instance rows, which is why the owner route now
 * refuses that case and points here (#646).
 *
 * The count that gates it is every instance, not just the `'active'` ones. Cancelling
 * an instance does not remove its row, and the row is what holds the foreign key — so
 * gating on `active > 0` meant `force=true` returned a 500 on exactly the agents it
 * exists for, and an agent whose instances were all cancelled skipped the guard and
 * then failed the batch anyway.
 */
adminModerationRoutes.delete("/agents/:id", async (c) => {
	const actor = await requireAdmin(c);
	const id = c.req.param("id");
	const b = await body(c);
	const confirm = String(b.confirm ?? c.req.query("confirm") ?? "");
	const force = b.force === true || c.req.query("force") === "true";

	const agent = await c.env.DB.prepare("SELECT id, slug, name, owner_id FROM agents WHERE id = ?1")
		.bind(id)
		.first<{ id: string; slug: string; name: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	if (confirm !== agent.slug) {
		throw new HttpError(400, `Confirmation required: pass confirm='${agent.slug}' to delete this agent`);
	}

	const counts = await countAgentSubscribers(c.env.DB, id, agent.owner_id);
	const subscribed = hasSubscriberRows(counts);
	if (subscribed && !force) {
		throw new HttpError(
			409,
			`Agent has ${counts.instances} instance(s) (${counts.activeInstances} active) and ` +
				`${counts.subscriptions} subscription(s); pass force=true to remove them and delete`,
		);
	}

	await c.env.DB.batch(agentDeleteStatements(c.env.DB, id, { cascadeSubscribers: subscribed }));

	await recordAdminAction(c.env, actor, "agent.delete", { type: "agent", id }, {
		slug: agent.slug,
		name: agent.name,
		ownerId: agent.owner_id,
		// `canceledInstances` keeps its name: the operator portal and its e2e spec read that field.
		// It has always meant "the live subscriptions this delete ended", which is still what it is
		// — those rows are now removed rather than left behind holding a foreign key.
		canceledInstances: counts.activeInstances,
		removedInstances: counts.instances,
		removedSubscriptions: counts.subscriptions,
		forced: force,
	});
	return c.json({
		success: true,
		id,
		canceledInstances: counts.activeInstances,
		removedInstances: counts.instances,
		removedSubscriptions: counts.subscriptions,
	});
});

// ── Instances ──────────────────────────────────────────────────────────────

/**
 * POST /v1/admin/instances/:id/cancel { reason? } — operator cancel of a runaway or
 * abusive subscription. Addressed by instance id only: no agent-wide or owner-wide
 * cancel, because one wrong character in a filter would retire every subscription in
 * the blast radius. The owner's own cancel route stays untouched.
 */
adminModerationRoutes.post("/instances/:id/cancel", async (c) => {
	const actor = await requireAdmin(c);
	const id = c.req.param("id");
	const reason = (await body(c)).reason;

	const inst = await c.env.DB.prepare(
		"SELECT id, agent_id, user_id, status FROM agent_instances WHERE id = ?1",
	).bind(id).first<{ id: string; agent_id: string; user_id: string; status: string }>();
	if (!inst) throw new HttpError(404, "Instance not found");

	// The `subscriptions` row is shared by every instance of this agent the owner holds (#669), so
	// an operator cancelling ONE runaway instance must not retire the standing of the others. Same
	// statement the owner's own cancel uses — a second spelling here is how the two routes came to
	// disagree about what cancelling means in the first place.
	await c.env.DB.batch([
		c.env.DB.prepare(
			"UPDATE agent_instances SET status = 'canceled', updated_at = datetime('now') WHERE id = ?1",
		).bind(id),
		c.env.DB.prepare(retireSubscriptionSql()).bind(inst.agent_id, inst.user_id, id),
	]);

	await recordAdminAction(c.env, actor, "instance.cancel", { type: "instance", id }, {
		agentId: inst.agent_id,
		ownerId: inst.user_id,
		before: inst.status,
		reason: typeof reason === "string" ? reason.slice(0, 500) : null,
	});
	return c.json({ success: true, id, status: "canceled" });
});
