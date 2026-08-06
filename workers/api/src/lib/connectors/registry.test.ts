import { describe, expect, it } from "vitest";
import { CONNECTORS, connectorTools, getConnector } from "./registry.js";

describe("connector registry", () => {
	it("declares browser, github, google_sheets, http, mcp, meta, repo-local, supervision, terminal, tmux, and web-search", () => {
		const ids = CONNECTORS.map((c) => c.id).sort();
		expect(ids).toEqual(["browser", "github", "google_sheets", "http", "mcp", "meta", "repo-local", "supervision", "terminal", "tmux", "web-search"]);
	});

	// repo-local is the only read-ONLY connector: scopes.write:false is what makes it
	// impossible to write-consent, which is the whole reason it isn't part of tmux.
	it("repo-local is a no-auth local connector with no write scope", () => {
		const repo = getConnector("repo-local");
		expect(repo?.auth).toBe("none");
		expect(repo?.scopes).toEqual({ read: true, write: false });
		const tools = connectorTools().filter((t) => t.connector === "repo-local");
		expect(tools.length).toBe(4);
		expect(tools.every((t) => t.scope === "read")).toBe(true);
	});

	it("browser is a no-auth local connector (relay-reached, like tmux), read+write", () => {
		const browser = getConnector("browser");
		expect(browser?.auth).toBe("none");
		expect(browser?.scopes).toEqual({ read: true, write: true });
		expect(browser?.grantModel).toBe("user");
		expect(browser?.tools.map((t) => t.name).sort()).toEqual(["browser_act", "browser_navigate", "browser_snapshot"]);
	});

	it("web-search is a token-auth, read-only, user-grant connector with no tokenEnv (vault-backed)", () => {
		const ws = getConnector("web-search");
		expect(ws?.auth).toBe("token");
		expect(ws?.tokenEnv).toBeUndefined(); // no platform env → connectorClient reads the vault key
		expect(ws?.scopes).toEqual({ read: true, write: false });
		expect(ws?.grantModel).toBe("user");
		expect(ws?.tools.map((t) => t.name)).toEqual(["web_search"]);
	});

	it("http is a token-auth, read+write, user-grant connector with no tokenEnv (vault-backed)", () => {
		const http = getConnector("http");
		expect(http?.auth).toBe("token");
		expect(http?.tokenEnv).toBeUndefined(); // no platform env → connectorClient reads the vault key
		expect(http?.scopes).toEqual({ read: true, write: true });
		expect(http?.grantModel).toBe("user");
		expect(http?.tools.map((t) => t.name)).toEqual(["http_request"]);
	});

	it("mcp is a token-auth, read+write, user-grant connector with no tokenEnv (vault-backed)", () => {
		const mcp = getConnector("mcp");
		expect(mcp?.auth).toBe("token");
		expect(mcp?.tokenEnv).toBeUndefined(); // no platform env → connectorClient reads the vault token
		expect(mcp?.scopes).toEqual({ read: true, write: true });
		expect(mcp?.grantModel).toBe("user");
		// Six, not two (#263): the read side — resources and prompts — is part of this connector, and
	// a server whose context an agent can only guess at is the failure the connector exists to fix.
	expect(mcp?.tools.map((t) => t.name)).toEqual([
		"mcp_list_tools",
		"mcp_call_tool",
		"mcp_list_resources",
		"mcp_read_resource",
		"mcp_list_prompts",
		"mcp_get_prompt",
	]);
	});

	it("mcp_call_tool is write-scoped (a remote tool call can mutate) while discovery is read", () => {
		const byName = new Map(connectorTools().map((t) => [t.name, t] as const));
		expect(byName.get("mcp_call_tool")?.scope).toBe("write");
		expect(byName.get("mcp_list_tools")?.scope).toBe("read");
	});

	it("the mcp connector hardcodes no server host — the endpoint is a tool input", () => {
		// Store independence: a host baked in here would make some other service a runtime
		// dependency of this Worker. The server must come from config/user data instead.
		const mcp = getConnector("mcp");
		const declared = JSON.stringify(mcp?.tools.map((t) => ({ d: t.description, s: t.jsonSchema })));
		expect(declared).not.toMatch(/https:\/\/(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i);
		expect(mcp?.tools.every((t) => t.jsonSchema.required?.includes("url"))).toBe(true);
	});

	it("github is an app-auth, read+write, user-grant connector", () => {
		const gh = getConnector("github");
		expect(gh?.auth).toBe("app");
		expect(gh?.scopes).toEqual({ read: true, write: true });
		expect(gh?.grantModel).toBe("user");
	});

	it("meta is a token-auth connector backed by META_ACCESS_TOKEN (write-only)", () => {
		const meta = getConnector("meta");
		expect(meta?.auth).toBe("token");
		expect(meta?.tokenEnv).toBe("META_ACCESS_TOKEN");
		expect(meta?.scopes).toEqual({ read: false, write: true });
	});

	it("tmux is a no-auth local connector", () => {
		expect(getConnector("tmux")?.auth).toBe("none");
	});

	it("terminal is a no-auth local connector with read+write runner tools", () => {
		const terminal = getConnector("terminal");
		expect(terminal?.auth).toBe("none");
		expect(terminal?.scopes).toEqual({ read: true, write: true });
		expect(terminal?.grantModel).toBe("user");
		expect(terminal?.tools.map((t) => t.name).sort()).toEqual([
			"terminal_capture",
			"terminal_kill_target",
			"terminal_list_targets",
			"terminal_new_target",
			"terminal_run_command",
			"terminal_send_keys",
		]);
	});

	it("unknown connector → undefined", () => {
		expect(getConnector("nope")).toBeUndefined();
	});

	it("connectorTools flattens every connector's tools and stamps connector/tier/scope", () => {
		const tools = connectorTools();
		// Every connector's tools are present.
		const byConnector = new Map<string, number>();
		for (const t of tools) {
			expect(t.tier).toBe("connector");
			expect(typeof t.connector).toBe("string");
			expect(t.scope === "read" || t.scope === "write").toBe(true);
			byConnector.set(t.connector as string, (byConnector.get(t.connector as string) ?? 0) + 1);
		}
		expect(byConnector.get("github")).toBeGreaterThan(0);
		expect(byConnector.get("meta")).toBeGreaterThan(0);
		expect(byConnector.get("tmux")).toBeGreaterThan(0);
	});

	it("the flattened tool set matches the sum of each connector's tools", () => {
		const declared = CONNECTORS.reduce((n, c) => n + c.tools.length, 0);
		expect(connectorTools().length).toBe(declared);
	});
});
