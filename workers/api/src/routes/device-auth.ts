/**
 * Remote sign-in for a machine with no browser, and keeping its session alive (#1157). See `lib/device-auth.ts`.
 *
 *   POST /v1/auth/device/start                — no auth: the machine opens a request (RFC 8628 §3.1–3.2)
 *   POST /v1/auth/device/token                — no auth: the machine polls with its device code (§3.4–3.5)
 *   GET  /v1/auth/device/requests/:userCode   — the signed-in owner reads what is asking, on the approval page
 *   POST /v1/auth/device/requests/:userCode   — the owner approves or denies it
 *   POST /v1/auth/session/refresh             — a valid session swaps itself for a fresh 30-day one
 *
 * Every session minted here carries the account's LIVE roles and is refused to a suspended account, exactly as
 * the OAuth callbacks are — a device approval or a refresh is a sign-in, not a way around one.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { HttpError, isSuspended, requireUser, rolesOf } from "../lib/auth.js";
import { signSession, verifySession } from "../lib/session.js";
import { CONSOLE_ORIGIN } from "../lib/console-deep-link.js";
import { deviceApprovalLink } from "../lib/console-links.js";
import { createDeviceCredential, DAY_SECONDS, getAccountLifetime, isLifetimeDays, listDeviceCredentials, RUNNER_SESSION_DAYS, renewDeviceCredential, revokeDeviceCredential, setAccountLifetime } from "../lib/device-credentials.js";
import { decideDeviceRequest, type DeviceDecisionResponse, type DeviceRequestResponse, getDeviceRequest, normalizeUserCode, pollDeviceAuthorization, startDeviceAuthorization } from "../lib/device-auth.js";

export const deviceAuthRoutes = new Hono<{ Bindings: Env }>();
export const sessionRoutes = new Hono<{ Bindings: Env }>();

/** A session for `uid` with its live roles, or null when the account is gone or suspended. */
async function mintFor(c: Context<{ Bindings: Env }>, uid: string, device?: { did: string; ttl: number; scope?: "runner" | null }): Promise<{ session: string; expiresAt: string } | null> {
	const row = await c.env.DB.prepare("SELECT roles FROM users WHERE id = ?1").bind(uid).first<{ roles: string | null }>();
	if (!row || (await isSuspended(c, uid))) return null;
	const roles = rolesOf(row.roles);
	const session = await signSession(uid, c.env.SESSION_SIGNING_KEY, { roles: roles.length ? roles : ["user"], ...(device ? { did: device.did, ttl: device.ttl, ...(device.scope === "runner" ? { scope: "runner" as const } : {}) } : {}) });
	const payload = await verifySession(session, c.env.SESSION_SIGNING_KEY);
	return { session, expiresAt: new Date((payload?.exp ?? 0) * 1000).toISOString() };
}

const userCodeParam = (c: Context<{ Bindings: Env }>) => {
	const code = normalizeUserCode(c.req.param("userCode"));
	if (!code) throw new HttpError(400, "That is not a sign-in code — it looks like BCDF-GHJK.");
	return code;
};

deviceAuthRoutes.post("/start", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { node?: unknown; scope?: unknown };
	const cf = (c.req.raw as { cf?: { country?: unknown } }).cf;
	const started = await startDeviceAuthorization(c.env, { node: body.node, ip: c.req.header("CF-Connecting-IP"), country: cf?.country, scope: body.scope });
	const verificationUri = `${CONSOLE_ORIGIN}${deviceApprovalLink()}`;
	c.header("Cache-Control", "no-store");
	return c.json({
		device_code: started.deviceCode,
		user_code: started.userCode,
		verification_uri: verificationUri,
		verification_uri_complete: `${CONSOLE_ORIGIN}${deviceApprovalLink(started.userCode)}`,
		expires_in: started.expiresIn,
		interval: started.interval,
	});
});

deviceAuthRoutes.post("/token", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { device_code?: unknown };
	const poll = await pollDeviceAuthorization(c.env, body.device_code);
	c.header("Cache-Control", "no-store");
	if (poll.kind !== "approved") return c.json({ error: poll.kind }, 400);
	// The machine's own credential (#1184): per machine, revocable, of the length chosen at approval (else the owner's default).
	const days = isLifetimeDays(poll.lifetimeDays) ? poll.lifetimeDays : await getAccountLifetime(c.env, poll.userId);
	const credential = await createDeviceCredential(c.env, poll.userId, poll.node, days, Date.now(), poll.scope);
	const minted = await mintFor(c, poll.userId, { did: credential.id, ttl: days * DAY_SECONDS, scope: poll.scope });
	if (!minted) {
		await revokeDeviceCredential(c.env, poll.userId, credential.id).catch(() => false);
		return c.json({ error: "access_denied" }, 400);
	}
	return c.json({ session: minted.session, expires_at: minted.expiresAt, device_id: credential.id, lifetime_days: days, scope: poll.scope });
});

