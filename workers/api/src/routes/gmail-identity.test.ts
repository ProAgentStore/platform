/**
 * #1279 — the owner's configuration surface for a Gmail identity, end to end through the real routes and the REAL migrated
 * schema: set a verified sender and inbound scope, read it back with its blockers, and see the Gmail tools obey what was
 * stored. Assertions about secrecy check the whole response body.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { GMAIL_CONNECTOR } from "../lib/connectors/gmail.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";
import { gmailIdentityRoutes } from "./gmail-identity.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async (c: { req: { header: (n: string) => string | undefined } }) => ({ uid: c.req.header("x-test-uid") ?? "u1", roles: [] }) };
});
vi.mock("../lib/connectors/client.js", () => ({ connectorClient: () => ({ token: async () => "ACCESS-TOKEN-NEVER-LEAK" }) }));

const SEND = "https://www.googleapis.com/auth/gmail.send";
const READ = "https://www.googleapis.com/auth/gmail.readonly";
const ADMIN = "admin@freeappstore.online";
const ALIASES = [
	{ sendAsEmail: "owner@gmail.test", isPrimary: true, isDefault: true },
	{ sendAsEmail: ADMIN, displayName: "Admin", verificationStatus: "accepted" },
	{ sendAsEmail: "pending@freeappstore.online", verificationStatus: "pending" },
];

interface View {
	state: string;
	pin: { sendAs: string | null; inboundScope: string[]; previewChars: number } | null;
	aliases: Array<{ email: string; verified: boolean }> | null;
	blockers: Array<{ code: string }>;
	readyToRead: boolean;
	readyToSend: boolean;
}
const view = async (r: Response) => (await r.json()) as View;
const saved = async (r: Response) => ((await r.json()) as { identity: View }).identity;

let d1: RealSchemaD1;
let env: Env;
let app: Hono<{ Bindings: Env }>;
let sent: Array<{ raw: string }>;
let aliasStatus = 200;

const as = (uid: string, method: string, path: string, body?: unknown) =>
	app.request(path, { method, headers: { "content-type": "application/json", "x-test-uid": uid }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
const account = (scopes: string, user = "u1") =>
	d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label, granted_scopes) VALUES ('${user}', 'gmail', 'owner@gmail.test', x'00', x'00', x'00', 'owner@gmail.test', '${scopes}')`);

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["inst-2"] });
	sent = [];
	aliasStatus = 200;
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.endsWith("/settings/sendAs")) return aliasStatus === 200 ? Response.json({ sendAs: ALIASES }) : new Response("{}", { status: aliasStatus });
		if (u.endsWith("/messages/send")) {
			sent.push(JSON.parse(String(init?.body)));
			return Response.json({ id: "s1", threadId: "t1" });
		}
		return new Response("{}", { status: 404 });
	});
	env = { DB: d1.DB, AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ permissions: { email: true } }) }) } } as unknown as Env;
	app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", gmailIdentityRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

const codes = (v: { blockers: Array<{ code: string }> }) => v.blockers.map((b) => b.code);

describe("GET /gmail/identity", () => {
	it("reports an unconfigured instance as such, listing the account's aliases and what is verified", async () => {
		account(`${READ} ${SEND}`);
		const res = await as("u1", "GET", "/v1/instances/inst-1/gmail/identity");
		const v = await view(res);
		expect(res.status).toBe(200);
		expect(v.state).toBe("none");
		expect(v.aliases?.map((a: { email: string; verified: boolean }) => [a.email, a.verified])).toEqual([["owner@gmail.test", true], [ADMIN, true], ["pending@freeappstore.online", false]]);
		expect(JSON.stringify(v)).not.toContain("ACCESS-TOKEN-NEVER-LEAK");
	});

	it("names every blocker: no connection, no send scope, write consent off", async () => {
		const none = await view(await as("u1", "GET", "/v1/instances/inst-1/gmail/identity"));
		expect(codes(none)).toContain("no_gmail_connection");
		expect(none.readyToRead).toBe(false);
		account(READ);
		const readOnly = await view(await as("u1", "GET", "/v1/instances/inst-1/gmail/identity"));
		expect(codes(readOnly)).toEqual(expect.arrayContaining(["send_scope_missing", "write_consent_off"]));
		expect(readOnly.readyToRead).toBe(true);
		expect(readOnly.readyToSend).toBe(false);
	});

	it("is owner-only", async () => {
		account(READ);
		expect((await as("u2", "GET", "/v1/instances/inst-1/gmail/identity")).status).toBe(404);
	});
});

describe("PUT /gmail/identity", () => {
	beforeEach(() => account(`${READ} ${SEND}`));
	const put = (body: unknown, uid = "u1") => as(uid, "PUT", "/v1/instances/inst-1/gmail/identity", body);

	it("pins a verified sender and scope and reads them back, with the remaining blockers", async () => {
		const res = await put({ sendAs: ADMIN, inboundScope: [ADMIN, "Admin@FreeAppStore.online"] });
		expect(res.status).toBe(200);
		const identity = await saved(res);
		expect(identity.state).toBe("configured");
		expect(identity.pin).toEqual({ sendAs: ADMIN, inboundScope: [ADMIN], previewChars: 8000 });
		expect(codes(identity)).toContain("write_consent_off");
		expect(identity.readyToRead).toBe(true);
		const again = await view(await as("u1", "GET", "/v1/instances/inst-1/gmail/identity"));
		expect(again.pin).toEqual(identity.pin);
	});

	it("refuses an unverified alias and an address the account cannot write as — and stores nothing", async () => {
		for (const sendAs of ["pending@freeappstore.online", "ghost@freeappstore.online"]) {
			const res = await put({ sendAs });
			expect(res.status, sendAs).toBe(409);
		}
		expect((await view(await as("u1", "GET", "/v1/instances/inst-1/gmail/identity"))).state).toBe("none");
	});

	it("refuses to pin when the alias lookup fails", async () => {
		aliasStatus = 403;
		expect((await put({ sendAs: ADMIN })).status).toBe(409);
	});

	it("validates the shape: addresses only, a bounded list, a bounded preview, something to set", async () => {
		expect((await put({ sendAs: "Name <a@b.test>" })).status).toBe(400);
		expect((await put({ inboundScope: ["nope"] })).status).toBe(400);
		expect((await put({ inboundScope: Array.from({ length: 11 }, (_, i) => `a${i}@b.test`) })).status).toBe(400);
		expect((await put({ inboundScope: [ADMIN], previewChars: 10 })).status).toBe(400);
		expect((await put({})).status).toBe(400);
	});

	it("refuses any credential in the body", async () => {
		for (const key of ["token", "refresh_token", "client_secret", "password", "apiKey"]) {
			const res = await put({ sendAs: ADMIN, [key]: "x" });
			expect(res.status, key).toBe(400);
		}
	});

	it("clear returns the instance to the account's default behaviour", async () => {
		await put({ sendAs: ADMIN, inboundScope: [ADMIN] });
		const identity = await saved(await put({ clear: true }));
		expect(identity.state).toBe("none");
		expect(identity.pin).toBeNull();
	});

	it("cannot configure another owner's instance", async () => {
		expect((await put({ sendAs: ADMIN }, "u2")).status).toBe(404);
	});

	it("preserves unrelated instance config", async () => {
		d1.exec(`UPDATE agent_instances SET config = '{"emailWorkerAccount":{"endpoint":"https://b.example.com","accountId":""}}' WHERE id = 'inst-1'`);
		await put({ sendAs: ADMIN });
		const cfg = JSON.parse((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id='inst-1'").get() as { config: string }).config);
		expect(cfg.emailWorkerAccount.endpoint).toBe("https://b.example.com");
		expect(cfg.gmailIdentity.sendAs).toBe(ADMIN);
	});
});

describe("what was stored is what the tools obey", () => {
	it("a stored pin makes gmail_send write as the pinned alias; clearing it restores the default", async () => {
		account(`${READ} ${SEND}`);
		await as("u1", "PUT", "/v1/instances/inst-1/gmail/identity", { sendAs: ADMIN, inboundScope: [ADMIN] });
		const ctx = { env, userId: "u1", instanceId: "inst-1", connectorClient: () => ({ token: async () => "tok" }) } as never;
		const send = GMAIL_CONNECTOR.tools.find((t) => t.name === "gmail_send")!.handler!;
		expect((await send(ctx, { to: "c@example.test", subject: "S", body: "B" })).success).toBe(true);
		const decode = (i: number) => {
			const b = sent[i].raw.replace(/-/g, "+").replace(/_/g, "/");
			return atob(b + "=".repeat((4 - (b.length % 4)) % 4));
		};
		expect(decode(0)).toContain(`<${ADMIN}>`);
		await as("u1", "PUT", "/v1/instances/inst-1/gmail/identity", { clear: true });
		await send(ctx, { to: "c@example.test", subject: "S", body: "B" });
		expect(decode(1)).not.toMatch(/^From:/m);
	});
});
