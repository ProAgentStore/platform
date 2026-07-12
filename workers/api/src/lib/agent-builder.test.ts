import { describe, expect, it } from "vitest";
import { planAgentFromPrompt, slugify } from "./agent-builder.js";

describe("agent builder planner", () => {
	it("normalizes slugs", () => {
		expect(slugify("Review Contracts!")).toBe("review-contracts");
		expect(slugify("123")).toBe("agent-123");
	});

	it("plans a basic chat agent for simple assistant prompts", () => {
		const plan = planAgentFromPrompt("Create an agent that answers support questions from uploaded knowledge.");
		expect(plan.action).toBe("create_agent");
		expect(plan.runtime?.kind).toBe("hosted");
		expect(plan.agent.name).toBe("Answers Support Questions Uploaded Agent");
		expect(plan.agent.slug).toBe("answers-support-questions-uploaded-agent");
		expect(plan.suggestedSurfaces).toContain("knowledge");
	});

	it("plans connector follow-up grants without executing them", () => {
		const plan = planAgentFromPrompt("Create an agent that reviews Google Docs in my shared drive and summarizes them.");
		expect(plan.connectors).toContainEqual(expect.objectContaining({ provider: "google_drive", requiredGrant: "shared_drive" }));
		expect(plan.warnings.join(" ")).toContain("not granted automatically");
	});

	it("plans scaffolded agents for API and browser prompts", () => {
		const apiPlan = planAgentFromPrompt("Create an API agent with a webhook endpoint for processing customer tickets.");
		expect(apiPlan.action).toBe("scaffold_agent");
		expect(apiPlan.template).toBe("api");

		const browserPlan = planAgentFromPrompt("Create an agent that logs into a website and fills browser forms for applications.");
		expect(browserPlan.action).toBe("scaffold_agent");
		expect(browserPlan.runtime?.kind).toBe("browser");
	});

	it("uses domain-specific names instead of generic create-agent prefixes", () => {
		const plan = planAgentFromPrompt("Create an agent that reviews Google Docs in a project folder and summarizes contract risks.");
		expect(plan.agent.name).toBe("Contract Review Agent");
		expect(plan.agent.slug).toBe("contract-review-agent");
	});
});
