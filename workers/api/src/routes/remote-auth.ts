/**
 * PAS remote sign-in requests (#1005), design A (#1006): the owner's own machine relays, PAGS shows and links.
 *
 * - `POST /v1/remote-auth/requests` — the `pags remote-auth relay` CLI, with the owner's PAGS login, hands
 *   over a PAS broker request's PUBLIC details. The first relay pushes the owner a link to the request.
 * - `POST /v1/remote-auth/requests/:id/state` — the same machine reports the broker state it observed.
 * - `GET /v1/remote-auth/requests/:id` — the owner's page.
 *
 * No route here calls PAS, and nothing here accepts or returns a PAS credential.
 */
import { Hono } from "hono";
import type { Env } from "../types.js";
import { HttpError, requireUser } from "../lib/auth.js";
import { REMOTE_AUTH_STATES, type RemoteAuthRequestResponse, type RemoteAuthState, originsFrom, parseRelay } from "../lib/remote-auth.js";
import { getRemoteAuthRequest, relayRemoteAuthRequest, reportRemoteAuthState } from "../lib/remote-auth-store.js";
import { remoteAuthRequestLink } from "../lib/console-links.js";

export const remoteAuthRoutes = new Hono<{ Bindings: Env }>();

const relayer = (b: Record<string, unknown>) => {
	const r = (b.relayed_by && typeof b.relayed_by === "object" ? b.relayed_by : {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" && v.trim() && v.length <= 200 ? v.trim() : null);
	return { node: str(r.node), machineId: str(r.machine_id) };
};

remoteAuthRoutes.post("/requests", async (c) => {
	const s = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const parsed = parseRelay(body, originsFrom(c.env));
	if (!parsed.ok) throw new HttpError(400, parsed.error);
	const out = await relayRemoteAuthRequest(c.env, s.uid, parsed.relay, relayer(body));
	if (!out.ok) return c.json({ error: out.error }, out.status);
	return c.json({ request: out.request, duplicate: out.duplicate, url: remoteAuthRequestLink(out.request.id) }, out.duplicate ? 200 : 201);
});

remoteAuthRoutes.post("/requests/:id/state", async (c) => {
	const s = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const state = body.state as RemoteAuthState;
	if (!(REMOTE_AUTH_STATES as readonly string[]).includes(state)) throw new HttpError(400, `state must be one of ${REMOTE_AUTH_STATES.join(", ")}.`);
	const out = await reportRemoteAuthState(c.env, s.uid, c.req.param("id"), state, { machineId: relayer(body).machineId });
	if (!out.ok) return c.json({ error: out.error }, out.status);
	return c.json({ request: out.request, changed: out.changed });
});

remoteAuthRoutes.get("/requests/:id", async (c) => {
	const s = await requireUser(c);
	const request = await getRemoteAuthRequest(c.env, s.uid, c.req.param("id"));
	if (!request) throw new HttpError(404, "No such request.");
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	return c.json({ request } satisfies RemoteAuthRequestResponse);
});
