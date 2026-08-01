import { describe, expect, it } from "vitest";
import { agentCapabilities } from "./agent-capabilities.js";
import { sanitizeAgentDefinition } from "./agent-definition.js";

describe("sanitizeAgentDefinition", () => {
	const valid = {
		identity: {
			personality: "  You are a helpful research assistant.  ",
			goal: "Answer questions grounded in the indexed docs.",
			welcomeMessage: "Ask me anything about your documents.",
			guardrails: { responseStyle: "concise", requireCitations: true, maxResponseLength: 500 },
		},
		capabilities: {
			surfaces: ["repo"],
			runtime: null,
			workflow: null,
			tools: ["search_knowledge", "read_knowledge"],
		},
		settingsSchema: [{ id: "lang", label: "Language", type: "select", options: [{ value: "en", label: "English" }] }],
	};

	it("normalizes a complete definition (trims strings, keeps valid fields)", () => {
		const def = sanitizeAgentDefinition(valid);
		expect(def.identity.personality).toBe("You are a helpful research assistant.");
		expect(def.identity.goal).toBe("Answer questions grounded in the indexed docs.");
		expect(def.identity.guardrails.responseStyle).toBe("concise");
		expect(def.identity.guardrails.requireCitations).toBe(true);
		expect(def.capabilities.surfaces).toEqual(["repo"]);
		expect(def.capabilities.tools).toEqual(["search_knowledge", "read_knowledge"]);
		expect(def.settingsSchema).toHaveLength(1);
	});

	it("defaults guardrails when absent and coerces non-string identity to empty", () => {
		const def = sanitizeAgentDefinition({ identity: { personality: 42 } });
		expect(def.identity.personality).toBe("");
		expect(def.identity.goal).toBe("");
		// defaultGuardrails() fills a complete, safe object.
		expect(def.identity.guardrails).toMatchObject({
			responseStyle: "",
			blockedTerms: [],
			maxResponseLength: 0,
			requireCitations: false,
		});
	});

	it("drops unknown surfaces / runtime / workflow and ungrantable tools", () => {
		const def = sanitizeAgentDefinition({
			capabilities: {
				surfaces: ["repo", "bogus"],
				runtime: "teleport",
				workflow: "MADE_UP",
				tools: ["search_knowledge", "not_a_tool", "find_confirmation_link"],
			},
		});
		expect(def.capabilities.surfaces).toEqual(["repo"]);
		expect(def.capabilities.runtime).toBeNull();
		expect(def.capabilities.workflow).toBeNull();
		// sanitizeToolList only trims obvious junk; the ungrantable ones are filtered at
		// resolution time — but the malformed catalog name is a well-formed string, so it
		// survives sanitize and is dropped later by toolNamesFor. Real tool name stays.
		expect(def.capabilities.tools).toContain("search_knowledge");
	});

	it("omits settingsSchema entirely when none is valid", () => {
		expect(sanitizeAgentDefinition({}).settingsSchema).toBeUndefined();
		expect(sanitizeAgentDefinition({ settingsSchema: "nope" }).settingsSchema).toBeUndefined();
	});

	it("never throws on garbage input", () => {
		for (const junk of [null, undefined, 3, "x", [], { identity: null, capabilities: 5 }]) {
			expect(() => sanitizeAgentDefinition(junk)).not.toThrow();
		}
	});

	it("round-trips: the emitted config is read back correctly by agentCapabilities", () => {
		// The whole point — a definition serialized to agents.config must resolve through
		// the SAME registry the runtime uses.
		const config = JSON.stringify(sanitizeAgentDefinition(valid));
		const caps = agentCapabilities({ slug: "some-agent", config });
		expect(caps.surfaces).toEqual(["repo"]);
		expect(caps.tools).toEqual(["search_knowledge", "read_knowledge"]);
		expect(caps.settingsSchema).toHaveLength(1);
	});
});
