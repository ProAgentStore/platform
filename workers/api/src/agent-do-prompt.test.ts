import { describe, expect, it } from "vitest";
import type { AgentState } from "./agent-types.js";
import {
	DEFAULT_MODEL,
	buildSystemPrompt,
	defaultGuardrails,
	ensureStateDefaults,
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
});
