import { describe, expect, it } from "vitest";
import { getRegistryTool, registryConnectorGroups, registryToolDefs, registryToolNameSet, runRegistryTool } from "./tool-registry.js";
import type { Env } from "../types.js";

const envNoGithub = {} as unknown as Env; // githubAppConfigured() → false

/** Env whose consent lookup returns `granted` for every (instance,connector,write). */
function envWithConsent(granted: boolean): Env {
	return {
		DB: {
			prepare(_sql: string) {
				return { bind() { return { first: async () => (granted ? { ok: 1 } : null) }; } };
			},
		},
	} as unknown as Env;
}

describe("tool registry", () => {
	it("registers the GitHub connector tools", () => {
		const names = registryToolNameSet();
		expect(names.has("github_workflow_runs")).toBe(true);
		expect(names.has("github_list_issues")).toBe(true);
		expect(names.has("github_read_issue")).toBe(true);
	});

	it("exposes ToolDef-shaped definitions (name/description/parameters)", () => {
		const def = registryToolDefs().find((d) => d.name === "github_workflow_runs");
		expect(def?.parameters.repo.required).toBe(true);
		expect(typeof def?.description).toBe("string");
	});

	it("groups tools by connector for the catalog", () => {
		const gh = registryConnectorGroups().find((g) => g.connector === "github");
		expect(gh?.tools).toContain("github_read_issue");
	});

	it("unknown tool → failure, never throws", async () => {
		const r = await runRegistryTool("nope", { env: envNoGithub }, {});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/unknown tool/i);
	});

	it("github tool with GitHub not connected → clear error, no throw", async () => {
		const r = await runRegistryTool("github_workflow_runs", { env: envNoGithub, userId: "u1" }, { repo: "owner/name" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/not connected|not configured/i);
	});

	it("getRegistryTool returns the tool with its scope", () => {
		expect(getRegistryTool("github_workflow_runs")?.scope).toBe("read");
		expect(getRegistryTool("github_create_issue")?.scope).toBe("write");
		expect(getRegistryTool("does_not_exist")).toBeUndefined();
	});

	it("blocks a WRITE tool without consent (fail-closed)", async () => {
		const r = await runRegistryTool("github_create_issue", { env: envWithConsent(false), userId: "u1", instanceId: "i1" }, { repo: "o/n", title: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/isn't permitted|not permitted|consent/i);
	});

	it("blocks a WRITE tool when there's no instance context (fail-closed)", async () => {
		const r = await runRegistryTool("github_create_issue", { env: envWithConsent(true), userId: "u1" }, { repo: "o/n", title: "hi" });
		expect(r.success).toBe(false);
	});

	it("passes the consent gate for a WRITE tool when granted (then fails later on not-connected)", async () => {
		const r = await runRegistryTool("github_create_issue", { env: envWithConsent(true), userId: "u1", instanceId: "i1" }, { repo: "o/n", title: "hi" });
		// Gate passed → handler ran → GitHub not configured in this env → its own error,
		// NOT the consent error.
		expect(r.content).not.toMatch(/isn't permitted/i);
		expect(r.content).toMatch(/not connected|not configured/i);
	});
});

describe("tmux connector", () => {
	it("registers the tmux tools with correct scopes", () => {
		const names = registryToolNameSet();
		expect(names.has("tmux_list_sessions")).toBe(true);
		expect(names.has("tmux_capture_pane")).toBe(true);
		expect(names.has("tmux_run_command")).toBe(true);
		expect(names.has("tmux_send_keys")).toBe(true);
		expect(getRegistryTool("tmux_list_sessions")?.scope).toBe("read");
		expect(getRegistryTool("tmux_capture_pane")?.scope).toBe("read");
		expect(getRegistryTool("tmux_run_command")?.scope).toBe("write");
		expect(getRegistryTool("tmux_send_keys")?.scope).toBe("write");
		expect(getRegistryTool("tmux_new_session")?.scope).toBe("write");
		expect(getRegistryTool("tmux_kill_session")?.scope).toBe("write");
	});

	it("groups tmux tools under the tmux connector for the catalog", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "tmux");
		expect(grp?.tools).toContain("tmux_list_sessions");
		expect(grp?.tools).toContain("tmux_run_command");
	});

	it("a READ tool with no runner connected → clear error, no throw", async () => {
		const r = await runRegistryTool("tmux_list_sessions", { env: envNoGithub, userId: "u1", instanceId: "i1" }, {});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/runner|pags up/i);
	});

	it("a WRITE tool without consent is blocked before touching the runner (fail-closed)", async () => {
		const r = await runRegistryTool("tmux_run_command", { env: envWithConsent(false), userId: "u1", instanceId: "i1" }, { session: "dev", command: "ls" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/isn't permitted|not permitted|consent/i);
	});
});
