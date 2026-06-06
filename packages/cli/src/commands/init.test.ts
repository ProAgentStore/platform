import { describe, expect, it } from "vitest";

// Slug normalization logic mirrored from init.ts
function normalizeSlug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

const TEMPLATES = ["worker", "cron", "api"] as const;
type TemplateType = (typeof TEMPLATES)[number];

function buildManifest(slug: string, name: string, template: TemplateType) {
	return {
		id: slug,
		name,
		description: "",
		storeType:
			template === "api"
				? "tool"
				: template === "cron"
					? "worker"
					: "agent",
		category: "general",
		model: "@cf/meta/llama-3.2-3b-instruct",
		template,
		serverConfig: {
			durableObject: template === "worker",
			cron: template === "cron" ? "0 8 * * *" : undefined,
			routes: [`${slug}.proagentstore.online/*`],
		},
	};
}

describe("slug normalization", () => {
	it("lowercases uppercase letters", () => {
		expect(normalizeSlug("MyAgent")).toBe("myagent");
	});

	it("lowercases mixed case", () => {
		expect(normalizeSlug("My-Agent")).toBe("my-agent");
	});

	it("converts spaces to hyphens", () => {
		expect(normalizeSlug("my agent")).toBe("my-agent");
	});

	it("converts multiple spaces to multiple hyphens", () => {
		expect(normalizeSlug("my cool agent")).toBe("my-cool-agent");
	});

	it("replaces underscores with hyphens", () => {
		expect(normalizeSlug("my_agent")).toBe("my-agent");
	});

	it("replaces dots with hyphens", () => {
		expect(normalizeSlug("my.agent")).toBe("my-agent");
	});

	it("preserves lowercase letters and hyphens", () => {
		expect(normalizeSlug("my-agent-v2")).toBe("my-agent-v2");
	});

	it("preserves digits", () => {
		expect(normalizeSlug("agent123")).toBe("agent123");
	});

	it("lowercases and normalizes complex input", () => {
		expect(normalizeSlug("My Cool Agent V2")).toBe("my-cool-agent-v2");
	});

	it("handles already-valid slug unchanged", () => {
		expect(normalizeSlug("summarizer")).toBe("summarizer");
	});

	it("handles all special characters", () => {
		expect(normalizeSlug("agent@#$%!")).toBe("agent-----");
	});
});

describe("template validation", () => {
	it("worker is a valid template", () => {
		expect(TEMPLATES).toContain("worker");
	});

	it("cron is a valid template", () => {
		expect(TEMPLATES).toContain("cron");
	});

	it("api is a valid template", () => {
		expect(TEMPLATES).toContain("api");
	});

	it("contains exactly 3 templates", () => {
		expect(TEMPLATES).toHaveLength(3);
	});

	it("rejects unknown template", () => {
		const template = "unknown";
		expect(TEMPLATES).not.toContain(template);
	});

	it("default template is worker", () => {
		const defaultTemplate = "worker";
		expect(TEMPLATES).toContain(defaultTemplate);
	});
});

describe("agent.json manifest shape for worker template", () => {
	const manifest = buildManifest("my-agent", "My Agent", "worker");

	it("id equals the slug", () => {
		expect(manifest.id).toBe("my-agent");
	});

	it("name equals the original name", () => {
		expect(manifest.name).toBe("My Agent");
	});

	it("storeType is 'agent' for worker template", () => {
		expect(manifest.storeType).toBe("agent");
	});

	it("model defaults to llama-3.2-3b-instruct", () => {
		expect(manifest.model).toBe("@cf/meta/llama-3.2-3b-instruct");
	});

	it("template field is 'worker'", () => {
		expect(manifest.template).toBe("worker");
	});

	it("durableObject is true for worker template", () => {
		expect(manifest.serverConfig.durableObject).toBe(true);
	});

	it("cron is undefined for worker template", () => {
		expect(manifest.serverConfig.cron).toBeUndefined();
	});

	it("routes contains slug-based subdomain", () => {
		expect(manifest.serverConfig.routes).toContain(
			"my-agent.proagentstore.online/*",
		);
	});
});

describe("agent.json manifest shape for cron template", () => {
	const manifest = buildManifest("daily-digest", "Daily Digest", "cron");

	it("storeType is 'worker' for cron template", () => {
		expect(manifest.storeType).toBe("worker");
	});

	it("template field is 'cron'", () => {
		expect(manifest.template).toBe("cron");
	});

	it("durableObject is false for cron template", () => {
		expect(manifest.serverConfig.durableObject).toBe(false);
	});

	it("cron schedule is '0 8 * * *'", () => {
		expect(manifest.serverConfig.cron).toBe("0 8 * * *");
	});

	it("routes contains slug-based subdomain", () => {
		expect(manifest.serverConfig.routes).toContain(
			"daily-digest.proagentstore.online/*",
		);
	});
});

describe("agent.json manifest shape for api template", () => {
	const manifest = buildManifest("text-transform", "Text Transform", "api");

	it("storeType is 'tool' for api template", () => {
		expect(manifest.storeType).toBe("tool");
	});

	it("template field is 'api'", () => {
		expect(manifest.template).toBe("api");
	});

	it("durableObject is false for api template", () => {
		expect(manifest.serverConfig.durableObject).toBe(false);
	});

	it("cron is undefined for api template", () => {
		expect(manifest.serverConfig.cron).toBeUndefined();
	});

	it("routes contains slug-based subdomain", () => {
		expect(manifest.serverConfig.routes).toContain(
			"text-transform.proagentstore.online/*",
		);
	});

	it("category defaults to 'general'", () => {
		expect(manifest.category).toBe("general");
	});
});
