// Google Calendar connector (#1313): read-only, exact-calendar grants.
//
// Two layers of reach, both explicit. The ACCOUNT is connected once through the generic OAuth flow
// (`/v1/connectors/google_calendar/oauth/start`, scope `calendar.events.readonly`). Each AGENT then holds
// grants naming exact calendar ids, and every tool call is refused unless the id it names is one of
// them — checked through `requireGrant` on every call, so a revoked grant stops working at once. The
// connection and the grants are separate on purpose: connecting an account gives no agent any calendar.
//
// There is no write tool and `scopes.write` is false, so a write-scoped token request is refused by the
// connector client and the connector can never be write-consented (#90).
import { logEvent } from "../events.js";
import { listConnectorGrants } from "../connector-grants.js";
import { listConnectorAccounts } from "../connector-accounts.js";
import { reconcileInterviewEvent } from "../calendar-reconcile.js";
import {
	boundedWindow,
	CalendarError,
	type CalendarEvent,
	exactCalendarId,
	eventIdOf,
	getCalendarEvent,
	GOOGLE_CALENDAR_GRANT,
	GOOGLE_CALENDAR_PROVIDER,
	GOOGLE_CALENDAR_SCOPE,
	listCalendarEvents,
	pageTokenOf,
} from "../google-calendar.js";
import type { Env } from "../../types.js";
import type { Connector, RegistryToolCtx, RegistryToolResult, ToolDef } from "./types.js";

export const CALENDAR_NOT_CONNECTED = "Google Calendar is not connected. The owner connects it in Preferences → Connections, then grants this agent a calendar under Permissions & Connections.";

export type CalendarAccess = "ok" | "not_connected" | "revoked" | "unconfigured" | "error";

const fail = (content: string): RegistryToolResult => ({ content, success: false });
const json = (payload: unknown, untrusted = true): RegistryToolResult => ({ content: JSON.stringify(payload, null, 2), success: true, ...(untrusted ? { origin: "the owner's Google Calendar" } : {}) });

/** The audit row for one calendar act: ids, counts and outcome — never titles, attendees or addresses. */
function audit(ctx: RegistryToolCtx, event: string, outcome: string, context: Record<string, unknown>, level: "info" | "warn" = "info"): Promise<unknown> {
	return logEvent(ctx.env, { source: "calendar", event, level, message: `${event}: ${outcome}`, userId: ctx.userId, instanceId: ctx.instanceId, traceId: ctx.traceId, context: { outcome, ...context } });
}

/** What a failed token mint means. Google's `invalid_grant` is surfaced by the client as a 502 "Could not refresh". */
export function accessFromError(e: unknown): { access: CalendarAccess; message: string } {
	const message = e instanceof Error ? e.message : String(e);
	if (/not connected/i.test(message)) return { access: "not_connected", message: CALENDAR_NOT_CONNECTED };
	if (/not configured/i.test(message)) return { access: "unconfigured", message: "Google Calendar sign-in is not configured on this deployment, so it cannot be connected." };
	if (/could not refresh/i.test(message)) return { access: "revoked", message: "Google rejected the stored Calendar access — it was revoked or expired. The owner reconnects Google Calendar in Preferences → Connections." };
	return { access: "error", message: `Google Calendar access could not be obtained: ${message}` };
}

async function token(ctx: RegistryToolCtx): Promise<{ token: string } | { refusal: RegistryToolResult; access: CalendarAccess }> {
	if (!ctx.env || !ctx.userId || !ctx.instanceId) return { refusal: fail("Google Calendar is available only from a subscribed agent instance."), access: "error" };
	if (!ctx.connectorClient) return { refusal: fail("Connector client unavailable in this context."), access: "error" };
	try {
		const t = await ctx.connectorClient(GOOGLE_CALENDAR_PROVIDER).token({ scope: "read" });
		if (!t) return { refusal: fail(CALENDAR_NOT_CONNECTED), access: "not_connected" };
		return { token: t };
	} catch (e) {
		const { access, message } = accessFromError(e);
		return { refusal: fail(message), access };
	}
}

/**
 * The grant that names this EXACT calendar id for THIS agent, re-checked through the connector client.
 * A calendar the agent was never granted — or whose grant was revoked — is refused here, before any
 * token is minted or any request leaves.
 */
