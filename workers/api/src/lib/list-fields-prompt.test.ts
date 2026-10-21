/**
 * #1263 — the schema the in-app agent is shown for the comma-list tools is unchanged: still `string`, no extra keyword (a provider's
 * function-declaration validator can reject an unknown one), and no `listFields` leaking into what the model receives.
 */
import { describe, expect, it } from "vitest";
import { buildAgentToolDefinitions } from "../agent-do-tools.js";
import { GITHUB_TOOLS } from "./connectors/github.js";

describe("what the model is shown for a comma-list tool", () => {
	const defs = buildAgentToolDefinitions({ capabilities: { tools: ["github_create_issue", "github_update_issue", "github_list_issues"] } as never });
	const fn = (name: string) => defs.find((d) => d.function.name === name)?.function;

	it("declares each list field as a plain string, as before", () => {
		const props = (name: string) => (fn(name)?.parameters as { properties: Record<string, Record<string, unknown>> }).properties;
		expect(props("github_create_issue").labels.type).toBe("string");
		expect(props("github_update_issue").labels.type).toBe("string");
		expect(props("github_update_issue").assignees.type).toBe("string");
		expect(props("github_list_issues").exclude_labels.type).toBe("string");
	});

	it("adds no keyword to any property of these tools beyond type and description", () => {
		for (const t of GITHUB_TOOLS.filter((x) => x.listFields)) {
			for (const [key, spec] of Object.entries(t.jsonSchema.properties)) {
				expect(Object.keys(spec).filter((k) => k !== "type" && k !== "description"), `${t.name}.${key}`).toEqual([]);
			}
		}
	});

	it("does not hand listFields to the model in any tool definition", () => {
		expect(JSON.stringify(defs)).not.toContain("listFields");
	});

	it("tells the model an array is fine, in the field's own description", () => {
		const props = (fn("github_create_issue")?.parameters as { properties: Record<string, { description: string }> }).properties;
		expect(props.labels.description).toMatch(/array of names is accepted too/);
	});
});
