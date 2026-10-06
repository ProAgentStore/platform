/**
 * A research run's CLI launch (#944): no full-access flags, no built-in web, the bridge as the only
 * MCP server, and no provider API key unless the owner chose one.
 */
import { describe, expect, it } from "vitest";
import { BRIDGE_SERVER_NAME, buildEngineSpec, engineEnv, finalText, missingLogin, observedEngineAuth, researchPrompt, signInHelp } from "./engine.js";

const bridge = { command: "/usr/bin/node", args: ["/r/bridge-stdio.js"], env: { PAGS_BRIDGE_URL: "http://127.0.0.1:1", PAGS_BRIDGE_RUN: "r1", PAGS_BRIDGE_TOKEN: "t" } };
const MACHINE = { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oa" };
const spec = (engine: "claude" | "codex", authMode: "subscription" | "machine" | "api-key" = "subscription") =>
	buildEngineSpec({ engine, authMode, prompt: "PROMPT", bridge, mcpConfigPath: "/r/mcp.json", toolTimeoutMs: 900_000, baseEnv: MACHINE });

describe("never the coding launch", () => {
	it.each(["claude", "codex"] as const)("%s gets no permission-bypass or full-access flag", (engine) => {
		const args = spec(engine).args.join(" ");
		expect(args).not.toMatch(/dangerously|danger-full-access|bypassPermissions|workspace-write/);
	});
});

describe("Claude Code", () => {
	it("has no built-in tools, only the bridge, pre-approved, and asks nothing", () => {
		const s = spec("claude");
		expect(s.command).toBe("claude");
		const at = (flag: string) => s.args[s.args.indexOf(flag) + 1];
		expect(at("--tools")).toBe("");
		expect(s.args).toContain("--strict-mcp-config");
		expect(at("--mcp-config")).toBe("/r/mcp.json");
		expect(at("--allowedTools")).toBe(`mcp__${BRIDGE_SERVER_NAME}`);
		expect(at("--permission-mode")).toBe("dontAsk");
		expect(at("-p")).toBe("PROMPT");
		expect(JSON.parse(s.mcpConfig!.json)).toEqual({ mcpServers: { [BRIDGE_SERVER_NAME]: bridge } });
	});
});

describe("Codex", () => {
	it("runs read-only, outside git, without the user's config, with web search off and the bridge as its MCP server", () => {
		const s = spec("codex");
		expect(s.command).toBe("codex");
		expect(s.args.slice(0, 6)).toEqual(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--ignore-user-config"]);
		const config = s.args.filter((_, i) => s.args[i - 1] === "-c");
		expect(config).toEqual([
			'mcp_servers.pags_browser.command="/usr/bin/node"',
			'mcp_servers.pags_browser.args=["/r/bridge-stdio.js"]',
			'mcp_servers.pags_browser.env={ PAGS_BRIDGE_URL = "http://127.0.0.1:1", PAGS_BRIDGE_RUN = "r1", PAGS_BRIDGE_TOKEN = "t" }',
			"mcp_servers.pags_browser.tool_timeout_sec=900",
			'web_search="disabled"',
			"tools.web_search=false",
		]);
		expect(s.args.at(-1)).toBe("PROMPT");
		expect(s.mcpConfig).toBeUndefined();
	});
});

describe("sign-in", () => {
	it("removes provider keys for subscription and machine sign-in, and keeps them for api-key", () => {
		for (const mode of ["subscription", "machine"] as const) {
			const env = engineEnv(mode, "codex", 1, MACHINE);
			expect(env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(env.OPENAI_API_KEY).toBeUndefined();
			expect(env.PATH).toBe("/bin");
		}
		expect(engineEnv("api-key", "codex", 1, MACHINE).OPENAI_API_KEY).toBe("sk-oa");
	});

	it("gives Claude's MCP calls the run's time budget, so a pause is not cut short", () => {
		expect(engineEnv("subscription", "claude", 900_000, MACHINE).MCP_TOOL_TIMEOUT).toBe("900000");
	});

	it("reports the credential class the engine will actually run on", () => {
		expect(observedEngineAuth("claude", spec("claude").env)).toBe("machine-login");
		expect(observedEngineAuth("claude", spec("claude", "api-key").env)).toBe("api-key");
		expect(observedEngineAuth("claude", { CLAUDE_CODE_OAUTH_TOKEN: "o" })).toBe("subscription");
	});

	it("recognizes a CLI that is not signed in, and says how to fix it", () => {
		expect(missingLogin("claude", "Invalid API key · Please run /login")).toBe(true);
		expect(missingLogin("codex", "Error: not logged in. Run `codex login`")).toBe(true);
		expect(missingLogin("claude", "Found 3 jobs")).toBe(false);
		expect(signInHelp("codex")).toMatch(/codex login/);
	});
});

describe("the brief and the answer", () => {
	it("states the objective, the sites, the limits and the research tools", () => {
		const p = researchPrompt({ objective: "Find roles", policy: { mode: "research_only", allowDomains: ["seek.com.au"], denyDomains: ["x.com"], consentedDomains: [], profileConsented: false }, limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 } });
		expect(p).toMatch(/Objective: Find roles/);
		expect(p).toMatch(/Stay on these sites: seek.com.au\. Never visit: x.com\./);
		expect(p).toMatch(/30 pages, 200 browser actions, 15 minutes/);
		expect(p).toMatch(/mcp__pags_browser__record_finding/);
	});

	it("reads the CLI's closing text from either engine's structured output", () => {
		expect(finalText("claude", ['{"type":"assistant"}', '{"type":"result","result":"Found 2","is_error":false}'])).toBe("Found 2");
		expect(finalText("codex", ['{"type":"item.completed","item":{"type":"agent_message","text":"Found 3"}}', '{"type":"turn.completed"}'])).toBe("Found 3");
		expect(finalText("codex", ["not json"])).toBe("");
	});
});
