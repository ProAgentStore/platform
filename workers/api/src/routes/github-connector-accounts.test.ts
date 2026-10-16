/**
 * GitHub as a first-class connector (#1080), over the real schema and routes: the account's verified App
 * installation bindings are GitHub's accounts in `GET /v1/connectors` and `GET /v1/instances/:id/connector-accounts`,
 * and an agent cannot be pinned to one — the repository's owner chooses. Additive: Gmail's accounts and pins
 * behave exactly as before, and nothing here writes a binding.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { APP_ACCOUNT_CHOICE } from "../lib/connectors/app-accounts.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { connectorRoutes } = await import("./connectors.js");
const { toolRoutes } = await import("./tools.js");

let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB }) as unknown as Env;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'serge-ivo'), ('u2', 'other')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('a1', 'u1', 't1080-coder', 'Coder')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'a1', 'u1', 'active', '{}')`);
});
afterEach(() => d1.close());

const bind = (user: string, login: string, id: number, type = "Organization") =>
	d1.exec(`INSERT INTO github_installations (id, user_id, installation_id, account_login, account_type) VALUES ('gi-${user}-${id}', '${user}', ${id}, '${login}', '${type}')`);
const gmail = (account: string) =>
	d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, account_label, key_ciphertext, dek_wrapped, iv) VALUES ('u1', 'gmail', '${account}', '${account}', x'00', x'00', x'00')`);

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/connectors", connectorRoutes);
	app.route("/v1/instances", toolRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("GitHub is a first-class connector (#1080)", () => {
	it("list_connectors: GitHub is connected, and its accounts are the account's verified installation bindings — no one else's", async () => {
		expect((await call("GET", "/v1/connectors")).body.connectors.find((c: { id: string }) => c.id === "github")).toMatchObject({ connected: false, accounts: [] });
		bind("u1", "ChessClubs-online", 171531492);
		bind("u1", "serge-ivo", 7, "User");
		bind("u2", "someone-elses-org", 9);
		const github = (await call("GET", "/v1/connectors")).body.connectors.find((c: { id: string }) => c.id === "github");
		expect(github).toMatchObject({ auth: "app", connected: true, accountChoice: "repository_owner", flow: null });
		expect(github.accounts.map((a: { accountId: string }) => a.accountId).sort()).toEqual(["ChessClubs-online", "serge-ivo"]);
		expect(github.accounts.find((a: { accountId: string }) => a.accountId === "ChessClubs-online").label).toMatch(/organisation · App installation 171531492/);
		expect(JSON.stringify(github)).not.toContain("someone-elses-org");
	});

	it("get_instance_connector_account: GitHub is listed beside Gmail, chosen by the repository's owner", async () => {
		bind("u1", "ChessClubs-online", 171531492);
		gmail("me@example.com");
		const rows = (await call("GET", "/v1/instances/i1/connector-accounts")).body.connectors as Array<Record<string, unknown>>;
		expect(rows.map((r) => r.connector).sort()).toEqual(["github", "gmail"]);
		expect(rows.find((r) => r.connector === "github")).toMatchObject({ chosenBy: "repository_owner", pinned: null, blocked: null, note: APP_ACCOUNT_CHOICE, accounts: [{ accountId: "ChessClubs-online" }] });
		// Gmail is exactly as before: one account resolves to itself.
		expect(rows.find((r) => r.connector === "gmail")).toMatchObject({ resolves: "me@example.com", blocked: null });
	});

	it("an agent cannot be pinned to a GitHub account — the refusal says why and how to add an organisation; Gmail pins as before", async () => {
		bind("u1", "ChessClubs-online", 171531492);
		const refused = await call("PUT", "/v1/instances/i1/connector-accounts", { connector: "github", accountId: "ChessClubs-online" });
		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe(APP_ACCOUNT_CHOICE);
		expect(refused.body.error).toMatch(/Sync installations/);
		const config = (d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'i1'").get() as { config: string }).config;
		expect(config).not.toContain("ChessClubs-online");

		gmail("a@example.com");
		gmail("b@example.com");
		expect((await call("PUT", "/v1/instances/i1/connector-accounts", { connector: "gmail", accountId: "b@example.com" })).status).toBe(200);
	});

	it("with no binding GitHub is simply not listed per agent — nothing is invented", async () => {
		expect((await call("GET", "/v1/instances/i1/connector-accounts")).body.connectors).toEqual([]);
	});
});
