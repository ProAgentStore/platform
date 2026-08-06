import { describe, it, expect } from "vitest";
import {
	classifyDeliveryFailure,
	connectorsUsedByPipeline,
	pipelineWiringWarnings,
	reconnectMessage,
	unattendedClassOf,
	unattendedFromGrantTypes,
	unattendedWiringWarning,
	worstUnattendedClass,
} from "./unattended.js";
import { CONNECTORS, getConnector } from "./registry.js";
import { planNextAttempt } from "../connection-deliveries.js";

describe("unattendedClassOf — derived from auth so the two cannot drift", () => {
	it("oauth connectors survive on a refresh token", () => {
		expect(unattendedClassOf({ auth: "oauth" })).toBe("refresh");
	});

	it("app / token / none connectors have nothing that expires on us", () => {
		expect(unattendedClassOf({ auth: "app" })).toBe("yes");
		expect(unattendedClassOf({ auth: "token" })).toBe("yes");
		expect(unattendedClassOf({ auth: "none" })).toBe("yes");
	});

	it("an explicit declaration wins over the derivation", () => {
		expect(unattendedClassOf({ auth: "token", unattended: "interactive-only" })).toBe("interactive-only");
	});

	it("every shipped connector resolves to a class", () => {
		for (const c of CONNECTORS) {
			expect(["yes", "refresh", "interactive-only"]).toContain(unattendedClassOf(c));
		}
	});

	it("no connector shipped today is interactive-only — the warning is modelled ahead of its first user", () => {
		// This is the honest current state (#181 lands before #180's DCR, which is what would
		// introduce the first one). If a connector ever becomes interactive-only, this flips and
		// the wiring warnings below start firing for real.
		expect(CONNECTORS.filter((c) => unattendedClassOf(c) === "interactive-only")).toEqual([]);
	});
});

describe("unattendedFromGrantTypes — derived from a discovered server's metadata", () => {
	it("a server advertising refresh_token can be kept connected unattended", () => {
		expect(unattendedFromGrantTypes(["authorization_code", "refresh_token"])).toBe("refresh");
	});

	it("authorization_code alone is interactive-only — the FreeWebStore case", () => {
		expect(unattendedFromGrantTypes(["authorization_code"])).toBe("interactive-only");
	});

	it("an empty grant list is interactive-only, because RFC 8414's default omits refresh_token", () => {
		expect(unattendedFromGrantTypes([])).toBe("interactive-only");
	});

	it("is case- and whitespace-insensitive", () => {
		expect(unattendedFromGrantTypes([" Refresh_Token "])).toBe("refresh");
	});
});

describe("worstUnattendedClass", () => {
	it("nothing to worry about for an empty set", () => {
		expect(worstUnattendedClass([])).toBe("yes");
	});

	it("picks the most fragile member", () => {
		expect(worstUnattendedClass(["yes", "refresh"])).toBe("refresh");
		expect(worstUnattendedClass(["yes", "interactive-only", "refresh"])).toBe("interactive-only");
	});
});

describe("classifyDeliveryFailure — an expired credential is not an outage", () => {
	it("treats an explicit 401/403 status as auth", () => {
		expect(classifyDeliveryFailure("something failed", 401)).toBe("auth");
		expect(classifyDeliveryFailure("something failed", 403)).toBe("auth");
	});

	it("recognises the platform's own connector auth errors", () => {
		expect(classifyDeliveryFailure("Could not refresh google_sheets access (401). Reconnect it in settings.")).toBe("auth");
		expect(classifyDeliveryFailure("Google Drive is not connected")).toBe("auth");
		expect(classifyDeliveryFailure("MCP server rejected the credential (HTTP 401).")).toBe("auth");
		expect(classifyDeliveryFailure("invalid_grant")).toBe("auth");
		expect(classifyDeliveryFailure("The refresh token has been revoked")).toBe("auth");
	});

	it("leaves genuinely transient failures alone so they keep their retries", () => {
		expect(classifyDeliveryFailure("fetch failed")).toBe("transient");
		expect(classifyDeliveryFailure("MCP request failed: network error")).toBe("transient");
		expect(classifyDeliveryFailure("Internal error (500)")).toBe("transient");
		expect(classifyDeliveryFailure("rate limited (429)")).toBe("transient");
		expect(classifyDeliveryFailure("")).toBe("transient");
	});

	it("a 500 is transient even though it is an error status", () => {
		expect(classifyDeliveryFailure("boom", 500)).toBe("transient");
	});
});

