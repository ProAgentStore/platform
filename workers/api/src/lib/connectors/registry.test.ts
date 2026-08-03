import { describe, expect, it } from "vitest";
import { CONNECTORS, connectorTools, getConnector } from "./registry.js";

describe("connector registry", () => {
	it("declares browser, github, google_sheets, http, meta, tmux, and web-search", () => {
		const ids = CONNECTORS.map((c) => c.id).sort();
		expect(ids).toEqual(["browser", "github", "google_sheets", "http", "meta", "tmux", "web-search"]);
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
