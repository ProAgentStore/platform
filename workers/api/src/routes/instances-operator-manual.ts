/**
 * The operator manual (#739) and its generated half (#1109).
 *
 * Moved here from `instances-apply.ts` (verbatim, bar the generated `context`) when the GET began
 * rendering from the tool policy: `instances-apply.ts` is reached from `lib/storage-tools.ts`, and
 * importing the policy there joined `agent-do-tools.ts` to a deferred import cycle. This module is
 * mounted directly on the instance router, so nothing in the tool runtime reaches it.
 */
import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { buildOperatorGuidance } from "../lib/operator-guidance.js";
import { combinedOperatorManual, operatorManualLayers, operatorManualTooLong } from "../lib/operator-manual.js";
import { allowedToolRows } from "./instances-guide.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { OperatorManualResponse } from "../agent-types.js";
import type { Env } from "../types.js";

/** The cap, shared with the template manual (#1237): `lib/operator-manual.ts`. */
export { OPERATOR_MANUAL_MAX_CHARS } from "../lib/operator-manual.js";

export function registerOperatorManualRoutes(router: Hono<{ Bindings: Env }>): void {
	/**
	 * Read the instance's operator manual — caller-facing guidance, NOT injected as an
	 * agent instruction. Returns `{ manual, rules, context }`:
	 *   - `manual`  the stored free-text document (may be "")
	 *   - `rules`   the current specialInstructions (so a caller reading the manual also
	 *               sees the standing orders that will make the agent refuse things — the
	 *               symmetric read that makes a refusal legible)
	 *   - `context` the GENERATED operating guide (#1109): every allowed tool and how to drive
	 *               this instance, rendered on every read — never stored
	 */
	router.get("/:instanceId/operator-manual", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const instance = await requireOwnedInstance(c.env, instanceId, session.uid);
		const row = await c.env.DB.prepare(
			"SELECT operator_manual, config FROM agent_instances WHERE id = ?1 AND user_id = ?2",
		)
			.bind(instanceId, session.uid)
			.first<{ operator_manual: string | null; config: string | null }>();
		let rules = "";
		try {
			const cfg = JSON.parse(row?.config || "{}") as Record<string, unknown>;
			rules = typeof cfg.specialInstructions === "string" ? cfg.specialInstructions : "";
		} catch {
			// malformed config — rules stays ""
		}
		// `context` (#1109): the generated half — every allowed tool and how to operate this instance,
		// rendered on every read from the same rows `list_instance_tools` returns. Never stored, and
		// the owner's `manual` above is returned exactly as written.
		const capabilities = await capabilitiesForInstance(c.env, instanceId, session.uid);
		const context = buildOperatorGuidance({ instanceId, surfaces: capabilities?.surfaces ?? [], runtime: capabilities?.runtime ?? null, tools: await allowedToolRows(c.env, instanceId, session.uid, instance.config) });
		// #1237 / #1238: the owner's account manual and the template's, read LIVE (an edit reaches every instance on its next read), beside this one's own.
		const layers = await operatorManualLayers(c.env, instanceId, session.uid);
		const body: OperatorManualResponse = {
			manual: row?.operator_manual ?? "",
			account: layers.account,
			inherited: layers.inherited,
			sections: { account: layers.account || null, inherited: layers.inherited || null, instance: layers.instance || null },
			combined: combinedOperatorManual(layers),
			rules,
			context,
		};
		return c.json(body);
	});

	/**
	 * Replace the operator manual. Accepts `{ manual }` only — `rules` and `context` are
	 * read-only via this route; the former is written by `PUT /instructions`. Rejects with
	 * 400 (naming the submitted length) when the manual exceeds OPERATOR_MANUAL_MAX_CHARS,
	 * rather than silently truncating the way specialInstructions does — open question 1
	 * in #739 resolved in favour of an honest rejection.
	 */
	router.put("/:instanceId/operator-manual", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { manual?: unknown };
		const manual = String(body.manual ?? "");
		const tooLong = operatorManualTooLong(manual);
		if (tooLong) return c.json({ error: tooLong }, 400);
		await c.env.DB.prepare("UPDATE agent_instances SET operator_manual = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3")
			.bind(manual, instanceId, session.uid)
			.run();
		return c.json({ ok: true });
	});
}
