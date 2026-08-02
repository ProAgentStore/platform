import { describe, expect, it } from "vitest";
import type { AgentState } from "./agent-types.js";
import {
	DEFAULT_MODEL,
	TOOL_CAPABLE_CF_DEFAULT,
	TOOL_CAPABLE_MODELS,
	buildSystemPrompt,
	defaultGuardrails,
	ensureStateDefaults,
	resolveModelForTools,
} from "./agent-do-prompt.js";

describe("agent prompt helpers", () => {
	it("fills guardrail defaults while preserving configured values", () => {
		expect(
			defaultGuardrails({
				topicRestrictions: "Only answer about hiring workflows",
				blockedTerms: ["guaranteed"],
				requireCitations: true,
			}),
		).toEqual({
			topicRestrictions: "Only answer about hiring workflows",
			blockedTerms: ["guaranteed"],
			responseStyle: "",
			maxResponseLength: 0,
			requireCitations: true,
		});
	});

	it("repairs legacy agent state defaults in place", () => {
		const state = {
			agentId: "agent-1",
			name: "Hiring Agent",
			personality: "",
			goal: "",
			model: "@cf/meta/llama-3.1-8b-instruct",
			status: "thinking",
			systemPrompt: "",
		} as AgentState;

		expect(ensureStateDefaults(state)).toBe(state);
		expect(state.model).toBe(DEFAULT_MODEL);
		expect(state.status).toBe("idle");
		expect(state.guardrails).toEqual(defaultGuardrails());
		expect(state.welcomeMessage).toBe("");
		expect(state.isPublished).toBe(false);
	});

	it("leaves modern model and publication fields untouched", () => {
		const state: AgentState = {
			agentId: "agent-1",
			name: "Hiring Agent",
			personality: "",
			goal: "",
			model: "@cf/meta/llama-4-scout-17b-16e-instruct",
			status: "idle",
			systemPrompt: "",
			guardrails: defaultGuardrails({ responseStyle: "concise" }),
			welcomeMessage: "Ready",
			isPublished: true,
		};

		ensureStateDefaults(state);

		expect(state.model).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
		expect(state.guardrails.responseStyle).toBe("concise");
		expect(state.welcomeMessage).toBe("Ready");
		expect(state.isPublished).toBe(true);
	});

	it("builds a system prompt with configured guardrail instructions", () => {
		const prompt = buildSystemPrompt(
			"Apply Bot",
			"precise and skeptical",
			"Screen opportunities for remote engineering jobs",
			defaultGuardrails({
				topicRestrictions: "Hiring, resumes, and job applications",
				blockedTerms: ["certain"],
				responseStyle: "short bullet points",
				maxResponseLength: 500,
				requireCitations: true,
			}),
		);

		expect(prompt).toContain("You are Apply Bot");
		expect(prompt).toContain("Personality: precise and skeptical");
		expect(prompt).toContain("Goal: Screen opportunities");
		expect(prompt).toContain("Topic restrictions: Hiring, resumes, and job applications.");
		expect(prompt).toContain("Never use these words or phrases: certain");
		expect(prompt).toContain("Response style: short bullet points");
		expect(prompt).toContain("Keep responses under 500 characters.");
		expect(prompt).toContain("Always cite which knowledge base document");
		expect(prompt).toContain("persistent memory and tasks");
	});

	describe("resolveModelForTools (#100 — non-tool-capable model must not silently drop tools)", () => {
		it("upgrades the default 3B model to a tool-capable CF model when the agent has tools", () => {
			// The exact footgun: an agent created without an explicit model gets DEFAULT_MODEL
			// (a non-tool-capable 3B), which silently disabled ALL its tools.
			expect(TOOL_CAPABLE_MODELS.has(DEFAULT_MODEL)).toBe(false); // guards the premise
			const { model, upgraded } = resolveModelForTools(DEFAULT_MODEL, true);
			expect(upgraded).toBe(true);
			expect(model).toBe(TOOL_CAPABLE_CF_DEFAULT);
			expect(TOOL_CAPABLE_MODELS.has(model)).toBe(true); // the upgraded model can call tools
		});

		it("leaves an already tool-capable model untouched", () => {
			const { model, upgraded } = resolveModelForTools("claude-sonnet-4-6", true);
			expect(upgraded).toBe(false);
			expect(model).toBe("claude-sonnet-4-6");
		});

		it("leaves a tool-capable CF model untouched", () => {
			const { model, upgraded } = resolveModelForTools(TOOL_CAPABLE_CF_DEFAULT, true);
			expect(upgraded).toBe(false);
			expect(model).toBe(TOOL_CAPABLE_CF_DEFAULT);
		});

		it("does NOT upgrade a genuinely tool-less agent (empty tool set)", () => {
			const { model, upgraded } = resolveModelForTools(DEFAULT_MODEL, false);
			expect(upgraded).toBe(false);
			expect(model).toBe(DEFAULT_MODEL);
		});

		it("upgrades any unknown/non-tool-capable model when tools are needed", () => {
			const { model, upgraded } = resolveModelForTools("@cf/some/unknown-model", true);
			expect(upgraded).toBe(true);
			expect(model).toBe(TOOL_CAPABLE_CF_DEFAULT);
		});
	});
});
