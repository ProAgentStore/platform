/**
 * Migration 0087 seeds Portal Watch (#73) entirely as DATA — there is no portal-watch code
 * anywhere in the monorepo. That is the point, and it is also the risk: a typo in the embedded
 * JSON does not fail a build, it makes the agent silently fall back to legacy slug/category
 * derivation and come up as an ordinary chat agent with no browser at all.
 *
 * So the seed is checked here the same way 0057's pipelines are: parse what the migration will
 * actually insert, resolve it through the REAL capability registry and the REAL settings
 * plumbing, and assert the properties the agent is sold on.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCapabilities, sanitizeSettingsSchema } from "./agent-capabilities.js";
import { resolveSettingsValues, settingsPromptBlock } from "./instance-settings.js";
import { blockPublishReason } from "./test-agent-guard.js";
import { blockedActionReason, browserTaskSystemPrompt, type BrowserTaskJob } from "./browser-task-loop.js";

const MIGRATION = fileURLToPath(new URL("../../migrations/0087_seed_portal_watch_agent.sql", import.meta.url));
const SQL = readFileSync(MIGRATION, "utf8");

/** Pull the agent's config JSON back out of the migration's `json('…')` literal. */
function seededConfig(): Record<string, unknown> {
	const start = SQL.indexOf("json('");
	const end = SQL.indexOf("'),\n  datetime('now')", start);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return JSON.parse(SQL.slice(start + "json('".length, end).replace(/''/g, "'")) as Record<string, unknown>;
}

const config = seededConfig();
const configJson = JSON.stringify(config);
const DESCRIPTION = /\n {2}'(Keeps an eye[\s\S]*?)',\n {2}'productivity'/.exec(SQL)?.[1] ?? "";

describe("migration 0087 — Portal Watch capabilities", () => {
	const caps = agentCapabilities({ slug: "portal-watch", category: "productivity", config: configJson });

	it("resolves to the browser runtime and the generic browser brain", () => {
		// If the declared block were malformed these would fall back to the legacy derivation,
		// which for category "productivity" yields no runtime and no workflow — an agent that
		// looks fine in the catalog and can never run.
		expect(caps.runtime).toBe("browser");
		expect(caps.workflow).toBe("BROWSER_TASK");
	});

	it("declares no bespoke console surface — the generic Board carries it", () => {
		expect(caps.surfaces).toEqual([]);
	});

	it("scopes its chat tools to the knowledge base, so no empty Data tab and no coding tools", () => {
		// An agent that declares nothing gets the FULL tool set, which is how surfaces the
		// subscriber can never fill end up rendered. Declared list = exactly what it can use.
		expect(caps.tools).toEqual(["search_knowledge", "list_knowledge", "read_knowledge", "add_knowledge"]);
	});

	it("offers the two settings a subscriber actually has to fill in", () => {
		expect(caps.settingsSchema?.map((f) => f.id)).toEqual(["portal_url", "what_to_report"]);
	});

	it("survives the schema sanitizer unchanged — nothing is silently dropped or truncated", () => {
		const raw = config.settingsSchema;
		expect(sanitizeSettingsSchema(raw)).toEqual(raw);
	});
});

describe("migration 0087 — the read-only contract", () => {
	const browserTask = config.browserTask as Record<string, unknown>;

	it("declares itself read-only", () => {
		expect(browserTask.readOnly).toBe(true);
	});

	it("nominates a start-URL setting that actually exists", () => {
		// The route resolves the start URL through this id. Renaming the field without
		// updating it here would leave every run falling back to "no start URL".
		const ids = (config.settingsSchema as Array<{ id: string }>).map((f) => f.id);
		expect(ids).toContain(browserTask.startUrlSetting);
	});

	it("cannot pay, submit, send or delete — enforced by the runtime, not the prompt", () => {
		const job: BrowserTaskJob = { url: "https://portal.example.com", objective: "x", readOnly: browserTask.readOnly === true };
		for (const name of ["Pay now", "Submit", "Send", "Delete", "Confirm"]) {
			expect(blockedActionReason(job, { action: "click", role: "button", name })).not.toBeNull();
		}
		expect(blockedActionReason(job, { action: "click", role: "link", name: "View statement" })).toBeNull();
	});
});

describe("migration 0087 — the objective the workflow will actually run", () => {
	const identity = config.identity as Record<string, unknown>;
	const schema = sanitizeSettingsSchema(config.settingsSchema) ?? [];

	/** Recomposed exactly as startBrowserTask composes it: agent goal + rendered settings. */
	function objectiveFor(stored: Record<string, unknown>): string {
		const values = resolveSettingsValues(schema, stored);
		return [identity.goal as string, settingsPromptBlock(schema, values)].filter(Boolean).join("\n\n");
	}

	it("is non-empty from the goal alone — an empty goal would 400 every run", () => {
		expect(String(identity.goal ?? "").length).toBeGreaterThan(200);
	});

	it("carries the subscriber's page and their reporting brief to the model", () => {
		const objective = objectiveFor({ portal_url: "https://energy.example.com/account", what_to_report: "the balance and the due date" });
		expect(objective).toContain("the balance and the due date");
		expect(objective).toContain("https://energy.example.com/account");
	});

	it("still asks for something useful when the subscriber leaves the brief alone", () => {
		// The default matters: an unset text field renders nothing, and the agent would be
		// told to report on a page with no idea what about it mattered.
		const objective = objectiveFor({ portal_url: "https://energy.example.com/account" });
		expect(objective).toMatch(/amount owing|needing attention/);
	});

	it("tells the model to hand off rather than sign in, and to report values rather than narrate", () => {
		const prompt = browserTaskSystemPrompt({
			url: "https://energy.example.com/account",
			objective: objectiveFor({ portal_url: "https://energy.example.com/account" }),
			readOnly: true,
		});
		expect(prompt).toMatch(/Never try to sign in yourself/);
		expect(prompt).toMatch(/READ-ONLY/);
		expect(prompt).toMatch(/finish DETAIL IS THE REPORT/i);
	});
});

describe("migration 0087 — it is fit to sit in the public catalog", () => {
	it("is published, not left as a draft nobody can find", () => {
		expect(SQL).toContain("'published'");
	});

	it("does not trip the fixture guard that keeps smoke agents out of the storefront", () => {
		expect(blockPublishReason({ slug: "portal-watch", name: "Portal Watch", description: DESCRIPTION }, "published")).toBeNull();
	});

	it("uses a category the storefront filter can actually reach", () => {
		// The store homepage matches category exactly against a hardcoded button row
		// (chat · code · data · creative · productivity); anything else is All-only. See 0084.
		expect(SQL).toContain("'productivity'");
	});

	it("tells the reader what it will and will not do, in the description", () => {
		expect(DESCRIPTION).toMatch(/pags up/);
		expect(DESCRIPTION).toMatch(/only ever look/i);
	});
});
