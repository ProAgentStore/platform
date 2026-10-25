/**
 * The ACCOUNT-level operator manual (#1238): caller-facing operating standards that apply to every template the owner runs — the machine
 * map, main-only with no PRs, the home-relative checkout layout. It is the owner's own: every instance THEY run reads it, first, ahead of
 * the template's manual (#1237) and the instance's own (#739), so an edit reaches all of them on the next read with no resync.
 *
 * Owner only, and only ever the caller's own row — there is no id in the path, so one account cannot read or write another's, and a
 * template creator's account manual never reaches other people's instances. Never injected as an agent instruction; the agent reads it as
 * data (`read_operator_manual`), like the other two layers.
 */
import type { Hono } from "hono";
import type { AccountOperatorManualResponse } from "../agent-types.js";
import { requireUser } from "../lib/auth.js";
import { operatorManualTooLong, readAccountOperatorManual, writeAccountOperatorManual } from "../lib/operator-manual.js";
import type { Env } from "../types.js";

export function registerAccountOperatorManualRoutes(router: Hono<{ Bindings: Env }>): void {
	const count = async (env: Env, userId: string) =>
		(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_instances WHERE user_id = ?1 AND status != 'canceled'").bind(userId).first<{ n: number }>())?.n ?? 0;

	/** `{ manual, instances }` — the account manual ("" when none) and how many of the owner's instances read it. */
	router.get("/operator-manual", async (c) => {
		const session = await requireUser(c);
		const body: AccountOperatorManualResponse = { manual: await readAccountOperatorManual(c.env, session.uid), instances: await count(c.env, session.uid) };
		return c.json(body);
	});

	/** Replace the account manual: `{ manual }`, at most 16,000 characters (400 above, naming the length); "" clears it. */
	router.put("/operator-manual", async (c) => {
		const session = await requireUser(c);
		const body = (await c.req.json().catch(() => ({}))) as { manual?: unknown };
		const manual = typeof body.manual === "string" ? body.manual : String(body.manual ?? "");
		const tooLong = operatorManualTooLong(manual);
		if (tooLong) return c.json({ error: tooLong }, 400);
		await writeAccountOperatorManual(c.env, session.uid, manual);
		return c.json({ ok: true, manual });
	});
}
