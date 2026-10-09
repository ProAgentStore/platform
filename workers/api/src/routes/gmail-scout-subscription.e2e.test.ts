/** #997: the fresh Gmail Scout path, from catalog subscription through its first handoff. */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toolNamesFor } from "../agent-do-tools.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import { instanceConnectorPolicy } from "../lib/instance-connector-access.js";
import { planJobLeadTriage } from "../lib/job-lead-triage.js";
import { GMAIL_SCOUT_PINNED_EMAIL } from "../lib/gmail-scout/config.js";
import { ingestGmailCandidates } from "../lib/gmail-scout/scan.js";
import { realSchemaD1 } from "../lib/d1-sqlite.js";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { agentRoutes } from "./agents.js";
import { instanceRoutes } from "./instances.js";

const SECRET = "gmail-scout-e2e-secret";
const USER = "gmail-scout-owner";
const LEGACY_UPGRADE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations/0197_upgrade_legacy_job_search_scout_gmail_source.sql"), "utf8");

function legacyScoutConfig(): string {
	return JSON.stringify({
		capabilities: {
			surfaces: [], runtime: "local_browser", workflow: null,
			tools: ["create_collection", "list_collections", "insert_record", "query_records", "update_record"],
		},
	});
}

describe("#997 Gmail Scout fresh subscription acceptance", () => {
	it("subscribes the read-only source, pins its one mailbox, scans an isolated new lead, and emits Tailor handoff only on Apply", async () => {
		const d1 = realSchemaD1();
		try {
			d1.exec(`INSERT INTO users (id, github_login, roles) VALUES ('${USER}', 'serge', '["user"]')`);
			// The value is deliberately an address in both fields: Google stores it as the account id
			// after identity lookup, while older connections may only have retained the label.
			d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label)
				VALUES ('${USER}', 'gmail', '${GMAIL_SCOUT_PINNED_EMAIL}', X'00', X'00', X'00', '${GMAIL_SCOUT_PINNED_EMAIL}')`);
			const leads: Array<{ id: string; data: Record<string, unknown> }> = [];
			const permissions = new Map<string, boolean>();
			const agentNamespace = {
				idFromName: (id: string) => id,
				get: (id: string) => ({
					fetch: async (request: Request) => {
						const url = new URL(request.url);
						if (url.pathname === "/state" && request.method === "GET") return Response.json({ permissions: { email: permissions.get(id) === true } });
						if (url.pathname === "/state" && request.method === "PUT") { permissions.set(id, true); return Response.json({ success: true }); }
						if (url.pathname === "/init") return Response.json({});
						return Response.json({});
					},
				}),
			};
			const env = { DB: d1.DB, AGENT: agentNamespace, SESSION_SIGNING_KEY: SECRET } as unknown as Env;
			const app = new Hono<{ Bindings: Env }>();
			app.onError((error, c) => c.json({ error: error instanceof Error ? error.message : String(error) }, error instanceof HttpError ? error.status as 400 : 500));
			app.route("/v1/agents", agentRoutes);
			app.route("/v1/instances", instanceRoutes);
			const headers = { Authorization: `Bearer ${await signSession(USER, SECRET, { roles: ["user"] })}`, "Content-Type": "application/json" };

			// This is the catalogue/subscription path an MCP client drives.
			const subscribed = await app.request("/v1/instances/gmail-job-search-scout/subscribe", { method: "POST", headers, body: "{}" }, env);
			expect(subscribed.status).toBe(201);
			const { instanceId } = await subscribed.json() as { instanceId: string };
			const instance = d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = ?").get(instanceId) as { config: string };
			expect(JSON.parse(instance.config)).toMatchObject({ source_mode: "gmail" });

			const template = d1.sqlite.prepare("SELECT config FROM agents WHERE slug = 'gmail-job-search-scout'").get() as { config: string };
			const tools = toolNamesFor(agentCapabilities({ slug: "gmail-job-search-scout", config: template.config }));
			expect([...tools].filter((name) => name.startsWith("gmail_"))).toEqual(["gmail_search", "gmail_read_message"]);
			expect([...tools]).not.toEqual(expect.arrayContaining(["gmail_send", "gmail_archive", "gmail_mark_read"]));
			const gmail = (await instanceConnectorPolicy(env, instanceId, USER, instance.config)).find((entry) => entry.id === "gmail");
			expect(gmail).toMatchObject({ allowed: true, reason: "tools" });

			const rejectedPin = await app.request(`/v1/instances/${instanceId}/gmail-scout/config`, { method: "PUT", headers, body: JSON.stringify({ pinnedEmail: "other@example.com" }) }, env);
			expect(rejectedPin.status).toBe(400);
			expect(await rejectedPin.text()).toContain(GMAIL_SCOUT_PINNED_EMAIL);
			const configured = await app.request(`/v1/instances/${instanceId}/gmail-scout/config`, { method: "PUT", headers, body: JSON.stringify({ pinnedEmail: GMAIL_SCOUT_PINNED_EMAIL, enabled: true }) }, env);
			expect(configured.status).toBe(200);
			expect(await configured.json()).toMatchObject({ config: { pinnedEmail: GMAIL_SCOUT_PINNED_EMAIL, enabled: true } });
			expect(permissions.get(instanceId), "the owner configures this read-only source without a second browser-only permission step").toBe(true);

			// A mocked Gmail response is ingested into this Scout's collection only; it is stored as
			// an explicitly unverified lead and never retains the message body.
			await ingestGmailCandidates({
				hits: [{ id: "gmail-message-1" }], existing: [],
				readMessage: async () => ({ id: "gmail-message-1", threadId: "t", from: "alerts@example.com", to: GMAIL_SCOUT_PINNED_EMAIL, cc: "", subject: "Engineer at Acme", date: "2026-10-09", messageId: "", references: "", snippet: "Location: Melbourne", text: "Apply https://jobs.example.com/role/1?utm_source=gmail", attachments: [] }),
				insertLead: async (data) => { leads.push({ id: "lead-1", data }); },
			});
			expect(leads).toHaveLength(1);
			expect(leads[0].data).toMatchObject({ status: "unverified", source: "Gmail", gmail_message_id: "gmail-message-1", url: "https://jobs.example.com/role/1", verification: { state: "unverified" } });

			const handoff = planJobLeadTriage({ id: "lead-1", collection: "job_leads", data: leads[0].data, createdAt: "now", updatedAt: "now" }, { action: "apply", sourceInstanceId: instanceId });
			expect(handoff).toMatchObject({ ok: false, error: expect.stringContaining("unverified") });
		} finally {
			d1.close();
		}
	});

	it("upgrades an existing legacy Job Search Scout so deployed subscriptions no longer report Gmail no_tools", async () => {
		const d1 = realSchemaD1();
		try {
			d1.exec(`INSERT INTO users (id, github_login, roles) VALUES ('${USER}', 'serge', '["user"]')`);
			d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label)
				VALUES ('${USER}', 'gmail', '${GMAIL_SCOUT_PINNED_EMAIL}', X'00', X'00', X'00', '${GMAIL_SCOUT_PINNED_EMAIL}')`);
			d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('legacy-scout', '${USER}', 'job-search-scout', 'Job Search Scout', '${legacyScoutConfig().replaceAll("'", "''")}')`);
			d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config, created_at, updated_at)
				VALUES ('legacy-instance', 'legacy-scout', '${USER}', 'active', '{}', datetime('now'), datetime('now'))`);

			// This executes the same forward migration deployed to D1. It proves the live failure mode:
			// a subscription made before the Gmail catalog row existed must resolve connector tools
			// through its upgraded template, not through an unrepairable per-instance snapshot.
			d1.exec(LEGACY_UPGRADE);
			const upgraded = d1.sqlite.prepare("SELECT config FROM agents WHERE id = 'legacy-scout'").get() as { config: string };
			const tools = toolNamesFor(agentCapabilities({ slug: "job-search-scout", config: upgraded.config }));
			expect([...tools].filter((name) => name.startsWith("gmail_"))).toEqual(["gmail_search", "gmail_read_message"]);
			expect([...tools]).not.toEqual(expect.arrayContaining(["gmail_send", "gmail_archive", "gmail_mark_read"]));

			const env = { DB: d1.DB } as unknown as Env;
			const gmail = (await instanceConnectorPolicy(env, "legacy-instance", USER, "{}")).find((entry) => entry.id === "gmail");
			expect(gmail).toMatchObject({ allowed: true, reason: "tools" });
		} finally {
			d1.close();
		}
	});
});