async function grantedCalendar(ctx: RegistryToolCtx, calendarIdInput: unknown): Promise<{ calendarId: string } | { refusal: RegistryToolResult }> {
	if (!ctx.env || !ctx.userId || !ctx.instanceId) return { refusal: fail("Google Calendar is available only from a subscribed agent instance.") };
	let calendarId: string;
	try {
		calendarId = exactCalendarId(calendarIdInput);
	} catch (e) {
		return { refusal: fail((e as Error).message) };
	}
	const grant = (await listConnectorGrants(ctx.env, ctx.instanceId, ctx.userId, GOOGLE_CALENDAR_PROVIDER)).find((g) => g.resourceType === GOOGLE_CALENDAR_GRANT && g.resourceId === calendarId);
	if (!grant) {
		await audit(ctx, "calendar.denied", "not_granted", { calendarId }, "warn");
		return { refusal: fail(`This agent holds no grant for the calendar "${calendarId}". It can read only the calendars its owner granted — call calendar_list_granted_calendars for the current ones. The owner grants one under Permissions & Connections.`) };
	}
	try {
		await ctx.connectorClient?.(GOOGLE_CALENDAR_PROVIDER).requireGrant(grant.id);
	} catch {
		await audit(ctx, "calendar.denied", "grant_revoked", { calendarId }, "warn");
		return { refusal: fail(`The grant for "${calendarId}" was revoked just now. Call calendar_list_granted_calendars for the current grants.`) };
	}
	return { calendarId };
}

function relay(ctx: RegistryToolCtx, e: unknown, action: string, calendarId: string): Promise<RegistryToolResult> {
	if (e instanceof CalendarError) {
		return audit(ctx, `calendar.${action}`, e.code, { calendarId }, e.code === "bad_input" ? "info" : "warn").then(() => fail(e.message));
	}
	return audit(ctx, `calendar.${action}`, "error", { calendarId }, "warn").then(() => fail(`Google Calendar failed: ${e instanceof Error ? e.message : String(e)}`));
}

const listGranted: ToolDef["handler"] = async (ctx) => {
	if (!ctx.env || !ctx.userId || !ctx.instanceId) return fail("Google Calendar is available only from a subscribed agent instance.");
	const grants = (await listConnectorGrants(ctx.env, ctx.instanceId, ctx.userId, GOOGLE_CALENDAR_PROVIDER)).filter((g) => g.resourceType === GOOGLE_CALENDAR_GRANT);
	const accounts = await listConnectorAccounts(ctx.env, ctx.userId, GOOGLE_CALENDAR_PROVIDER);
	// Live: the access token is actually minted, so "connected" means Google accepted the stored credential just now.
	const minted = await token(ctx);
	const access: CalendarAccess = "token" in minted ? "ok" : minted.access;
	await audit(ctx, "calendar.list_granted", access, { grants: grants.length });
	return json(
		{
			connection: {
				access,
				account: accounts[0]?.label ?? null,
				...(access === "ok" ? {} : { remedy: "refusal" in minted ? minted.refusal.content : undefined }),
			},
			calendars: grants.map((g) => ({ calendarId: g.resourceId, name: g.resourceName })),
			note: grants.length === 0 ? "No calendar is granted to this agent. The owner grants an exact calendar under Permissions & Connections." : "Only these calendars can be read. Events cannot be created, changed or deleted.",
		},
		false,
	);
};

const listEvents: ToolDef["handler"] = async (ctx, input) => {
	const granted = await grantedCalendar(ctx, input.calendar_id);
	if ("refusal" in granted) return granted.refusal;
	let window: ReturnType<typeof boundedWindow>;
	let pageToken: string | undefined;
	try {
		window = boundedWindow(input.time_min, input.time_max);
		pageToken = pageTokenOf(input.page_token);
	} catch (e) {
		return relay(ctx, e, "list", granted.calendarId);
	}
	const minted = await token(ctx);
	if ("refusal" in minted) {
		await audit(ctx, "calendar.list", minted.access, { calendarId: granted.calendarId }, "warn");
		return minted.refusal;
	}
	try {
		const page = await listCalendarEvents(minted.token, granted.calendarId, {
			...window,
			pageToken,
			maxResults: typeof input.max_results === "number" ? input.max_results : undefined,
			attendeeEmail: typeof input.attendee_email === "string" && input.attendee_email.trim() ? input.attendee_email : undefined,
		});
		await audit(ctx, "calendar.list", "ok", { calendarId: granted.calendarId, returned: page.events.length, filteredOut: page.filteredOut, window, paged: !!pageToken, more: !!page.nextPageToken, attendeeFilter: !!input.attendee_email });
		return json({
			calendar_id: page.calendarId,
			window: page.window,
			count: page.events.length,
			events: page.events,
			// A filtered page can be empty while Google has more: keep following next_page_token until it is absent.
			...(page.nextPageToken ? { next_page_token: page.nextPageToken } : {}),
			...(page.filteredOut > 0 ? { filtered_out: page.filteredOut } : {}),
		});
	} catch (e) {
		return relay(ctx, e, "list", granted.calendarId);
	}
};

