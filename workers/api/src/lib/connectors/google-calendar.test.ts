/**
 * #1313 — the Google Calendar connector's tools on the real schema: granted-calendar isolation, no
 * mutation, bounded windows, pagination, OAuth failure, a revoked grant and a denied calendar, and the
 * audit trail each of them leaves. Google and the token mint are the only fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteConnectorGrant, requireConnectorGrant, upsertConnectorGrant } from "../connector-grants.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../d1-sqlite.js";
import { GOOGLE_CALENDAR_GRANT } from "../google-calendar.js";
import type { Env } from "../../types.js";
import { accessFromError, calendarConnectionState, GOOGLE_CALENDAR_CONNECTOR } from "./google-calendar.js";
import { getConnector } from "./registry.js";
import type { RegistryToolCtx } from "./types.js";

const BB = "betabuilders.org@gmail.com";
const OTHER = "private.family@gmail.com";

const tool = (name: string) => {
	const t = GOOGLE_CALENDAR_CONNECTOR.tools.find((x) => x.name === name);
	if (!t) throw new Error(`missing ${name}`);
	return t;
};

describe("the connector is read-only by declaration (#1313)", () => {
	it("is registered, OAuth-backed, read-scoped and granted per resource", () => {
		expect(getConnector("google_calendar")).toBe(GOOGLE_CALENDAR_CONNECTOR);
		expect(GOOGLE_CALENDAR_CONNECTOR).toMatchObject({ auth: "oauth", grantModel: "instance-resource", scopes: { read: true, write: false } });
		expect(GOOGLE_CALENDAR_CONNECTOR.oauth?.scopes).toEqual(["openid", "email", "https://www.googleapis.com/auth/calendar.events.readonly"]);
	});
	it("declares no tool that can create, change or delete an event", () => {
		const names = GOOGLE_CALENDAR_CONNECTOR.tools.map((t) => t.name);
		expect(names).toEqual(["calendar_list_granted_calendars", "calendar_list_events", "calendar_get_event", "calendar_reconcile_interview"]);
		expect(names.some((n) => /create|update|delete|insert|patch|move|cancel|rsvp|accept|decline/.test(n))).toBe(false);
		for (const t of GOOGLE_CALENDAR_CONNECTOR.tools) expect(t).toMatchObject({ scope: "read", mutates: false, connector: "google_calendar" });
	});
	it("fences the tools that return text strangers wrote", () => {
		expect(tool("calendar_list_events").untrustedOutput).toBe(true);
		expect(tool("calendar_get_event").untrustedOutput).toBe(true);
	});
});

describe("accessFromError names why access failed (#1313)", () => {
	it("tells not connected, unconfigured, revoked and other failures apart", () => {
		expect(accessFromError(new Error("Google Calendar is not connected"))).toMatchObject({ access: "not_connected" });
		expect(accessFromError(new Error("OAuth is not configured for the google_calendar connector on this deployment"))).toMatchObject({ access: "unconfigured" });
		expect(accessFromError(new Error("Could not refresh google_calendar access (400). Reconnect it in settings."))).toMatchObject({ access: "revoked", message: expect.stringMatching(/revoked or expired.*reconnects/) });
		expect(accessFromError(new Error("boom"))).toMatchObject({ access: "error" });
	});
});

describe("the tools, on the real schema", () => {
	let d1: RealSchemaD1;
	let env: Env;
	let tokenFails: Error | null;
	let google: Array<{ url: string; method: string }>;
	let respond: (url: URL) => { status: number; body: unknown };

	const ctx = (): RegistryToolCtx => ({
		env,
		userId: "u1",
		instanceId: "hire",
		traceId: "t1",
		connectorClient: () => ({
			connector: GOOGLE_CALENDAR_CONNECTOR,
			token: async () => {
				if (tokenFails) throw tokenFails;
				return "access-token";
			},
			// The real client's requireGrant takes the GRANT id and answers 403 for one that is gone or another agent's.
			requireGrant: (grantId: string) => requireConnectorGrant(env, "hire", "u1", "google_calendar", grantId),
			fetch: async () => new Response(),
		}),
	});
	const grant = (calendarId: string, name = calendarId) => upsertConnectorGrant(env, "hire", "u1", { provider: "google_calendar", resourceId: calendarId, resourceName: name, resourceType: GOOGLE_CALENDAR_GRANT });
	const audits = () => (d1.sqlite.prepare("SELECT event, level, context FROM agent_events WHERE source = 'calendar' ORDER BY ts, rowid").all() as Array<{ event: string; level: string; context: string }>).map((r) => ({ ...r, context: JSON.parse(r.context) }));
	const run = async (name: string, input: Record<string, unknown>) => {
		const r = await tool(name).handler(ctx(), input);
		return { ...r, json: (() => { try { return JSON.parse(r.content); } catch { return null; } })() };
	};

	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["hire", "other"] });
		env = { DB: d1.DB } as unknown as Env;
		tokenFails = null;
		google = [];
		respond = () => ({ status: 200, body: { summary: "Beta Builders", items: [] } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				google.push({ url: String(url), method: init?.method ?? "GET" });
				const r = respond(new URL(String(url)));
				return new Response(JSON.stringify(r.body), { status: r.status });
			}),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		d1.close();
	});

	it("lists only the calendars granted to THIS agent, with live connection state", async () => {
		await grant(BB, "Beta Builders");
		await upsertConnectorGrant(env, "other", "u1", { provider: "google_calendar", resourceId: OTHER, resourceName: "Family", resourceType: GOOGLE_CALENDAR_GRANT });
		const r = await run("calendar_list_granted_calendars", {});
		expect(r.success).toBe(true);
		expect(r.json.calendars).toEqual([{ calendarId: BB, name: "Beta Builders" }]);
		expect(r.json.connection.access).toBe("ok");
		expect(google).toHaveLength(0); // listing grants asks Google nothing
	});

	it("reports a revoked connection as revoked, not connected, and says what to do (OAuth failure)", async () => {
		await grant(BB);
		tokenFails = new Error("Could not refresh google_calendar access (400). Reconnect it in settings.");
		const r = await run("calendar_list_granted_calendars", {});
		expect(r.json.connection).toMatchObject({ access: "revoked", remedy: expect.stringMatching(/Preferences → Connections/) });
		expect(r.json.calendars).toHaveLength(1);
		expect((await run("calendar_list_events", { calendar_id: BB })).content).toMatch(/revoked or expired/);
		expect(google).toHaveLength(0);
		expect(audits().map((a) => [a.event, a.context.outcome])).toEqual([["calendar.list_granted", "revoked"], ["calendar.list", "revoked"]]);
	});

	it("says so when no account is connected (OAuth never completed)", async () => {
		await grant(BB);
		tokenFails = new Error("Google Calendar is not connected");
		const r = await run("calendar_list_events", { calendar_id: BB });
		expect(r).toMatchObject({ success: false, content: expect.stringMatching(/not connected/) });
	});

	it("refuses a calendar the agent was never granted, before any token or request (denied calendar)", async () => {
		await grant(BB);
		const r = await run("calendar_list_events", { calendar_id: OTHER });
		expect(r).toMatchObject({ success: false, content: expect.stringMatching(/holds no grant for the calendar "private\.family@gmail\.com"/) });
		expect((await run("calendar_get_event", { calendar_id: OTHER, event_id: "ev1" })).success).toBe(false);
		expect((await run("calendar_reconcile_interview", { calendar_id: OTHER, event_id: "ev1" })).success).toBe(false);
		expect(google).toHaveLength(0);
		expect(audits().filter((a) => a.event === "calendar.denied").map((a) => [a.level, a.context.outcome, a.context.calendarId])).toEqual([["warn", "not_granted", OTHER], ["warn", "not_granted", OTHER], ["warn", "not_granted", OTHER]]);
	});

	it("refuses `primary` and a calendar id the agent merely resembles", async () => {
		await grant(BB);
		expect((await run("calendar_list_events", { calendar_id: "primary" })).content).toMatch(/not an exact calendar/);
		expect((await run("calendar_list_events", { calendar_id: "BETABUILDERS.org@gmail.com " })).success).toBe(false); // case differs: not the granted id
		expect(google).toHaveLength(0);
	});

	it("stops reading the moment the grant is revoked", async () => {
		const g = await grant(BB);
		expect((await run("calendar_list_events", { calendar_id: BB })).success).toBe(true);
		await deleteConnectorGrant(env, "hire", "u1", "google_calendar", g.id);
		const after = await run("calendar_list_events", { calendar_id: BB });
		expect(after).toMatchObject({ success: false, content: expect.stringMatching(/holds no grant/) });
		expect(google).toHaveLength(1);
	});

	it("lists a bounded window page by page and passes the page token through", async () => {
		await grant(BB);
		respond = (url) => (url.searchParams.get("pageToken") === "P2" ? { status: 200, body: { items: [{ id: "e3" }] } } : { status: 200, body: { items: [{ id: "e1" }, { id: "e2" }], nextPageToken: "P2" } });
		const first = await run("calendar_list_events", { calendar_id: BB, time_min: "2026-10-20T00:00:00Z", time_max: "2026-11-10T00:00:00Z" });
		expect(first.json).toMatchObject({ calendar_id: BB, count: 2, next_page_token: "P2" });
		const second = await run("calendar_list_events", { calendar_id: BB, time_min: "2026-10-20T00:00:00Z", time_max: "2026-11-10T00:00:00Z", page_token: "P2" });
		expect(second.json.events.map((e: { eventId: string }) => e.eventId)).toEqual(["e3"]);
		expect(second.json.next_page_token).toBeUndefined();
		expect(google.map((c) => c.method)).toEqual(["GET", "GET"]);
		const a = audits().filter((x) => x.event === "calendar.list");
		expect(a.map((x) => [x.context.returned, x.context.paged, x.context.more])).toEqual([[2, false, true], [1, true, false]]);
	});

	it("refuses an unbounded or historical sweep without calling Google, and audits the refusal", async () => {
		await grant(BB);
		const wide = await run("calendar_list_events", { calendar_id: BB, time_min: "2025-01-01T00:00:00Z", time_max: "2026-10-01T00:00:00Z" });
		const oneSided = await run("calendar_list_events", { calendar_id: BB, time_min: "2026-10-01T00:00:00Z" });
		expect(wide.content).toMatch(/wider than 62 days/);
		expect(oneSided.content).toMatch(/both time_min and time_max/);
		expect(google).toHaveLength(0);
		expect(audits().map((a) => [a.event, a.context.outcome])).toEqual([["calendar.list", "bad_input"], ["calendar.list", "bad_input"]]);
	});

	it("filters by attendee email and reports what it dropped", async () => {
		await grant(BB);
		respond = () => ({ status: 200, body: { items: [{ id: "e1", attendees: [{ email: "ada@example.com" }] }, { id: "e2", attendees: [{ email: "bob@example.com" }] }] } });
		const r = await run("calendar_list_events", { calendar_id: BB, attendee_email: "Ada@Example.com" });
		expect(r.json).toMatchObject({ count: 1, filtered_out: 1 });
		const logged = JSON.stringify(audits());
		expect(logged).not.toMatch(/ada@example\.com|bob@example\.com/i); // the audit says a filter ran, never whose address
		expect(audits()[0].context.attendeeFilter).toBe(true);
	});

	it("gets one event, and relays Google denying or not finding it", async () => {
		await grant(BB);
		respond = () => ({ status: 200, body: { id: "ev1", summary: "Interview", start: { dateTime: "2026-10-25T10:00:00Z" } } });
		expect((await run("calendar_get_event", { calendar_id: BB, event_id: "ev1" })).json).toMatchObject({ calendarId: BB, eventId: "ev1", title: "Interview" });
		respond = () => ({ status: 403, body: { error: { message: "Forbidden" } } });
		expect(await run("calendar_get_event", { calendar_id: BB, event_id: "ev1" })).toMatchObject({ success: false, content: expect.stringMatching(/no longer shared/) });
		respond = () => ({ status: 404, body: { error: { message: "Not Found" } } });
		expect((await run("calendar_get_event", { calendar_id: BB, event_id: "gone" })).content).toMatch(/no such calendar or event/);
		expect(audits().filter((a) => a.event === "calendar.get").map((a) => a.context.outcome)).toEqual(["ok", "denied", "not_found"]);
		expect(google.every((c) => c.method === "GET")).toBe(true);
	});

	describe("interview reconciliation through the tool", () => {
		const base = { calendar_id: BB, event_id: "ev1", candidate_email: "ada@example.com", email_verification: "ats_application_record", workspace: "FreeAppStore", workspace_basis: "owner_instruction" };
		const fas = { application_id: "app-fas-1", workspace: "FreeAppStore", email: "ada@example.com" };
		const bb = { application_id: "app-bb-1", workspace: "BetaBuilders", email: "ada@example.com" };
		beforeEach(async () => {
			await grant(BB);
			respond = () => ({ status: 200, body: { id: "ev1", summary: "BetaBuilders interview", organizer: { email: BB }, attendees: [{ email: "ada@example.com" }], updated: "2026-10-20T00:00:00Z" } });
		});

		it("matches under the explicitly selected workspace and audits the calendar id and opaque event id, not the candidate", async () => {
			const r = await run("calendar_reconcile_interview", { ...base, applications: [fas] });
			expect(r.json).toMatchObject({ decision: "matched", evidence: { calendarId: BB, eventId: "ev1", applicationId: "app-fas-1", workspace: "FreeAppStore" } });
			expect(r.json.next).toMatch(/has not written to any ATS/);
			const a = audits().find((x) => x.event === "calendar.reconcile");
			expect(a?.context).toMatchObject({ outcome: "matched", calendarId: BB, eventId: "ev1", applicationId: "app-fas-1", workspace: "FreeAppStore" });
			expect(JSON.stringify(a)).not.toMatch(/ada@example\.com/);
		});

		it("leaves a cross-brand ambiguity for a human and files nothing against either brand", async () => {
			const r = await run("calendar_reconcile_interview", { ...base, workspace_basis: "ats_application_record", applications: [fas, bb] });
			expect(r.json).toMatchObject({ decision: "needs_triage", reason: "cross_brand_ambiguity" });
			expect(r.json.next).toMatch(/Do not attach/);
			expect(r.json.evidence).toBeUndefined();
			expect(audits().find((x) => x.event === "calendar.reconcile_triage")).toMatchObject({ level: "warn", context: { outcome: "cross_brand_ambiguity", calendarId: BB, eventId: "ev1" } });
		});

		it("refuses without verified email or an explicit workspace, and says so in the audit", async () => {
			expect((await run("calendar_reconcile_interview", { ...base, email_verification: undefined, applications: [fas] })).json).toMatchObject({ decision: "refused" });
			expect((await run("calendar_reconcile_interview", { ...base, workspace: "", applications: [fas] })).json).toMatchObject({ decision: "refused" });
			expect(audits().filter((x) => x.event === "calendar.reconcile").map((x) => x.context.outcome)).toEqual(["refused", "refused"]);
		});
	});

	it("reports the connection state for the status route: connected, revoked, and no account", async () => {
		d1.exec("INSERT INTO user_api_keys (user_id, provider, account_id, account_label, key_ciphertext, dek_wrapped, iv, granted_scopes) VALUES ('u1', 'google_calendar', '', 'owner@gmail.com', x'00', x'00', x'00', 'openid email')");
		expect(await calendarConnectionState(env, "u1", async () => "tok")).toMatchObject({ access: "ok", account: "owner@gmail.com" });
		expect(await calendarConnectionState(env, "u1", async () => { throw new Error("Could not refresh google_calendar access (400). Reconnect it in settings."); })).toMatchObject({ access: "revoked", account: "owner@gmail.com" });
		d1.exec("DELETE FROM user_api_keys");
		expect(await calendarConnectionState(env, "u1", null)).toMatchObject({ access: "not_connected", accounts: 0 });
	});
});
