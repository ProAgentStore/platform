import { Hono } from "hono";
import { recordAdminAction } from "../lib/admin.js";
import { HttpError, requireAdmin } from "../lib/auth.js";
import { readPlatformAiSetting, setPlatformAiOverride } from "../lib/platform-settings.js";
import type { Env } from "../types.js";

/**
 * Runtime platform settings (issue #46). Mounted at /v1/admin.
 *
 * The lever this exists for: stopping platform-paid Workers-AI spend NOW. Until now the
 * only way was to edit `PLATFORM_AI_ENABLED` in `wrangler.toml` and redeploy — minutes
 * of CI while the spend continues, and impossible for an operator without deploy rights.
 *
 * Safety properties, mirroring admin-moderation.ts (issue #108 — Cloudflare Access on
 * the /v1/admin perimeter — is still OPEN, so nothing upstream can be assumed):
 *
 *  1. EVERY handler calls `requireAdmin` itself, not shared middleware. A route that
 *     forgets middleware still 200s; a route that forgets this line fails its own test,
 *     and there is a per-route non-admin assertion.
 *  2. Every successful mutation writes one `admin_audit_log` row carrying the BEFORE and
 *     AFTER value, so "who turned the platform's AI off at 3am" is answerable.
 *  3. The switch governs PLATFORM-paid AI only (`env.AI`, ledgered as
 *     provider="platform"). BYOK — the user's own Anthropic key, or Workers AI on the
 *     user's own Cloudflare account — is their spend and is deliberately untouched.
 *  4. No secret is read or returned; the payload is one boolean and its provenance.
 */
export const adminSettingsRoutes = new Hono<{ Bindings: Env }>();

/** Side effects an operator should see BEFORE flipping the switch off, returned with
 *  the state itself so the warning cannot drift away from the lever it describes. */
const OFF_WARNING =
	"With platform-paid AI off, embeddings and conversation summaries no-op — RAG goes dark for newly added content until a BYOK embedding path exists. Translation falls back to the user's own key. BYOK chat is unaffected.";

/**
 * GET /v1/admin/settings/platform-ai — is the platform currently allowed to pay for
 * AI, and is that the deployed default or an operator override?
 */
adminSettingsRoutes.get("/settings/platform-ai", async (c) => {
	await requireAdmin(c);
	const setting = await readPlatformAiSetting(c.env);
	return c.json({ ...setting, warning: OFF_WARNING });
});

/**
 * PUT /v1/admin/settings/platform-ai { enabled: boolean | null }
 *
 * `null` CLEARS the override and hands control back to the deployed env var — a
 * first-class action, because pinning a value forever would silently contradict the
 * next deploy that changes the default.
 */
adminSettingsRoutes.put("/settings/platform-ai", async (c) => {
	const actor = await requireAdmin(c);
	const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({}) as { enabled?: unknown });
	const raw = body.enabled;
	// Strictly boolean-or-null. A string "false" is truthy in JS, and an operator whose
	// kill switch silently did the opposite of what they typed is the worst failure this
	// route has available to it.
	if (raw !== null && typeof raw !== "boolean") {
		throw new HttpError(400, "enabled must be true, false, or null (null clears the override)");
	}
	const before = await readPlatformAiSetting(c.env);
	const after = await setPlatformAiOverride(c.env, raw, actor.uid);
	await recordAdminAction(c.env, actor, "settings.platform_ai", { type: "setting", id: "platform_ai_enabled" }, {
		before: { enabled: before.enabled, override: before.override, source: before.source },
		after: { enabled: after.enabled, override: after.override, source: after.source },
	});
	return c.json({ ...after, warning: OFF_WARNING });
});
