/**
 * #1313 — Google Calendar end to end: the owner's grant routes, the agent's tool route, a real encrypted
 * vault row for the account connection, and a fake Google that records every request. Measures what the
 * issue's acceptance asks: an exact calendar can be granted and read in a bounded window, an ungranted
 * calendar cannot, nothing is ever written, and OAuth failure, revocation and denial each read as what
 * they are.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { saveConnectorRefreshToken } from "../lib/connector-oauth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { calendarRoutes } = await import("./calendar.js");
const { toolRoutes } = await import("./tools.js");
const { connectorRoutes } = await import("./connectors.js");
const { keysRoutes } = await import("./keys.js");

const INSTANCE = "inst-hiring";
const BB = "betabuilders.org@gmail.com";
const FAMILY = "family@gmail.com";
const HIDDEN = "not-shared@gmail.com";
const REFRESH = "1//refresh-token-never-to-appear-anywhere";
const CAL_TOOLS = ["calendar_list_granted_calendars", "calendar_list_events", "calendar_get_event", "calendar_reconcile_interview"];

let d1: RealSchemaD1;
let env: Env;
let google: Array<{ url: string; method: string; auth: string | null }>;
let refreshRevoked: boolean;
let eventsPage: (url: URL) => { status: number; body: unknown };

const app = new Hono<{ Bindings: Env }>();
app.route("/v1/calendar", calendarRoutes);
app.route("/v1/instances", toolRoutes);
app.route("/v1/connectors", connectorRoutes);
app.route("/v1/keys", keysRoutes);
app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const EVENT = (id: string, email = "ada@example.com") => ({ id, summary: "Interview", organizer: { email: BB }, attendees: [{ email, responseStatus: "accepted" }], start: { dateTime: "2026-10-25T10:00:00Z" }, end: { dateTime: "2026-10-25T10:30:00Z" }, updated: "2026-10-20T00:00:00Z" });

beforeEach(async () => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 'hiring-comms', 'Hiring Comms', '${JSON.stringify({ capabilities: { surfaces: [], runtime: null, tools: CAL_TOOLS } })}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('${INSTANCE}', 'ag', 'u1', 'active', '{}')`);
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "a".repeat(64), SESSION_SIGNING_KEY: "s".repeat(64), GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret" } as unknown as Env;
	google = [];
	refreshRevoked = false;
	eventsPage = () => ({ status: 200, body: { summary: "Beta Builders", items: [] } });
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		google.push({ url: url.toString(), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("Authorization") });
		if (url.host === "oauth2.googleapis.com") return refreshRevoked ? json({ error: "invalid_grant" }, 400) : json({ access_token: "access-1", expires_in: 3600 });
		const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
		if (!m) return json({ error: { message: "unknown" } }, 404);
		const calendar = decodeURIComponent(m[1]);
		if (calendar === HIDDEN) return json({ error: { message: "Forbidden" } }, 403);
		const r = eventsPage(url);
		return json(r.body, r.status);
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

const connect = () => saveConnectorRefreshToken(env, { userId: "u1", provider: "google_calendar", refreshToken: REFRESH, accountLabel: "owner@gmail.com" });
async function call(method: string, path: string, body?: unknown) {
	const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env, { waitUntil: () => {}, passThroughOnException: () => {}, props: {} });
	const raw = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, raw, json: (raw.startsWith("{") ? JSON.parse(raw) : {}) as Record<string, any> };
}
const grant = (calendarId: unknown) => call("POST", `/v1/calendar/instances/${INSTANCE}/grants`, { calendarId });
const tool = (name: string, args: Record<string, unknown> = {}) => call("POST", `/v1/instances/${INSTANCE}/tools/${name}`, args);
const audits = () => (d1.sqlite.prepare("SELECT event, level, context FROM agent_events WHERE source = 'calendar' ORDER BY rowid").all() as Array<{ event: string; level: string; context: string }>).map((e) => ({ ...e, context: JSON.parse(e.context) }));
const stored = () => (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => JSON.stringify(d1.sqlite.prepare(`SELECT * FROM "${t.name}"`).all())).join("\n");
/** The tool's JSON payload, with the untrusted-content fence the dispatcher wraps third-party text in taken off. */
// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON text
const result = (r: { json: Record<string, any> }): Record<string, any> => {
	const c = String(r.json.content ?? "");
	return JSON.parse(c.slice(c.indexOf("{\n"), c.lastIndexOf("}") + 1));
};