const getEvent: ToolDef["handler"] = async (ctx, input) => {
	const granted = await grantedCalendar(ctx, input.calendar_id);
	if ("refusal" in granted) return granted.refusal;
	let eventId: string;
	try {
		eventId = eventIdOf(input.event_id);
	} catch (e) {
		return relay(ctx, e, "get", granted.calendarId);
	}
	const minted = await token(ctx);
	if ("refusal" in minted) {
		await audit(ctx, "calendar.get", minted.access, { calendarId: granted.calendarId, eventId }, "warn");
		return minted.refusal;
	}
	try {
		const event = await getCalendarEvent(minted.token, granted.calendarId, eventId);
		await audit(ctx, "calendar.get", "ok", { calendarId: granted.calendarId, eventId });
		return json(event);
	} catch (e) {
		return relay(ctx, e, "get", granted.calendarId);
	}
};

/**
 * Decide whether an event may be attached to an application (see `calendar-reconcile.ts`). Reads the event
 * through the same granted-calendar path, then runs the pure safeguards. It changes nothing — not the
 * calendar and not an ATS: it returns the evidence to append, or a triage item, and records which in the
 * audit log with the calendar id and the opaque event id.
 */
const reconcile: ToolDef["handler"] = async (ctx, input) => {
	const granted = await grantedCalendar(ctx, input.calendar_id);
	if ("refusal" in granted) return granted.refusal;
	let eventId: string;
	try {
		eventId = eventIdOf(input.event_id);
	} catch (e) {
		return relay(ctx, e, "reconcile", granted.calendarId);
	}
	const minted = await token(ctx);
	if ("refusal" in minted) {
		await audit(ctx, "calendar.reconcile", minted.access, { calendarId: granted.calendarId, eventId }, "warn");
		return minted.refusal;
	}
	let event: CalendarEvent;
	try {
		event = await getCalendarEvent(minted.token, granted.calendarId, eventId);
	} catch (e) {
		return relay(ctx, e, "reconcile", granted.calendarId);
	}
	const applications = Array.isArray(input.applications) ? (input.applications as Array<Record<string, unknown>>) : [];
	const verdict = reconcileInterviewEvent({
		event,
		candidateEmail: input.candidate_email,
		emailVerification: input.email_verification,
		workspace: input.workspace,
		workspaceBasis: input.workspace_basis,
		applications: applications.map((a) => ({ applicationId: a.application_id, workspace: a.workspace, email: a.email })),
	});
	const base = { calendarId: granted.calendarId, eventId };
	if (verdict.decision === "matched") {
		await audit(ctx, "calendar.reconcile", "matched", { ...base, applicationId: verdict.evidence.applicationId, workspace: verdict.evidence.workspace, matchedOn: verdict.evidence.matchedOn, workspaceBasis: verdict.evidence.workspaceBasis });
		return json({ decision: "matched", evidence: verdict.evidence, next: "Append this evidence to the application's ATS activity. This tool has not written to any ATS." }, false);
	}
	if (verdict.decision === "needs_triage") {
		await audit(ctx, "calendar.reconcile_triage", verdict.reason, { ...base, candidates: verdict.candidates.length }, "warn");
		return json({ decision: "needs_triage", reason: verdict.reason, detail: verdict.detail, candidates: verdict.candidates, calendar_id: granted.calendarId, event_id: eventId, next: "Do not attach this event. File a human triage item in the ATS naming these ids; this tool has not created one." }, false);
	}
	await audit(ctx, "calendar.reconcile", verdict.decision, base, "warn");
	return json({ decision: verdict.decision, reason: verdict.reason }, false);
};

const READ_ONLY = { tier: "connector", connector: GOOGLE_CALENDAR_PROVIDER, scope: "read", mutates: false } as const;

