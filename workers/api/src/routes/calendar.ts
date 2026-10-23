// Google Calendar: live connection state and per-instance exact-calendar grants (#1313).
//
// The account is connected through the generic connector OAuth flow; nothing here connects or stores
// a credential. A grant is a separate, instance-level boundary naming one exact calendar id, verified
// against Google with the owner's own connection before it is stored — so connecting Calendar never
// gives any agent a calendar, and a calendar the connected account cannot read cannot be granted.
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { clipMarked } from "../lib/clip-marked.js";
import { connectorGrantReach, deleteConnectorGrant, listConnectorGrants, upsertConnectorGrant } from "../lib/connector-grants.js";
import { connectorClient } from "../lib/connectors/client.js";
import { calendarConnectionState, CALENDAR_NOT_CONNECTED } from "../lib/connectors/google-calendar.js";
import { CalendarError, exactCalendarId, GOOGLE_CALENDAR_GRANT, GOOGLE_CALENDAR_PROVIDER, listCalendarEvents } from "../lib/google-calendar.js";
import { logEvent } from "../lib/events.js";
import { connectorRefusalFor } from "../lib/instance-connector-access.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export const calendarRoutes = new Hono<{ Bindings: Env }>();

/** The lifecycle audit row: ids and names only — never a token, an attendee or an event. */
const audit = (env: Env, uid: string, event: string, message: string, context: Record<string, unknown>, instanceId?: string, level: "info" | "warn" = "info") =>
	logEvent(env, { source: "calendar", event, level, message, userId: uid, instanceId, context });

/** HTTP status for a calendar refusal. Google's 401 is never passed on as a 401 — the console signs the owner out on it. */
const statusOf = (e: CalendarError): 400 | 403 | 404 | 409 | 429 | 502 => (e.code === "bad_input" ? 400 : e.code === "reauth" ? 409 : e.code === "denied" ? 403 : e.code === "not_found" ? 404 : e.code === "rate_limited" ? 429 : 502);

/**
 * Is Calendar connected, and does the stored credential still work? `?check=1` mints an access token
 * (one request to Google) and reports a revoked connection as `revoked`; without it only the stored
 * connection is reported. `reach` is how many agent grants depend on it.
 */
calendarRoutes.get("/status", async (c) => {
	const session = await requireUser(c);
	const check = c.req.query("check") === "1" ? () => connectorClient(c.env, GOOGLE_CALENDAR_PROVIDER, { userId: session.uid }).token({ scope: "read" }) : null;
	const [state, reach] = await Promise.all([calendarConnectionState(c.env, session.uid, check), connectorGrantReach(c.env, session.uid, GOOGLE_CALENDAR_PROVIDER)]);
	return c.json({ ...state, checked: check !== null, reach });
});

calendarRoutes.get("/instances/:instanceId/grants", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json({ grants: await listConnectorGrants(c.env, instanceId, session.uid, GOOGLE_CALENDAR_PROVIDER) });
});

/**
 * Grant ONE exact calendar to an agent. Google is asked for a one-event page of that calendar with the
 * owner's connection first: a calendar the connected account cannot read (denied or unknown) is refused
 * here and nothing is stored. The verified calendar name, not the caller's, becomes the grant's name.
 */
calendarRoutes.post("/instances/:instanceId/grants", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const instance = await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { calendarId?: unknown };
	let calendarId: string;
	try {
		calendarId = exactCalendarId(body.calendarId);
	} catch (e) {
		throw new HttpError(400, (e as Error).message);
	}
	const refusal = await connectorRefusalFor(c.env, GOOGLE_CALENDAR_PROVIDER, instanceId, session.uid, instance.config);
	if (refusal) throw new HttpError(403, refusal);

	let token: string;
	try {
		token = await connectorClient(c.env, GOOGLE_CALENDAR_PROVIDER, { userId: session.uid, instanceId }).token({ scope: "read" });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		await audit(c.env, session.uid, "calendar.grant_refused", "connection", { outcome: "connection", calendarId }, instanceId, "warn");
		if (/not connected/i.test(message)) throw new HttpError(409, CALENDAR_NOT_CONNECTED);
		if (/could not refresh/i.test(message)) throw new HttpError(409, "Google rejected the stored Calendar access — it was revoked or expired. Reconnect Google Calendar, then grant the calendar.");
		throw new HttpError(502, `Google Calendar access could not be obtained: ${message}`);
	}
	const now = Date.now();
	let name: string | null;
	try {
		const page = await listCalendarEvents(token, calendarId, { timeMin: new Date(now).toISOString(), timeMax: new Date(now + 86_400_000).toISOString(), maxResults: 1 });
		name = page.calendarName;
	} catch (e) {
		if (e instanceof CalendarError) {
			await audit(c.env, session.uid, "calendar.grant_refused", e.code, { outcome: e.code, calendarId }, instanceId, "warn");
			throw new HttpError(statusOf(e), e.code === "denied" || e.code === "not_found" ? `The connected Google account cannot read the calendar "${calendarId}", so it was not granted. ${e.message}` : e.message);
		}
		throw e;
	}
	const existing = (await listConnectorGrants(c.env, instanceId, session.uid, GOOGLE_CALENDAR_PROVIDER)).find((g) => g.resourceId === calendarId);
	const grant = await upsertConnectorGrant(c.env, instanceId, session.uid, {
		provider: GOOGLE_CALENDAR_PROVIDER,
		resourceId: calendarId,
		resourceName: clipMarked(name ?? calendarId, 500, { within: true, what: "characters in Calendar name" }),
		resourceType: GOOGLE_CALENDAR_GRANT,
	});
	if (!existing) await audit(c.env, session.uid, "calendar.grant", `Granted Google calendar ${grant.resourceName}`, { grantId: grant.id, calendarId }, instanceId);
	return c.json({ grant }, existing ? 200 : 201);
});

calendarRoutes.delete("/instances/:instanceId/grants/:grantId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const grantId = c.req.param("grantId");
	if (!(await deleteConnectorGrant(c.env, instanceId, session.uid, GOOGLE_CALENDAR_PROVIDER, grantId))) {
		throw new HttpError(404, `This instance holds no Google Calendar grant "${grantId}" — it was already revoked, or belongs to another instance.`);
	}
	await audit(c.env, session.uid, "calendar.revoke", "Revoked a Google Calendar grant", { grantId }, instanceId);
	return c.json({ success: true });
});