// ── The owner's machines (#1184) ─────────────────────────────────────────────────────────────────────────────

deviceAuthRoutes.get("/credentials", async (c) => {
	const s = await requireUser(c);
	c.header("Cache-Control", "no-store");
	return c.json({ credentials: await listDeviceCredentials(c.env, s.uid), lifetimeDays: await getAccountLifetime(c.env, s.uid), allowedLifetimeDays: RUNNER_SESSION_DAYS });
});

deviceAuthRoutes.delete("/credentials/:id", async (c) => {
	const s = await requireUser(c);
	if (!(await revokeDeviceCredential(c.env, s.uid, c.req.param("id")))) throw new HttpError(404, "No active sign-in with that id on your account.");
	return c.json({ revoked: true, id: c.req.param("id") });
});

deviceAuthRoutes.put("/lifetime", async (c) => {
	const s = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as { days?: unknown };
	if (!isLifetimeDays(body.days)) throw new HttpError(400, `days must be one of ${RUNNER_SESSION_DAYS.join(", ")}.`);
	await setAccountLifetime(c.env, s.uid, body.days);
	return c.json({ lifetimeDays: body.days, appliesTo: "machines signed in from now on; existing sign-ins keep their length" });
});

deviceAuthRoutes.get("/requests/:userCode", async (c) => {
	await requireUser(c);
	const request = await getDeviceRequest(c.env, userCodeParam(c));
	if (!request) throw new HttpError(404, "No sign-in is waiting for that code — it may have expired (codes last 10 minutes).");
	c.header("Cache-Control", "no-store");
	return c.json({ request } satisfies DeviceRequestResponse);
});

deviceAuthRoutes.post("/requests/:userCode", async (c) => {
	const s = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as { approve?: unknown; lifetimeDays?: unknown; runnerOnly?: unknown };
	if (typeof body.approve !== "boolean") throw new HttpError(400, "approve must be true or false.");
	if (body.lifetimeDays !== undefined && !isLifetimeDays(body.lifetimeDays)) throw new HttpError(400, `lifetimeDays must be one of ${RUNNER_SESSION_DAYS.join(", ")}.`);
	if (body.runnerOnly !== undefined && typeof body.runnerOnly !== "boolean") throw new HttpError(400, "runnerOnly must be true or false.");
	// A runner-only approval (#1192) is the OWNER's call: the machine can ask for it, but it is what the approver says that counts.
	// (Approving from a runner-only session is refused above by requireUser's scope check, so a stolen one cannot mint a full one.)
	const code = userCodeParam(c);
	if ((await decideDeviceRequest(c.env, s.uid, code, body.approve, Date.now(), body.lifetimeDays ?? null, body.runnerOnly === true ? "runner" : null)) === "gone") {
		throw new HttpError(409, "This sign-in was already decided, or it has expired. Run `pags login --device` again for a new code.");
	}
	return c.json({ request: await getDeviceRequest(c.env, code) } satisfies DeviceDecisionResponse);
});

sessionRoutes.post("/refresh", async (c) => {
	const s = await requireUser(c); // a valid, unexpired session of a non-suspended account
	// A machine's session (#1184) is renewed as the SAME credential, for its own length — and not at all once it is revoked.
	// (Read from the token itself: `requireUser` has already refused a revoked or expired one.)
	const did = (await verifySession(c.req.header("Authorization")?.slice(7) ?? "", c.env.SESSION_SIGNING_KEY))?.did;
	if (did) {
		const renewed = await renewDeviceCredential(c.env, s.uid, did);
		if (!renewed) throw new HttpError(401, "This machine's sign-in was revoked or has expired. Sign it in again with `pags login --device`.");
		const device = await mintFor(c, s.uid, { did, ttl: renewed.lifetimeDays * DAY_SECONDS, scope: renewed.scope });
		if (!device) throw new HttpError(403, "This account cannot be signed in.");
		c.header("Cache-Control", "no-store");
		return c.json({ ...device, device_id: did, lifetime_days: renewed.lifetimeDays, scope: renewed.scope });
	}
	const minted = await mintFor(c, s.uid);
	if (!minted) throw new HttpError(403, "This account cannot be signed in.");
	c.header("Cache-Control", "no-store");
	return c.json(minted);
});