export const GOOGLE_CALENDAR_CONNECTOR: Connector = {
	id: GOOGLE_CALENDAR_PROVIDER,
	label: "Google Calendar",
	auth: "oauth",
	// Read-only: no write tool exists, so no write consent exists to grant.
	scopes: { read: true, write: false },
	grantModel: "instance-resource",
	oauth: {
		authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		scopes: ["openid", "email", GOOGLE_CALENDAR_SCOPE],
		clientIdEnv: "GOOGLE_CLIENT_ID",
		secretEnv: "GOOGLE_CLIENT_SECRET",
		identity: { label: "userinfo-email" },
	},
	tools: [
		{
			...READ_ONLY,
			name: "calendar_list_granted_calendars",
			description: "List the Google calendars the owner granted to this agent, and whether Google Calendar access actually works right now (connected, revoked, not connected). Call this first: it is the only calendar list, and ungranted calendars cannot be read.",
			jsonSchema: { type: "object", properties: {} },
			untrustedOutput: false,
			handler: listGranted,
		},
		{
			...READ_ONLY,
			name: "calendar_list_events",
			description: `List events on ONE granted calendar in a bounded time window (at most 62 days; default the last 7 days and next 30; never more than about a year either way), optionally only those an exact email organises or attends. Returns calendar id, event id, title, organiser, attendees with RSVP, start/end/time zone, join URL and last updated. Follow next_page_token until it is absent — a filtered page can be empty while more remain. Read-only.`,
			jsonSchema: {
				type: "object",
				properties: {
					calendar_id: { type: "string", description: "The exact calendar id, e.g. betabuilders.org@gmail.com." },
					time_min: { type: "string", description: "RFC 3339 start. Give both time_min and time_max, or neither." },
					time_max: { type: "string", description: "RFC 3339 end, at most 62 days after time_min." },
					attendee_email: { type: "string", description: "Keep only events this exact address organises or attends." },
					max_results: { type: "number", description: "1-50, default 25." },
					page_token: { type: "string", description: "The next_page_token of the previous page, copied exactly." },
				},
				required: ["calendar_id"],
			},
			untrustedOutput: true,
			handler: listEvents,
		},
		{
			...READ_ONLY,
			name: "calendar_get_event",
			description: "Get one event by its event id (from a calendar_list_events result) on a granted calendar. Read-only; the event's description and attachments are not returned.",
			jsonSchema: { type: "object", properties: { calendar_id: { type: "string" }, event_id: { type: "string" } }, required: ["calendar_id", "event_id"] },
			untrustedOutput: true,
			handler: getEvent,
		},
		{
			...READ_ONLY,
			name: "calendar_reconcile_interview",
			description:
				"Decide whether a granted-calendar event may be attached to a hiring application. Requires a VERIFIED candidate email (email_verification: ats_application_record | verified_mail_thread | candidate_confirmed), an explicitly selected workspace with workspace_basis (owner_instruction | ats_application_record — never the calendar, event title, organiser or meeting link), and the applications the ATS holds for that email across ALL workspaces. Returns matched evidence to append to the ATS, or needs_triage when a person must decide (several applications, none in the workspace, or the same email applied to other brands). Never picks between brands and never records an interview outcome. Changes nothing itself.",
			jsonSchema: {
				type: "object",
				properties: {
					calendar_id: { type: "string" },
					event_id: { type: "string" },
					candidate_email: { type: "string" },
					email_verification: { type: "string", enum: ["ats_application_record", "verified_mail_thread", "candidate_confirmed"] },
					workspace: { type: "string", description: "The hiring workspace, selected explicitly." },
					workspace_basis: { type: "string", enum: ["owner_instruction", "ats_application_record"] },
					applications: { type: "array", items: { type: "object", properties: { application_id: { type: "string" }, workspace: { type: "string" }, email: { type: "string" } }, required: ["application_id", "workspace", "email"] }, description: "Every application the ATS holds for this candidate email, in every workspace." },
				},
				required: ["calendar_id", "event_id", "candidate_email", "email_verification", "workspace", "workspace_basis", "applications"],
			},
			untrustedOutput: false,
			handler: reconcile,
		},
	],
};

/** The connection as the console and the connection guide report it: live when `check` is set. */
export async function calendarConnectionState(env: Env, userId: string, check: (() => Promise<string>) | null): Promise<{ access: CalendarAccess; account: string | null; accounts: number; message: string | null }> {
	const accounts = await listConnectorAccounts(env, userId, GOOGLE_CALENDAR_PROVIDER);
	if (accounts.length === 0) return { access: "not_connected", account: null, accounts: 0, message: CALENDAR_NOT_CONNECTED };
	const account = accounts[0].label ?? null;
	if (!check) return { access: "ok", account, accounts: accounts.length, message: null };
	try {
		await check();
		return { access: "ok", account, accounts: accounts.length, message: null };
	} catch (e) {
		const { access, message } = accessFromError(e);
		return { access, account, accounts: accounts.length, message };
	}
}
