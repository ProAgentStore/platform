/**
 * Google Calendar, read-only (#1313): bounded event list and get against ONE exact calendar.
 *
 * ── What this module will not do
 *
 * It has no create, update, delete or move: the only HTTP method used is GET, and the OAuth scope
 * the connector asks for (`calendar.events.readonly`) could not do more if a bug added one. Which
 * calendar is read is never inferred — every function takes the exact calendar id the owner granted
 * to the agent, and `primary` is refused because "the primary calendar" is whichever account the
 * token happens to belong to, not a thing an owner granted.
 *
 * ── Why the window is bounded here and not at the tool
 *
 * An interview reconciliation looks a few weeks either way. An unbounded historical sweep reads an
 * owner's whole calendar and buys nothing, so {@link boundedWindow} refuses one: the window is at most
 * {@link MAX_WINDOW_DAYS} wide and no further than {@link MAX_LOOKBACK_DAYS} back or
 * {@link MAX_LOOKAHEAD_DAYS} ahead. Omitted bounds default to a week back and a month ahead.
 *
 * ── What an event carries out
 *
 * Only the metadata reconciliation needs: ids, title, organiser, attendees with RSVP, times, the
 * join URL and last-updated. The description and attachments are NOT returned — they are free text
 * written by whoever sent the invite, and nothing in reconciliation needs them.
 */
import { clipMarked } from "./clip-marked.js";
import { safeFetch } from "./ssrf.js";

export const GOOGLE_CALENDAR_PROVIDER = "google_calendar";
/** The grant's `resourceType`: one exact calendar id granted to one agent. */
export const GOOGLE_CALENDAR_GRANT = "google_calendar";
/** Read events only. No calendar-list scope, no write scope. */
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

const API = "https://www.googleapis.com/calendar/v3";
const DAY_MS = 86_400_000;
export const MAX_WINDOW_DAYS = 62;
export const MAX_LOOKBACK_DAYS = 400;
export const MAX_LOOKAHEAD_DAYS = 400;
export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_LOOKAHEAD_DAYS = 30;
export const MAX_RESULTS = 50;
export const DEFAULT_RESULTS = 25;
const TITLE_CHARS = 300;
const ATTENDEES_PER_EVENT = 100;

export interface CalendarAttendee {
	email: string;
	displayName: string | null;
	/** needsAction | declined | tentative | accepted */
	rsvp: string | null;
	organizer: boolean;
	optional: boolean;
	resource: boolean;
}

export interface CalendarEvent {
	calendarId: string;
	eventId: string;
	status: string | null;
	title: string;
	organizer: { email: string | null; displayName: string | null } | null;
	attendees: CalendarAttendee[];
	/** `attendeesOmitted` is how many were dropped past {@link ATTENDEES_PER_EVENT}. */
	attendeesOmitted: number;
	start: { dateTime: string | null; date: string | null; timeZone: string | null };
	end: { dateTime: string | null; date: string | null; timeZone: string | null };
	joinUrl: string | null;
	updated: string | null;
}

export interface EventPage {
	calendarId: string;
	/** The calendar's own name as Google reports it. */
	calendarName: string | null;
	events: CalendarEvent[];
	nextPageToken: string | null;
	/** Events Google returned that the attendee filter dropped. */
	filteredOut: number;
	window: { timeMin: string; timeMax: string };
}

/** A refusal with a stable `code` the caller can branch on and a sentence it can relay. */
export class CalendarError extends Error {
	constructor(
		public readonly code: "bad_input" | "reauth" | "denied" | "not_found" | "stale_page" | "rate_limited" | "upstream",
		message: string,
	) {
		super(message);
	}
}

