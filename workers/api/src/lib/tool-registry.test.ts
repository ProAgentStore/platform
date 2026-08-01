import { describe, expect, it } from "vitest";
import { getRegistryTool, registryConnectorGroups, registryToolDefs, registryToolNameSet, runRegistryTool } from "./tool-registry.js";
import type { Env } from "../types.js";

const envNoGithub = {} as unknown as Env; // githubAppConfigured() → false

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
		expect(getRegistryTool("does_not_exist")).toBeUndefined();
	});
});
