/**
 * Apply / Skip straight from a job-lead decision push (#1602).
 *
 * The service worker has no session, so it presents the token the push carried (`signLeadActionToken`).
 * The token authenticates nothing else: this route reads it, checks the account is live and still owns
 * the instance, then makes the SAME triage call the Data tab does (`runJobLeadTriage`) with the status
 * and version the notification was about. Compare-and-set is what makes it single-use — the decision
 * bumps `lifecycle_version`, so a replay, or the other button, is refused as stale.
 */
import { Hono } from "hono";
import { isSuspended } from "../lib/auth.js";
import { clipMarked } from "../lib/clip-marked.js";
import { verifyLeadActionToken } from "../lib/session.js";
import type { Env } from "../types.js";
import { runJobLeadTriage } from "./instances-job-leads.js";

export const leadActionRoutes = new Hono<{ Bindings: Env }>();

/** What the service worker shows. `ok` false always says the lead was NOT changed. */
const refuse = (message: string) => ({ ok: false as const, message });

leadActionRoutes.post("/lead-action", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
	const claims = typeof body.token === "string" ? await verifyLeadActionToken(body.token, c.env.SESSION_SIGNING_KEY) : null;
	if (!claims) return c.json(refuse("This button has expired. Open the lead to decide."), 401);
	if (await isSuspended(c, claims.uid)) return c.json(refuse("Account suspended."), 403);
	const owned = await c.env.DB.prepare("SELECT 1 FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(claims.instanceId, claims.uid).first();
	if (!owned) return c.json(refuse("That agent is no longer yours to decide for."), 404);

	const out = await runJobLeadTriage(c.env, claims.instanceId, claims.uid, claims.leadId, {
		action: claims.action,
		expected_status: "new",
		expected_version: claims.version,
	});
	if (out.status !== 200) {
		const stale = (out.result as { stale?: boolean }).stale === true;
		return c.json(refuse(stale ? "Not changed: you already decided on this lead, or it changed. Open it to check." : (out.result.error ?? "Could not save the decision.")), 409);
	}
	// The triage treats a repeat of the decision already made as a harmless retry (200, no transition). A
	// button is single-use, so a repeat is refused rather than reported as a fresh decision.
	if (out.result.transitioned === false) return c.json(refuse("Not changed: you already decided on this lead."), 409);
	const data = ((out.result.record as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
	const title = str(data.title) ?? "the job";
	const company = str(data.company);
	const what = clipMarked(`${title}${company ? ` at ${company}` : ""}`, 120);
	return c.json({ ok: true as const, action: claims.action, message: claims.action === "apply" ? `Applying: ${what} — tailoring started` : `Skipped: ${what}` });
});