const CALENDAR_ID = /^[A-Za-z0-9._+\-#@]{3,254}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE_TOKEN = /^[A-Za-z0-9._~+/=-]{1,2048}$/;

/** The exact calendar id, or a refusal. `primary` is not an exact id. */
export function exactCalendarId(value: unknown): string {
	const id = typeof value === "string" ? value.trim() : "";
	if (!id) throw new CalendarError("bad_input", "calendar_id is required — the exact calendar id the owner granted (an address such as betabuilders.org@gmail.com).");
	if (id.toLowerCase() === "primary") throw new CalendarError("bad_input", 'calendar_id "primary" is not an exact calendar. Use the calendar\'s own id, from calendar_list_granted_calendars.');
	if (!CALENDAR_ID.test(id)) throw new CalendarError("bad_input", "calendar_id is not a valid calendar id.");
	return id;
}

export function eventIdOf(value: unknown): string {
	const id = typeof value === "string" ? value.trim() : "";
	if (!id) throw new CalendarError("bad_input", "event_id is required — copy one from a calendar_list_events result.");
	if (!EVENT_ID.test(id)) throw new CalendarError("bad_input", "event_id is not a valid event id; copy it exactly from calendar_list_events.");
	return id;
}

export function normalEmail(value: unknown): string | null {
	const e = typeof value === "string" ? value.trim().toLowerCase() : "";
	return EMAIL.test(e) ? e : null;
}

/**
 * The window to read: both bounds given and inside the limits, or both defaulted around `now`.
 * Giving only one bound is refused rather than guessed — the other end would be unbounded.
 */
export function boundedWindow(timeMin: unknown, timeMax: unknown, now: number = Date.now()): { timeMin: string; timeMax: string } {
	const has = (v: unknown) => typeof v === "string" && v.trim() !== "";
	if (has(timeMin) !== has(timeMax)) throw new CalendarError("bad_input", "Give both time_min and time_max, or neither (the default is the last 7 days and the next 30). A one-sided window would be unbounded.");
	if (!has(timeMin)) return { timeMin: new Date(now - DEFAULT_LOOKBACK_DAYS * DAY_MS).toISOString(), timeMax: new Date(now + DEFAULT_LOOKAHEAD_DAYS * DAY_MS).toISOString() };
	const lo = Date.parse(String(timeMin));
	const hi = Date.parse(String(timeMax));
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new CalendarError("bad_input", "time_min and time_max must be RFC 3339 timestamps, e.g. 2026-10-01T00:00:00Z.");
	if (hi <= lo) throw new CalendarError("bad_input", "time_max must be after time_min.");
	if (hi - lo > MAX_WINDOW_DAYS * DAY_MS) throw new CalendarError("bad_input", `The window is wider than ${MAX_WINDOW_DAYS} days. Read it in slices of at most ${MAX_WINDOW_DAYS} days; an unbounded sweep is refused.`);
	if (lo < now - MAX_LOOKBACK_DAYS * DAY_MS || hi > now + MAX_LOOKAHEAD_DAYS * DAY_MS) throw new CalendarError("bad_input", `The window reaches more than ${MAX_LOOKBACK_DAYS} days back or ${MAX_LOOKAHEAD_DAYS} days ahead, which is refused.`);
	return { timeMin: new Date(lo).toISOString(), timeMax: new Date(hi).toISOString() };
}

export function pageTokenOf(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !PAGE_TOKEN.test(value)) throw new CalendarError("bad_input", "page_token must be the next_page_token a previous calendar_list_events returned, copied exactly.");
	return value;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function when(raw: unknown): CalendarEvent["start"] {
	const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return { dateTime: str(r.dateTime), date: str(r.date), timeZone: str(r.timeZone) };
}

/** Google's event resource → the fields reconciliation needs. Pure. */
export function normalizeEvent(calendarId: string, raw: unknown): CalendarEvent | null {
	if (!raw || typeof raw !== "object") return null;
	const e = raw as Record<string, unknown>;
	const eventId = str(e.id);
	if (!eventId) return null;
	const attendeesRaw = Array.isArray(e.attendees) ? e.attendees : [];
	const attendees: CalendarAttendee[] = attendeesRaw.slice(0, ATTENDEES_PER_EVENT).flatMap((a) => {
		const r = a && typeof a === "object" ? (a as Record<string, unknown>) : {};
		const email = normalEmail(r.email);
		return email ? [{ email, displayName: str(r.displayName), rsvp: str(r.responseStatus), organizer: r.organizer === true, optional: r.optional === true, resource: r.resource === true }] : [];
	});
	const org = e.organizer && typeof e.organizer === "object" ? (e.organizer as Record<string, unknown>) : null;
	const conference = e.conferenceData && typeof e.conferenceData === "object" ? (e.conferenceData as { entryPoints?: unknown }) : null;
	const video = Array.isArray(conference?.entryPoints) ? (conference.entryPoints as Array<Record<string, unknown>>).find((p) => p?.entryPointType === "video") : undefined;
	return {
		calendarId,
		eventId,
		status: str(e.status),
		title: clipMarked(typeof e.summary === "string" ? e.summary : "", TITLE_CHARS),
		organizer: org ? { email: normalEmail(org.email), displayName: str(org.displayName) } : null,
		attendees,
		attendeesOmitted: Math.max(0, attendeesRaw.length - attendees.length),
		start: when(e.start),
		end: when(e.end),
		joinUrl: str(e.hangoutLink) ?? str(video?.uri),
		updated: str(e.updated),
	};
}

/** Is this email the organiser or an attendee of the event? Exact, case-insensitive; never a substring. */
export function eventInvolves(event: Pick<CalendarEvent, "organizer" | "attendees">, email: string): { attendee: boolean; organizer: boolean } {
	const want = email.trim().toLowerCase();
	return { attendee: event.attendees.some((a) => a.email === want), organizer: event.organizer?.email === want };
}

/** Google's failure → the sentence the owner or agent acts on. Never passes a 401 on as a PAGS 401. */
export function calendarFailure(status: number, detail: string): CalendarError {
	if (status === 401) return new CalendarError("reauth", `Google rejected the stored Calendar access — it was revoked or expired. The owner reconnects Google Calendar in Preferences → Connections. (Google: ${detail})`);
	if (status === 403) return new CalendarError("denied", `Google denies this account access to that calendar — it is no longer shared with the connected account, or the API refused it. (Google: ${detail})`);
	if (status === 404) return new CalendarError("not_found", `Google has no such calendar or event visible to the connected account. (Google: ${detail})`);
	if (status === 410) return new CalendarError("stale_page", "That page_token is no longer valid. Start the listing again without one.");
	if (status === 429) return new CalendarError("rate_limited", `Google rate-limited Calendar — retry shortly. (Google: ${detail})`);
	return new CalendarError("upstream", `Google Calendar returned ${status}: ${detail}`);
}

async function get(token: string, path: string, query: Record<string, string | undefined>): Promise<unknown> {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, v);
	let res: Response;
	try {
		// GET only: this module has no other method.
		res = await safeFetch(`${API}${path}${qs.size ? `?${qs}` : ""}`, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
	} catch {
		throw new CalendarError("upstream", "Google Calendar could not be reached.");
	}
	const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
	if (!res.ok) throw calendarFailure(res.status, typeof body?.error?.message === "string" ? body.error.message : "request failed");
	return body;
}

export interface ListOptions {
	timeMin: string;
	timeMax: string;
	pageToken?: string;
	maxResults?: number;
	/** Keep only events this email organises or attends — exact match, applied after Google answers. */
	attendeeEmail?: string;
}

/** One page of events on one exact calendar, singleEvents-expanded and ordered by start. */
export async function listCalendarEvents(token: string, calendarId: string, o: ListOptions): Promise<EventPage> {
	const want = o.attendeeEmail ? normalEmail(o.attendeeEmail) : null;
	if (o.attendeeEmail && !want) throw new CalendarError("bad_input", "attendee_email is not a valid email address.");
	const max = Math.min(Math.max(Math.trunc(o.maxResults ?? DEFAULT_RESULTS) || DEFAULT_RESULTS, 1), MAX_RESULTS);
	const data = (await get(token, `/calendars/${encodeURIComponent(calendarId)}/events`, {
		timeMin: o.timeMin,
		timeMax: o.timeMax,
		maxResults: String(max),
		singleEvents: "true",
		orderBy: "startTime",
		showDeleted: "false",
		pageToken: o.pageToken,
	})) as { items?: unknown; nextPageToken?: unknown; summary?: unknown } | null;
	const all = (Array.isArray(data?.items) ? data.items : []).flatMap((i) => normalizeEvent(calendarId, i) ?? []);
	const events = want ? all.filter((e) => eventInvolves(e, want).attendee || eventInvolves(e, want).organizer) : all;
	return {
		calendarId,
		calendarName: str(data?.summary),
		events,
		nextPageToken: str(data?.nextPageToken),
		filteredOut: all.length - events.length,
		window: { timeMin: o.timeMin, timeMax: o.timeMax },
	};
}

/** One event on one exact calendar. */
export async function getCalendarEvent(token: string, calendarId: string, eventId: string): Promise<CalendarEvent> {
	const data = await get(token, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {});
	const event = normalizeEvent(calendarId, data);
	if (!event) throw new CalendarError("upstream", "Google returned no event.");
	return event;
}
