/**
 * Named HTTP credential profiles (#1123) — `/v1/http-profiles` — and their per-instance bindings —
 * `/v1/instances/:instanceId/http-bindings`. Every response is metadata: no route returns, logs or
 * echoes a secret (there is no reveal — see `lib/http-profiles.ts`). The secret goes IN on create and
 * rotate and never comes back out.
 */
import { Hono, type Context } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { logEvent } from "../lib/events.js";
import { connectorStateProvider, signConnectorState, verifyConnectorState } from "../lib/connector-oauth.js";
import { clearOauthBindCookie, newOauthNonce, OAUTH_BIND_ERROR, oauthBindCookie, readOauthBindCookie } from "../lib/oauth-nonce.js";
import {
	bindHttpProfile,
	completeHttpProfileAuthorization,
	httpProfileAuthorizeUrl,
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

// ── OAuth2 authorization-code consent (#1124) ─────────────────────────────────────────────────
//
// The owner's browser starts it (the console calls `start` with credentials, so the bind cookie lands
// on THIS origin) and finishes it at the provider's redirect to `callback`. The state is signed with
// the profile pinned (`http_profile:<id>`) and bound to that browser (lib/oauth-nonce.ts): a link an
// attacker started, completed by someone else, files nothing — the classic consent CSRF that would
// land the victim's grant in the attacker's profile.
const COOKIE_SCOPE = "http_profile";
const STATE_TTL_SECONDS = 10 * 60;
const callbackUri = (c: C) => `${new URL(c.req.url).origin}/v1/http-profiles/oauth/callback`;

httpProfileRoutes.get("/oauth/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	if (!code || !state) return c.text("missing code or state", 400);
	const provider = connectorStateProvider(state) ?? "";
	const id = provider.startsWith("http_profile:") ? provider.slice("http_profile:".length) : "";
	const uid = id ? await verifyConnectorState(state, c.env.SESSION_SIGNING_KEY, { cookieNonce: readOauthBindCookie(c.req.header("cookie"), COOKIE_SCOPE), provider }) : null;
	c.header("Set-Cookie", clearOauthBindCookie(COOKIE_SCOPE)); // single-use, whatever the outcome
	if (!uid) return c.text(OAUTH_BIND_ERROR, 400);
	try {
		await completeHttpProfileAuthorization(c.env, uid, id, code, callbackUri(c));
	} catch (e) {
		return c.text(e instanceof HttpError ? e.message : "The authorization could not be completed.", e instanceof HttpError ? (e.status as 400) : 500);
	}
	await audit(c, uid, "http_profile.authorize", "Authorized an HTTP credential profile (OAuth2)", { profileId: id });
	return c.html("<!doctype html><title>Authorized</title><body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h1>Authorized</h1><p>The profile can now be used. You can close this tab.</p></div></body>");
});

httpProfileRoutes.post("/:id/oauth/start", async (c) => {
	const { uid } = await requireUser(c);
	const id = c.req.param("id");
	const nonce = newOauthNonce();
	const state = await signConnectorState(uid, Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS, c.env.SESSION_SIGNING_KEY, { nonce, provider: `http_profile:${id}` });
	const url = await httpProfileAuthorizeUrl(c.env, uid, id, callbackUri(c), state);
	c.header("Set-Cookie", oauthBindCookie(nonce, COOKIE_SCOPE));
	return c.json({ url });
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
