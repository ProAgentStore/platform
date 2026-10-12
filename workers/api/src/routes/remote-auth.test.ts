/**
 * PAS remote sign-in requests (#1005), design A (#1006): the owner's machine relays a PAS broker request's
 * public details, PAGS pushes a link to that exact request and shows it, and the page links to PAS. Real schema,
 * real routes; only the signed-in user is faked. Every fixture is synthetic — no PAS call, credential or grant.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { checkConsoleLink } from "../../../../store/console/src/lib/routes.js";
import type { Env } from "../types.js";

const who = vi.hoisted(() => ({ uid: "u1" }));
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: who.uid, roles: [] }) };
});
const { remoteAuthRoutes } = await import("./remote-auth.js");

let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB }) as unknown as Env;
const app = () => {
	const a = new Hono<{ Bindings: Env }>().route("/v1/remote-auth", remoteAuthRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
};
async function call(method: string, path: string, body?: unknown, uid = "u1") {
	who.uid = uid;
	const res = await app().request(`/v1/remote-auth${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: assertions read the JSON field by field
	return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
}
const notifications = () => d1.sqlite.prepare("SELECT type, title, body, url, kind FROM notifications ORDER BY created_at, rowid").all() as Array<Record<string, string>>;

const MACHINE = { node: "mac-mini", machine_id: "m-1" };
const relay = (over: Record<string, unknown> = {}) => ({
	request_id: "req_AbCdEfGhIjKlMnOpQrStUv",
	agent: { id: "codex", label: "Codex" },
	machine: { id: "mac-42", label: "Remote Mac" },
	resource: "https://mcp.proappstore.online/mcp/apps/example",
	scopes: [],
	approval_url: "https://api.proappstore.online/v1/mcp/broker/v2/requests/req_AbCdEfGhIjKlMnOpQrStUv/approve",
	expires_at: Date.now() + 10 * 60_000,
	relayed_by: MACHINE,
	...over,
});

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
});
afterEach(() => d1.close());

describe("relay → push → the exact request", () => {
	it("stores the request, pushes ONE same-origin link to it, and the page reads it with the details to approve", async () => {
		const r = await call("POST", "/requests", relay());
		expect(r.status).toBe(201);
		const id = r.body.request.id as string;
		expect(r.body).toMatchObject({ duplicate: false, url: `/console/remote-auth/${id}`, request: { state: "pending", effectiveState: "pending", pasRequestId: "req_AbCdEfGhIjKlMnOpQrStUv" } });
		const [n] = notifications();
		expect(notifications()).toHaveLength(1);
		expect(n).toMatchObject({ type: "remote-auth", kind: "alert", url: `/console/remote-auth/${id}` });
		expect(n.body).toMatch(/Codex on Remote Mac asks to connect to ProAppStore MCP \(\/mcp\/apps\/example\)/);
		expect(checkConsoleLink(n.url)).toMatchObject({ ok: true }); // the link resolves to a real console route
		const page = await call("GET", `/requests/${id}`);
		expect(page.body.request).toMatchObject({
			agent: { id: "codex", label: "Codex" },
			machine: { id: "mac-42", label: "Remote Mac" },
			relayedBy: { node: "mac-mini", machineId: "m-1" },
			service: "ProAppStore MCP",
			resource: "https://mcp.proappstore.online/mcp/apps/example",
			scopes: [],
			approvalUrl: relay().approval_url,
		});
		expect(page.headers.get("cache-control")).toBe("no-store");
		expect(page.headers.get("referrer-policy")).toBe("no-referrer");
	});

	it("a repeated relay (duplicate tap, retried CLI) is the same request: no second row, no second push", async () => {
		const same = relay(); // a retry resends the SAME payload
		const a = await call("POST", "/requests", same);
		const b = await call("POST", "/requests", same);
		expect(b.status).toBe(200);
		expect(b.body).toMatchObject({ duplicate: true, request: { id: a.body.request.id } });
		expect(notifications()).toHaveLength(1);
	});

	it("the same PAS id with different details — or from another machine — is refused, never merged", async () => {
		const first = relay();
		await call("POST", "/requests", first);
		expect((await call("POST", "/requests", { ...first, resource: "https://mcp.proappstore.online/mcp" })).status).toBe(409);
		expect((await call("POST", "/requests", { ...first, relayed_by: { node: "other", machine_id: "m-2" } })).status).toBe(409);
		expect(notifications()).toHaveLength(1);
	});

	it("another owner can neither read it nor report on it", async () => {
		const { body } = await call("POST", "/requests", relay());
		expect((await call("GET", `/requests/${body.request.id}`, undefined, "u2")).status).toBe(404);
		expect((await call("POST", `/requests/${body.request.id}/state`, { state: "denied", relayed_by: MACHINE }, "u2")).status).toBe(404);
	});
});

describe("only a PAS request's public details are accepted — never a credential", () => {
	it.each([
		["a non-PAS approval page", { approval_url: "https://evil.example/approve" }],
		["an http approval page", { approval_url: "http://api.proappstore.online/approve" }],
		["a token in the approval URL", { approval_url: "https://api.proappstore.online/approve?token=abc" }],
		["an OAuth code in the approval URL", { approval_url: "https://proappstore.online/cb?code=abc&state=x" }],
		["credentials in the approval URL", { approval_url: "https://user:pw@api.proappstore.online/approve" }],
		["a resource on another origin", { resource: "https://mcp.example.com/mcp" }],
		["a resource with a query", { resource: "https://mcp.proappstore.online/mcp?x=1" }],
		["a non-empty scope", { scopes: ["admin"] }],
		["a request id that is not PAS's", { request_id: "abc" }],
		["an expiry in the past", { expires_at: Date.now() - 1000 }],
		["an expiry days away", { expires_at: Date.now() + 3 * 86_400_000 }],
		["no agent", { agent: { id: "codex" } }],
	])("refuses %s, naming the field and never echoing it", async (_label, over) => {
		const r = await call("POST", "/requests", relay(over));
		expect(r.status).toBe(400);
		expect(r.body.error).not.toMatch(/abc|evil|pw@/);
		expect(notifications()).toEqual([]);
	});

	it("no notification, response or stored row carries a secret-shaped value", async () => {
		const r = await call("POST", "/requests", relay());
		const all = JSON.stringify([r.body, notifications(), d1.sqlite.prepare("SELECT * FROM remote_auth_requests").all()]);
		expect(all).not.toMatch(/access_token|id_token|code_verifier|machine_proof|Bearer /i);
	});
});

describe("the machine reports the broker states it observes", () => {
	const create = async () => (await call("POST", "/requests", relay())).body.request.id as string;
	const report = (id: string, state: string, by = MACHINE) => call("POST", `/requests/${id}/state`, { state, relayed_by: by });

	it("walks pending → approved_awaiting_machine → connected, recording each step", async () => {
		const id = await create();
		expect((await report(id, "approved_awaiting_machine")).body.request.state).toBe("approved_awaiting_machine");
		const done = await report(id, "connected");
		expect(done.body.request).toMatchObject({ state: "connected", effectiveState: "connected" });
		expect(done.body.request.history.map((h: { state: string }) => h.state)).toEqual(["pending", "approved_awaiting_machine", "connected"]);
	});

	it("connected is never reported for a request nobody approved; a terminal state is final", async () => {
		const id = await create();
		expect((await report(id, "connected")).status).toBe(409);
		expect((await report(id, "denied")).status).toBe(200);
		expect((await report(id, "approved_awaiting_machine")).status).toBe(409);
		expect((await report(id, "pending")).status).toBe(409);
	});

	it("a repeated report is idempotent; an unknown state is refused", async () => {
		const id = await create();
		expect((await report(id, "approving")).body.changed).toBe(true);
		expect((await report(id, "approving")).body.changed).toBe(false);
		expect((await report(id, "hacked")).status).toBe(400);
	});

	it("only the machine that relayed it may report", async () => {
		const id = await create();
		expect((await report(id, "denied", { node: "other", machine_id: "m-2" })).status).toBe(409);
	});

	it.each(["denied", "cancelled", "failed"])("%s is shown as itself", async (state) => {
		const id = await create();
		await report(id, state);
		expect((await call("GET", `/requests/${id}`)).body.request.effectiveState).toBe(state);
	});

	it("past its expiry, a request the machine never updated reads expired", async () => {
		const id = await create();
		d1.exec(`UPDATE remote_auth_requests SET expires_at = ${Date.now() - 1} WHERE id = '${id}'`);
		expect((await call("GET", `/requests/${id}`)).body.request).toMatchObject({ state: "pending", effectiveState: "expired" });
	});
});
