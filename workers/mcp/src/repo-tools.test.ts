import { describe, expect, it } from "vitest";
import {
	AGENT_ID,
	agentTemplateFiles,
	b64,
	fromB64,
	repoNameFor,
} from "./repo-tools.js";

const baseConfig = {
	slug: "job-helper",
	name: "Job Helper",
	description: "Helps with applications.",
	category: "productivity",
	model: "@cf/meta/llama-3.2-3b-instruct",
} as const;

describe("repo tool helpers", () => {
	it("validates agent slug shape", () => {
		expect(AGENT_ID.safeParse("job-apply-agent").success).toBe(true);
		expect(AGENT_ID.safeParse("JobApplyAgent").success).toBe(false);
		expect(AGENT_ID.safeParse("1-job-apply-agent").success).toBe(false);
	});

	it("normalizes repository names from agent IDs", () => {
		expect(repoNameFor("Job_Helper")).toBe("job-helper");
		expect(repoNameFor("sales.agent")).toBe("sales-agent");
	});

	it("round-trips UTF-8 content through base64 helpers", () => {
		const text = "resume: Jose Alvarez\nrole: senior engineer";

		expect(fromB64(b64(text))).toBe(text);
	});

	it("creates worker agent templates with durable object bindings", () => {
		const files = agentTemplateFiles({ ...baseConfig, template: "worker" });

		expect(JSON.parse(files.get("agent.json") || "{}")).toMatchObject({
			id: "job-helper",
			storeType: "agent",
			serverConfig: {
				durableObject: true,
				aiBilling: "caller-provided",
			},
		});
		expect(files.get("wrangler.toml")).toContain("[[durable_objects.bindings]]");
		expect(files.get("wrangler.toml")).toContain('new_classes = ["GeneratedAgentDO"]');
		expect(files.get("src/index.ts")).toContain('app.post("/chat"');
		expect(files.get("README.md")).toContain("caller-provided Cloudflare Workers AI credentials");
	});

	it("creates API and cron templates with the right runtime entry points", () => {
		const apiFiles = agentTemplateFiles({ ...baseConfig, template: "api" });
		const cronFiles = agentTemplateFiles({ ...baseConfig, template: "cron" });

		expect(JSON.parse(apiFiles.get("agent.json") || "{}")).toMatchObject({
			storeType: "tool",
			template: "api",
		});
		expect(apiFiles.get("src/index.ts")).toContain('app.post("/run"');

		expect(JSON.parse(cronFiles.get("agent.json") || "{}")).toMatchObject({
			storeType: "worker",
			template: "cron",
			serverConfig: {
				cron: "0 8 * * *",
			},
		});
		expect(cronFiles.get("wrangler.toml")).toContain("[triggers]");
		expect(cronFiles.get("src/index.ts")).toContain("async scheduled");
	});
});