describe("planNextAttempt — auth failures do not burn the retry budget (#181)", () => {
	const now = new Date("2026-08-04T00:00:00Z");

	it("a transient failure still backs off and retries, exactly as before", () => {
		expect(planNextAttempt(1, now)).toEqual({ outcome: "retrying", nextAttemptAt: "2026-08-04T00:01:00.000Z" });
		expect(planNextAttempt(1, now, "transient")).toEqual({ outcome: "retrying", nextAttemptAt: "2026-08-04T00:01:00.000Z" });
	});

	it("a transient failure still dead-letters once the attempts are spent", () => {
		expect(planNextAttempt(5, now, "transient")).toEqual({ outcome: "dead" });
	});

	it("an auth failure dead-letters on the FIRST attempt — retrying cannot fix it", () => {
		expect(planNextAttempt(1, now, "auth")).toEqual({ outcome: "dead" });
	});
});

describe("reconnectMessage", () => {
	it("says the one thing the reader can act on", () => {
		expect(reconnectMessage("FreeWebStore")).toMatch(/reconnected/);
		expect(reconnectMessage("FreeWebStore")).toMatch(/retrying cannot fix that/);
	});

	it("carries the underlying detail without letting it run away", () => {
		expect(reconnectMessage("X", "HTTP 401")).toContain("HTTP 401");
		expect(reconnectMessage("X", "y".repeat(1000)).length).toBeLessThan(400);
	});
});

describe("unattendedWiringWarning — warn at wiring time, not via dead letters", () => {
	it("says nothing about a connector whose credential survives", () => {
		expect(unattendedWiringWarning("GitHub", "yes", "cron")).toBeNull();
		expect(unattendedWiringWarning("Google Sheets", "refresh", "connection")).toBeNull();
	});

	it("warns for an interactive-only connector on a cron trigger", () => {
		const w = unattendedWiringWarning("FreeWebStore", "interactive-only", "cron");
		expect(w).toContain("FreeWebStore");
		expect(w).toContain("scheduled (cron) trigger");
		expect(w).toContain("expires");
	});

	it("warns for an interactive-only connector on an agent-to-agent connection", () => {
		expect(unattendedWiringWarning("FreeWebStore", "interactive-only", "connection")).toContain("agent-to-agent connection");
	});
});

describe("connectorsUsedByPipeline", () => {
	const resolve = (tool: string) => ({ mcp_call_tool: "mcp", http_request: "http", web_search: "web-search" })[tool];

	it("maps a pipeline's steps onto the connectors it reaches, de-duplicated and in order", () => {
		const steps = [{ tool: "web_search" }, { tool: "mcp_call_tool" }, { tool: "mcp_call_tool" }, { tool: "http_request" }];
		expect(connectorsUsedByPipeline(steps, resolve)).toEqual(["web-search", "mcp", "http"]);
	});

	it("ignores steps the registry does not know — validating tool names is not this function's job", () => {
		expect(connectorsUsedByPipeline([{ tool: "no_such_tool" }, { tool: "mcp_call_tool" }], resolve)).toEqual(["mcp"]);
	});

	it("tolerates a missing/blank/absent step list", () => {
		expect(connectorsUsedByPipeline(undefined, resolve)).toEqual([]);
		expect(connectorsUsedByPipeline([{}, { tool: "  " }], resolve)).toEqual([]);
	});
});

describe("pipelineWiringWarnings", () => {
	it("is silent for a pipeline whose every credential survives unattended", () => {
		expect(pipelineWiringWarnings(["github", "http", "mcp"], getConnector, "connection")).toEqual([]);
	});

	it("warns once per fragile connector, naming it", () => {
		const lookup = (id: string) =>
			id === "fragile" ? { label: "Fragile Server", auth: "token" as const, unattended: "interactive-only" as const } : getConnector(id);
		const out = pipelineWiringWarnings(["github", "fragile"], lookup, "cron");
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("Fragile Server");
	});

	it("skips an unknown connector id rather than throwing", () => {
		expect(pipelineWiringWarnings(["nope"], getConnector, "cron")).toEqual([]);
	});
});
