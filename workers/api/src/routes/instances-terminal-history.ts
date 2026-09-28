import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { clearTerminalHistory, lastTerminalTargetOf, loadTerminalHistory } from "../lib/terminal-record.js";
import { readInstanceConfig } from "./instances-apply.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * A repo-less terminal's stored record (#878) — `lib/terminal-record.ts` explains what is kept and
 * why. GET pages it with the cursor rules `coding_timeline` uses (newest page by default, `before`
 * walks back, `since` polls forward; `terminal=1` for panes only); DELETE is the explicit clear the
 * record otherwise waits for, and takes the remembered target with it.
 */
export function registerTerminalHistoryRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/terminal-history", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const num = (q: string) => {
			const n = Number.parseInt(c.req.query(q) ?? "", 10);
			return Number.isFinite(n) ? n : undefined;
		};
		if (c.req.query("since") && c.req.query("before")) return c.json({ error: "Pass `since` or `before`, not both." }, 400);
		const page = await loadTerminalHistory(c.env, { instanceId, userId: session.uid, terminalOnly: c.req.query("terminal") === "1", since: num("since"), before: num("before"), limit: num("limit") });
		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		return c.json({ lastTerminalTarget: lastTerminalTargetOf(cfg), ...page });
	});
	router.delete("/:instanceId/terminal-history", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		return c.json({ cleared: await clearTerminalHistory(c.env, instanceId, session.uid) });
	});
}
