/**
 * Named HTTP credential profiles (#1123) — `/v1/http-profiles` — and their per-instance bindings —
 * `/v1/instances/:instanceId/http-bindings`. Every response is metadata: no route returns, logs or
 * echoes a secret (there is no reveal — see `lib/http-profiles.ts`). The secret goes IN on create and
 * rotate and never comes back out.
 */
import { Hono, type Context } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { logEvent } from "../lib/events.js";
import {
	bindHttpProfile,
	createHttpProfile,
	deleteHttpProfile,
	getHttpProfile,
	listHttpProfiles,
	listInstanceHttpBindings,
	rotateHttpProfileSecret,
	testHttpProfile,
	unbindHttpProfile,
	updateHttpProfile,
} from "../lib/http-profiles.js";
import type { Env } from "../types.js";

type C = Context<{ Bindings: Env }>;
const body = async (c: C) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

/** The audit row for a change: which profile and what happened, never a value. */
const audit = (c: C, uid: string, event: string, message: string, context: Record<string, unknown>, instanceId?: string) =>
	logEvent(c.env, { source: "http-profiles", event, level: "info", message, userId: uid, instanceId, context });

export const httpProfileRoutes = new Hono<{ Bindings: Env }>();

httpProfileRoutes.get("/", async (c) => {
	const { uid } = await requireUser(c);
	return c.json({ profiles: await listHttpProfiles(c.env, uid) });
});

httpProfileRoutes.post("/", async (c) => {
	const { uid } = await requireUser(c);
	const profile = await createHttpProfile(c.env, uid, await body(c));
	await audit(c, uid, "http_profile.create", `Created HTTP credential profile "${profile.name}"`, { profileId: profile.id, name: profile.name });
	return c.json({ profile }, 201);
});

httpProfileRoutes.get("/:id", async (c) => {
	const { uid } = await requireUser(c);
	return c.json({ profile: await getHttpProfile(c.env, uid, c.req.param("id")) });
});

httpProfileRoutes.patch("/:id", async (c) => {
	const { uid } = await requireUser(c);
	const profile = await updateHttpProfile(c.env, uid, c.req.param("id"), await body(c));
	await audit(c, uid, "http_profile.update", `Updated HTTP credential profile "${profile.name}"`, { profileId: profile.id, name: profile.name });
	return c.json({ profile });
});

httpProfileRoutes.post("/:id/rotate", async (c) => {
	const { uid } = await requireUser(c);
	const profile = await rotateHttpProfileSecret(c.env, uid, c.req.param("id"), await body(c));
	await audit(c, uid, "http_profile.rotate", `Rotated the secret of HTTP credential profile "${profile.name}"`, {
		profileId: profile.id,
		name: profile.name,
		secretVersion: profile.secret.version,
	});
	return c.json({ profile });
});

httpProfileRoutes.get("/:id/test", async (c) => {
	const { uid } = await requireUser(c);
	return c.json(await testHttpProfile(c.env, uid, c.req.param("id")));
});

httpProfileRoutes.delete("/:id", async (c) => {
	const { uid } = await requireUser(c);
	const result = await deleteHttpProfile(c.env, uid, c.req.param("id"));
	await audit(c, uid, "http_profile.delete", "Deleted an HTTP credential profile", { profileId: result.id, unbound: result.unbound });
	return c.json(result);
});

export const httpBindingRoutes = new Hono<{ Bindings: Env }>();

async function requireOwned(c: C): Promise<{ uid: string; instanceId: string }> {
	const { uid } = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	const owned = await c.env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, uid).first();
	if (!owned) throw new HttpError(404, "Instance not found");
	return { uid, instanceId };
}

httpBindingRoutes.get("/:instanceId/http-bindings", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	return c.json({ bindings: await listInstanceHttpBindings(c.env, uid, instanceId) });
});

httpBindingRoutes.put("/:instanceId/http-bindings/:bindingName", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const b = await body(c);
	const binding = await bindHttpProfile(c.env, uid, instanceId, { bindingName: c.req.param("bindingName"), profileId: b.profileId, connector: b.connector });
	await audit(c, uid, "http_profile.bind", `Bound HTTP credential profile "${binding.profileName}" as "${binding.bindingName}"`, {
		profileId: binding.profileId,
		bindingName: binding.bindingName,
		connector: binding.connector,
	}, instanceId);
	return c.json({ binding });
});

httpBindingRoutes.delete("/:instanceId/http-bindings/:bindingName", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const result = await unbindHttpProfile(c.env, uid, instanceId, c.req.param("bindingName"), c.req.query("connector"));
	if (!result.unbound) throw new HttpError(404, "No such binding on this instance.");
	await audit(c, uid, "http_profile.unbind", `Removed HTTP credential binding "${c.req.param("bindingName")}"`, { bindingName: c.req.param("bindingName") }, instanceId);
	return c.json(result);
});
