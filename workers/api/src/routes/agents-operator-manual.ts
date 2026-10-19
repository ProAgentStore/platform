/**
 * The agent TEMPLATE's operator manual (#1237): caller-facing operating standards that every instance
 * of the template inherits — read live by each instance's operator-manual read, so an edit here
 * reaches all existing and future instances with no resync. Owner (or admin) only, like every other
 * write to a template. Never injected as an agent instruction; the agent reads it as data
 * (`read_operator_manual`), the same as the instance manual.
 */
import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { operatorManualTooLong } from "../lib/operator-manual.js";
import type { AgentOperatorManualResponse } from "../agent-types.js";
import type { Env } from "../types.js";

export function registerAgentOperatorManualRoutes(router: Hono<{ Bindings: Env }>): void {
	const ownedTemplate = async (c: Context<{ Bindings: Env }>) => {
		const session = await requireUser(c);
		const row = await c.env.DB.prepare("SELECT id, owner_id, operator_manual FROM agents WHERE id = ?1 OR slug = ?1")
			.bind(c.req.param("id"))
			.first<{ id: string; owner_id: string; operator_manual: string | null }>();
		if (!row) throw new HttpError(404, "Agent not found");
		if (row.owner_id !== session.uid && !session.roles.includes("admin")) throw new HttpError(403, "Not your agent");
		return row;
	};

	/** `{ manual, instances }` — the template's manual ("" when none) and how many instances inherit it. */
	router.get("/:id/operator-manual", async (c) => {
		const row = await ownedTemplate(c);
		const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM agent_instances WHERE agent_id = ?1 AND status != 'canceled'").bind(row.id).first<{ n: number }>();
		const body: AgentOperatorManualResponse = { manual: row.operator_manual ?? "", instances: n?.n ?? 0 };
		return c.json(body);
	});

	/** Replace the template's manual: `{ manual }`, at most 16,000 characters (400 above, naming the length). */
	router.put("/:id/operator-manual", async (c) => {
		const row = await ownedTemplate(c);
		const body = (await c.req.json().catch(() => ({}))) as { manual?: unknown };
		const manual = String(body.manual ?? "");
		const tooLong = operatorManualTooLong(manual);
		if (tooLong) return c.json({ error: tooLong }, 400);
		await c.env.DB.prepare("UPDATE agents SET operator_manual = ?1, updated_at = datetime('now') WHERE id = ?2").bind(manual, row.id).run();
		return c.json({ ok: true, manual });
	});
}
