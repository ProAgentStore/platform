/**
 * #1095: an Application Runner can read the mailbox its confirmations go to — and only read it.
 *
 * The live state: the owner has two Gmail mailboxes connected (sivochkin@ and serge.pro.job@ — the job-search
 * one), and the Runner instance 2e85124f is already pinned to serge.pro.job@ (#715). What it lacked was a
 * declaration: its template, a `local_apply` agent the owner created, declared no tools, so Gmail was
 * `no_tools` on it. The change is the template declaring the two READ tools, through the same route the
 * console and MCP's set_agent_capabilities use. Over the real schema and routes; the Agent DO is faked only
 * as the owner's `permissions` state.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { listConnectorAccounts, pinnedAccountsFrom, resolveConnectorAccount } from "../lib/connector-accounts.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { agentRoutes } = await import("./agents.js");
const { toolRoutes } = await import("./tools.js");

const RUNNER_AGENT = "a5b1c8c3-e01c-465b-9cfc-67fb3a2c5460";
const RUNNER = "2e85124f-4946-49d2-b922-8636ba92ca6a";
const JOB_MAILBOX = "serge.pro.job@gmail.com";
const OTHER_MAILBOX = "sivochkin@gmail.com";
const READ_TOOLS = ["gmail_search", "gmail_read_message"];

let d1: RealSchemaD1;
let emailPermission: boolean;
const agentDO = {
	idFromName: (n: string) => n,
	get: () => ({ fetch: async () => Response.json({ permissions: { email: emailPermission } }) }),
};
const env = () => ({ DB: d1.DB, AGENT: agentDO }) as unknown as Env;

beforeEach(() => {
	d1 = realSchemaD1();
	emailPermission = true;
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	// The owner's own Runner template as it stands in production: local_apply, no tools declared.
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, category, description, config) VALUES ('${RUNNER_AGENT}', 'u1', 'job-application-runner', 'Job Application Runner', 'productivity', 'Fills job applications in your own browser.', '{"capabilities":{"surfaces":[],"runtime":"local_apply","workflow":null,"tools":[]}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('${RUNNER}', '${RUNNER_AGENT}', 'u1', 'active', '{"connectorAccounts":{"gmail":"${JOB_MAILBOX}"}}')`);
	for (const [account, at] of [[OTHER_MAILBOX, "2026-08-20 20:39:54"], [JOB_MAILBOX, "2026-07-03 07:48:37"]]) {
		d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, account_label, key_ciphertext, dek_wrapped, iv, created_at, granted_scopes) VALUES ('u1', 'gmail', '${account}', '${account}', x'00', x'00', x'00', '${at}', 'openid email https://www.googleapis.com/auth/gmail.readonly')`);
	}
});
afterEach(() => d1.close());

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/agents", agentRoutes);
	app.route("/v1/instances", toolRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const gmailVerdict = async () => ((await call("GET", `/v1/instances/${RUNNER}/connectors`)).body.connectors as Array<{ id: string; allowed: boolean; reason: string }>).find((c) => c.id === "gmail");
const toolRow = async (name: string) => ((await call("GET", `/v1/instances/${RUNNER}/tools`)).body.tools as Array<{ name: string; allowed: boolean; reason: string }>).find((t) => t.name === name);

describe("the Application Runner reads its confirmation mailbox (#1095)", () => {
	it("before: a Runner that declares no tools has Gmail refused as no_tools — the production state", async () => {
		expect(await gmailVerdict()).toMatchObject({ allowed: false, reason: "no_tools" });
	});

	it("the template declares the two READ tools through the capabilities route — a local_apply agent may", async () => {
		const res = await call("PUT", `/v1/agents/${RUNNER_AGENT}/capabilities`, { tools: READ_TOOLS });
		expect(res.status).toBe(200);
		const stored = JSON.parse(String((await d1.DB.prepare("SELECT config FROM agents WHERE id = ?1").bind(RUNNER_AGENT).first<{ config: string }>())?.config));
		expect(stored.capabilities).toMatchObject({ runtime: "local_apply", tools: READ_TOOLS });
	});

	it("after: Gmail is part of the Runner, and only its read tools may run", async () => {
		await call("PUT", `/v1/agents/${RUNNER_AGENT}/capabilities`, { tools: READ_TOOLS });
		expect(await gmailVerdict()).toMatchObject({ allowed: true, reason: "tools" });
		for (const name of READ_TOOLS) expect(await toolRow(name), name).toMatchObject({ allowed: true });
		// Sending, replying, archiving and filters are not the Runner's: it reads confirmations, never writes mail.
		for (const name of ["gmail_send", "gmail_reply", "gmail_draft_reply", "gmail_archive", "gmail_mark_read", "gmail_create_filter"]) {
			expect(await toolRow(name), name).toMatchObject({ allowed: false });
		}
	});

	it("the connector verdict does not read permissions.email — the owner's switch is enforced on every Gmail CALL instead", async () => {
		// `instance-connector-policy.ts` is explicit that it does not evaluate the flag; `gmail.test.ts`'s
		// "the permissions.email gate" holds every Gmail tool to it at call time, failing closed.
		await call("PUT", `/v1/agents/${RUNNER_AGENT}/capabilities`, { tools: READ_TOOLS });
		emailPermission = false;
		expect(await gmailVerdict()).toMatchObject({ allowed: true, reason: "tools" });
	});

	it("with two mailboxes connected, a call resolves to the one this Runner is pinned to — never the other", async () => {
		const accounts = await listConnectorAccounts(env(), "u1", "gmail");
		expect(accounts.map((a) => a.accountId).sort()).toEqual([JOB_MAILBOX, OTHER_MAILBOX].sort());
		const config = JSON.parse(String((await d1.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1").bind(RUNNER).first<{ config: string }>())?.config));
		expect(resolveConnectorAccount(accounts, pinnedAccountsFrom(config).gmail, "Gmail")).toMatchObject({ ok: true, account: { accountId: JOB_MAILBOX } });
		// Unpinned, it refuses rather than picking either mailbox.
		expect(resolveConnectorAccount(accounts, undefined, "Gmail")).toMatchObject({ ok: false, reason: "ambiguous" });
	});
});
