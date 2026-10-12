/**
 * #1048: both Gmail Scout templates DECLARE a local browser (migration 0225), so browser verification
 * (#1030, #1031) can be turned on for a live Scout. Runs against the schema and seed rows the real
 * migrations build — the previous gap was a seeded template that no test used.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCapabilities, localBrowserView } from "../../agent-capabilities.js";
import { mergeBrowserVerification, resolveBrowserVerification } from "../../browser-verification.js";
import { realSchemaD1 } from "../../d1-sqlite.js";
import { localBrowserCapability } from "../../local-browser/start.js";
import { validateLocalBrowserSettings } from "../../local-browser/policy.js";
import type { Env } from "../../../types.js";
import { GMAIL_SCOUT_TOOLS } from "../config.js";

const migration = (name: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../migrations", name), "utf8");

describe("Gmail Scout declares a local browser (#1048)", () => {
	it("the seeded Gmail Scout resolves runtime local_browser — research only, subscription only, any site with consent (#1049) — with its tools unchanged", () => {
		const d1 = realSchemaD1();
		try {
			const row = d1.sqlite.prepare("SELECT config FROM agents WHERE slug = 'gmail-job-search-scout'").get() as { config: string };
			const caps = agentCapabilities({ slug: "gmail-job-search-scout", config: row.config });
			expect(caps).toMatchObject({ surfaces: [], runtime: "local_browser", workflow: null, tools: [...GMAIL_SCOUT_TOOLS] });
			// #1049 (0227) dropped 0225's indeed.com ceiling: each instance sets its own sites, and a new site waits for the owner.
			expect(caps.localBrowser).toMatchObject({ engines: ["claude", "codex"], mode: "research_only", subscriptionOnly: true, allowDomains: [], denyDomains: [], limits: { maxMinutes: 10, maxPages: 10, maxActions: 100, maxConcurrent: 1 } });
			expect(caps.tools).not.toContain("gmail_send");
		} finally {
			d1.close();
		}
	});

	it("an instance sets its own allowed and denied job sites — SEEK and LinkedIn are no longer refused by the template (#1049)", () => {
		const d1 = realSchemaD1();
		try {
			const row = d1.sqlite.prepare("SELECT config FROM agents WHERE slug = 'gmail-job-search-scout'").get() as { config: string };
			const cap = agentCapabilities({ slug: "gmail-job-search-scout", config: row.config }).localBrowser!;
			expect(validateLocalBrowserSettings({ access: { allowDomains: ["seek.com.au", "linkedin.com", "indeed.com"], denyDomains: ["example-jobs.test"] } }, cap)).toEqual({
				settings: { access: { allowDomains: ["seek.com.au", "linkedin.com", "indeed.com"], denyDomains: ["example-jobs.test"] } },
			});
		} finally {
			d1.close();
		}
	});

	it("an instance of it can now turn browser verification on — and it is OFF until the owner does", async () => {
		const d1 = realSchemaD1();
		try {
			d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
			const agent = d1.sqlite.prepare("SELECT id, config FROM agents WHERE slug = 'gmail-job-search-scout'").get() as { id: string; config: string };
			d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('scout-1', '${agent.id}', 'u1', 'active', '{}')`);
			const env = { DB: d1.DB } as unknown as Env;
			const cap = await localBrowserCapability(env, "scout-1", "u1");
			expect("cap" in cap).toBe(true);
			expect(resolveBrowserVerification(undefined).enabled).toBe(false);
			const declared = localBrowserView(agentCapabilities({ slug: "gmail-job-search-scout", config: agent.config })) !== null;
			expect(mergeBrowserVerification({}, { enabled: true }, declared)).toMatchObject({ settings: { enabled: true } });
		} finally {
			d1.close();
		}
	});

	it("upgrades the legacy Job Search Scout the live subscriptions use (0197 had reset it to runtime null)", () => {
		const d1 = realSchemaD1();
		try {
			d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
			d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('legacy', 'u1', 'job-search-scout', 'Job Search Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser","tools":["insert_record"]}}')`);
			d1.exec(migration("0197_upgrade_legacy_job_search_scout_gmail_source.sql"));
			const before = d1.sqlite.prepare("SELECT config FROM agents WHERE id = 'legacy'").get() as { config: string };
			expect(agentCapabilities({ slug: "job-search-scout", config: before.config }).runtime).toBeNull();
			d1.exec(migration("0225_gmail_scout_local_browser_capability.sql"));
			const after = d1.sqlite.prepare("SELECT config FROM agents WHERE id = 'legacy'").get() as { config: string };
			const caps = agentCapabilities({ slug: "job-search-scout", config: after.config });
			expect(caps).toMatchObject({ runtime: "local_browser", tools: [...GMAIL_SCOUT_TOOLS], localBrowser: { allowDomains: ["indeed.com"] } });
			d1.exec(migration("0227_gmail_scout_browser_source_policy.sql"));
			const latest = d1.sqlite.prepare("SELECT config FROM agents WHERE id = 'legacy'").get() as { config: string };
			expect(agentCapabilities({ slug: "job-search-scout", config: latest.config })).toMatchObject({ runtime: "local_browser", tools: [...GMAIL_SCOUT_TOOLS], localBrowser: { allowDomains: [] } });
			expect(JSON.parse(after.config).source_mode).toBe("gmail");
		} finally {
			d1.close();
		}
	});
});
