import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { getProfile, PROFILE_FIELDS, upsertProfile, type Profile } from "../lib/profile.js";
import type { Env } from "../types.js";

export const profileRoutes = new Hono<{ Bindings: Env }>();

/** The owner's structured candidate profile + the field schema (for the UI). */
profileRoutes.get("/", async (c) => {
	const session = await requireUser(c);
	return c.json({ profile: await getProfile(c.env, session.uid), fields: PROFILE_FIELDS });
});

/** Update profile fields. A string value sets it; "" clears it. */
profileRoutes.put("/", async (c) => {
	const session = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const fields: Profile = {};
	for (const [k, v] of Object.entries(body)) {
		if (typeof v === "string") fields[k] = v;
		else if (v === null) fields[k] = "";
	}
	await upsertProfile(c.env, session.uid, fields);
	return c.json({ ok: true, profile: await getProfile(c.env, session.uid) });
});