describe("the connection state is live (#1313)", () => {
	it("not connected, then connected, then revoked — each read as what it is", async () => {
		expect((await call("GET", "/v1/calendar/status?check=1")).json).toMatchObject({ access: "not_connected", accounts: 0 });
		await connect();
		expect((await call("GET", "/v1/calendar/status")).json).toMatchObject({ access: "ok", account: "owner@gmail.com", checked: false });
		expect((await call("GET", "/v1/calendar/status?check=1")).json).toMatchObject({ access: "ok", checked: true });
		refreshRevoked = true;
		const revoked = await call("GET", "/v1/calendar/status?check=1");
		expect(revoked.status).toBe(200); // a revoked Google connection is DATA here, never a 401 that signs the owner out
		expect(revoked.json).toMatchObject({ access: "revoked", account: "owner@gmail.com", message: expect.stringMatching(/revoked or expired/) });
	});
});

describe("granting one exact calendar (#1313)", () => {
	it("verifies the calendar with Google, stores the verified name, and is idempotent", async () => {
		await connect();
		const g = await grant(BB);
		expect(g.status).toBe(201);
		expect(g.json.grant).toMatchObject({ resourceId: BB, resourceName: "Beta Builders", resourceType: "google_calendar" });
		const again = await grant(BB);
		expect(again.status).toBe(200);
		expect(again.json.grant.id).toBe(g.json.grant.id);
		expect((await call("GET", `/v1/calendar/instances/${INSTANCE}/grants`)).json.grants).toHaveLength(1);
		expect(audits().map((a) => a.event)).toEqual(["calendar.grant"]);
		// Google saw GETs only, bearing the minted access token and never the refresh token.
		expect(google.filter((g2) => g2.url.includes("/calendar/v3")).every((g2) => g2.method === "GET" && g2.auth === "Bearer access-1")).toBe(true);
	});

	it("refuses a calendar the connected account cannot read (denied), storing nothing", async () => {
		await connect();
		const r = await grant(HIDDEN);
		expect(r.status).toBe(403);
		expect(r.json.error).toMatch(/cannot read the calendar "not-shared@gmail\.com".*not granted/);
		expect((await call("GET", `/v1/calendar/instances/${INSTANCE}/grants`)).json.grants).toEqual([]);
		expect(audits()).toMatchObject([{ event: "calendar.grant_refused", level: "warn", context: { outcome: "denied", calendarId: HIDDEN } }]);
	});

	it("refuses without a connection (409), and on a revoked connection (409) — OAuth failure", async () => {
		const none = await grant(BB);
		expect(none.status).toBe(409);
		expect(none.json.error).toMatch(/not connected/);
		await connect();
		refreshRevoked = true;
		const revoked = await grant(BB);
		expect(revoked.status).toBe(409);
		expect(revoked.json.error).toMatch(/revoked or expired.*Reconnect/);
		expect((await call("GET", `/v1/calendar/instances/${INSTANCE}/grants`)).json.grants).toEqual([]);
	});

	it("refuses `primary`, a missing id, and an agent that declares none of the calendar tools", async () => {
		await connect();
		expect((await grant("primary")).status).toBe(400);
		expect((await grant(undefined)).status).toBe(400);
		d1.exec(`UPDATE agents SET config = '${JSON.stringify({ capabilities: { surfaces: [], runtime: null, tools: ["read_memory"] } })}' WHERE id = 'ag'`);
		const r = await grant(BB);
		expect(r.status).toBe(403);
		expect(r.json.error).toMatch(/declares none of that connector's tools/);
	});

	it("revokes by grant id, and says so when it is already gone", async () => {
		await connect();
		const g = await grant(BB);
		expect((await call("DELETE", `/v1/calendar/instances/${INSTANCE}/grants/${g.json.grant.id}`)).json).toEqual({ success: true });
		expect((await call("DELETE", `/v1/calendar/instances/${INSTANCE}/grants/${g.json.grant.id}`)).status).toBe(404);
		expect(audits().map((a) => a.event)).toEqual(["calendar.grant", "calendar.revoke"]);
	});
});

describe("the agent's tools through the real tool route (#1313)", () => {
	it("lists a bounded window of a granted calendar, paginates, and retrieves one returned event", async () => {
		await connect();
		await grant(BB);
		eventsPage = (url) => (url.searchParams.get("pageToken") === "P2" ? { status: 200, body: { items: [EVENT("e3")] } } : { status: 200, body: { items: [EVENT("e1"), EVENT("e2")], nextPageToken: "P2" } });
		const first = result(await tool("calendar_list_events", { calendar_id: BB }));
		expect(first).toMatchObject({ calendar_id: BB, count: 2, next_page_token: "P2" });
		const win = new Date(first.window.timeMax).getTime() - new Date(first.window.timeMin).getTime();
		expect(win).toBeLessThanOrEqual(62 * 86_400_000); // the default window is bounded
		const second = result(await tool("calendar_list_events", { calendar_id: BB, page_token: "P2" }));
		expect(second.events.map((e: { eventId: string }) => e.eventId)).toEqual(["e3"]);
		eventsPage = () => ({ status: 200, body: EVENT("e1") });
		expect(result(await tool("calendar_get_event", { calendar_id: BB, event_id: "e1" }))).toMatchObject({ eventId: "e1", calendarId: BB, attendees: [{ email: "ada@example.com", rsvp: "accepted" }] });
	});

	it("cannot read another calendar of the same Google account, scan unboundedly, or mutate", async () => {
		await connect();
		await grant(BB);
		const before = google.length;
		const other = await tool("calendar_list_events", { calendar_id: FAMILY });
		expect(JSON.stringify(other.json)).toMatch(/holds no grant for the calendar \\?"family@gmail\.com/);
		const sweep = await tool("calendar_list_events", { calendar_id: BB, time_min: "2020-01-01T00:00:00Z", time_max: "2026-10-01T00:00:00Z" });
		expect(JSON.stringify(sweep.json)).toMatch(/wider than 62 days/);
		expect(google.length).toBe(before); // neither reached Google
		for (const verb of ["calendar_create_event", "calendar_update_event", "calendar_delete_event"]) expect((await tool(verb, { calendar_id: BB })).status).toBeGreaterThanOrEqual(400);
		// The only non-GET Google ever saw is the OAuth token refresh; the Calendar API got GETs alone.
		expect(google.filter((g) => g.url.includes("/calendar/v3")).every((g) => g.method === "GET")).toBe(true);
		expect(google.filter((g) => g.method !== "GET").every((g) => g.url.startsWith("https://oauth2.googleapis.com/token"))).toBe(true);
	});

	it("reads as revoked after the owner revokes the connection at Google, and as denied after the calendar is unshared", async () => {
		await connect();
		await grant(BB);
		refreshRevoked = true;
		expect(JSON.stringify((await tool("calendar_list_events", { calendar_id: BB })).json)).toMatch(/revoked or expired/);
		refreshRevoked = false;
		eventsPage = () => ({ status: 403, body: { error: { message: "Forbidden" } } });
		expect(JSON.stringify((await tool("calendar_list_events", { calendar_id: BB })).json)).toMatch(/no longer shared/);
		expect(audits().filter((a) => a.event === "calendar.list").map((a) => a.context.outcome)).toEqual(["revoked", "denied"]);
	});

	it("stops reading the moment the owner revokes the grant", async () => {
		await connect();
		const g = await grant(BB);
		expect(result(await tool("calendar_list_events", { calendar_id: BB })).count).toBe(0);
		await call("DELETE", `/v1/calendar/instances/${INSTANCE}/grants/${g.json.grant.id}`);
		expect(JSON.stringify((await tool("calendar_list_events", { calendar_id: BB })).json)).toMatch(/holds no grant/);
	});

	it("shows the agent its live granted connection in the tool list", async () => {
		await connect();
		await grant(BB);
		const live = result(await tool("calendar_list_granted_calendars"));
		expect(live).toMatchObject({ connection: { access: "ok", account: "owner@gmail.com" }, calendars: [{ calendarId: BB, name: "Beta Builders" }] });
		refreshRevoked = true;
		expect(result(await tool("calendar_list_granted_calendars")).connection.access).toBe("revoked");
	});

	it("reconciles a FreeAppStore candidate on the Beta Builders calendar only with explicit evidence, and leaves cross-brand ambiguity to a human", async () => {
		await connect();
		await grant(BB);
		eventsPage = () => ({ status: 200, body: EVENT("e1") });
		const base = { calendar_id: BB, event_id: "e1", candidate_email: "ada@example.com", email_verification: "ats_application_record", workspace: "FreeAppStore", workspace_basis: "owner_instruction" };
		const fas = { application_id: "a-fas", workspace: "FreeAppStore", email: "ada@example.com" };
		const bb = { application_id: "a-bb", workspace: "BetaBuilders", email: "ada@example.com" };
		expect(result(await tool("calendar_reconcile_interview", { ...base, applications: [fas] }))).toMatchObject({ decision: "matched", evidence: { workspace: "FreeAppStore", applicationId: "a-fas" } });
		expect(result(await tool("calendar_reconcile_interview", { ...base, workspace: "BetaBuilders", workspace_basis: "ats_application_record", applications: [bb, fas] }))).toMatchObject({ decision: "needs_triage", reason: "cross_brand_ambiguity" });
		// A missing workspace never reaches the handler: it is a required field of the tool's own schema.
		const noWorkspace = await tool("calendar_reconcile_interview", { ...base, workspace: undefined, applications: [fas] });
		expect(noWorkspace.raw).toMatch(/workspace/);
		expect(noWorkspace.raw).not.toMatch(/matched/);
		// A blank one does, and is refused by the safeguard itself.
		expect(result(await tool("calendar_reconcile_interview", { ...base, workspace: " ", applications: [fas] }))).toMatchObject({ decision: "refused" });
	});
});

describe("disconnecting revokes what was granted (#1313)", () => {
	it("disconnecting Google Calendar revokes every calendar grant, so a reconnect does not silently re-arm them", async () => {
		await connect();
		await grant(BB);
		const gone = await call("DELETE", "/v1/connectors/google_calendar/oauth");
		expect(gone.status).toBe(200);
		expect((await call("GET", `/v1/calendar/instances/${INSTANCE}/grants`)).json.grants).toEqual([]);
		await connect();
		expect(JSON.stringify((await tool("calendar_list_events", { calendar_id: BB })).json)).toMatch(/holds no grant/);
	});
	it("removing the key from Profile → API Keys revokes them too", async () => {
		await connect();
		await grant(BB);
		expect((await call("DELETE", "/v1/keys/google_calendar")).json).toMatchObject({ success: true, revoked: { grants: 1, instances: 1 } });
		expect((await call("GET", `/v1/calendar/instances/${INSTANCE}/grants`)).json.grants).toEqual([]);
	});
});

describe("nothing secret is stored or said (#1313)", () => {
	it("the refresh token is encrypted at rest and appears in no audit row or tool result", async () => {
		await connect();
		await grant(BB);
		const out = [(await tool("calendar_list_events", { calendar_id: BB })).raw, (await tool("calendar_list_granted_calendars")).raw, (await call("GET", "/v1/calendar/status?check=1")).raw];
		const everything = [...out, stored(), JSON.stringify(audits())].join("\n");
		expect(everything).not.toContain(REFRESH);
		expect(everything).not.toContain("access-1");
	});
});
