import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runChecks } from "./index.js";

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pags-compliance-"));
}

function writeFiles(dir: string, files: Record<string, string>) {
	for (const [filePath, content] of Object.entries(files)) {
		const full = path.join(dir, filePath);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
}

const VALID_MANIFEST = JSON.stringify({
	id: "my-agent",
	name: "My Agent",
	description: "Does something useful",
	storeType: "agent",
	category: "productivity",
	model: "@cf/meta/llama-3.2-3b-instruct",
});

const VALID_WRANGLER = `
name = "proagentstore-my-agent"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[[routes]]
pattern = "my-agent.proagentstore.online/*"
zone_name = "proagentstore.online"
`.trim();

// --- manifest checks ---

describe("manifest checks", () => {
	it("fails when agent.json is missing", async () => {
		const dir = tmpDir();
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "manifest-exists");
		expect(r?.pass).toBe(false);
		expect(r?.severity).toBe("error");
	});

	it("fails when agent.json has invalid JSON", async () => {
		const dir = tmpDir();
		writeFiles(dir, { "agent.json": "{ not valid json" });
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "manifest-exists");
		expect(r?.pass).toBe(false);
	});

	it("passes when agent.json has all required fields", async () => {
		const dir = tmpDir();
		writeFiles(dir, { "agent.json": VALID_MANIFEST });
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "manifest-exists");
		expect(r?.pass).toBe(true);
		for (const field of ["id", "name", "description", "storeType", "category"]) {
			const fr = results.find((r) => r.name === `manifest-${field}`);
			expect(fr?.pass, `manifest-${field} should pass`).toBe(true);
		}
	});

	it("fails when required fields are missing", async () => {
		const dir = tmpDir();
		writeFiles(dir, { "agent.json": JSON.stringify({ id: "x" }) });
		const results = await runChecks(dir);
		const nameResult = results.find((r) => r.name === "manifest-name");
		expect(nameResult?.pass).toBe(false);
	});

	it("fails with invalid storeType", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"agent.json": JSON.stringify({
				id: "x",
				name: "X",
				description: "d",
				storeType: "invalid-type",
				category: "general",
			}),
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "manifest-storeType-valid");
		expect(r?.pass).toBe(false);
		expect(r?.message).toContain("invalid-type");
	});

	it("fails with invalid category", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"agent.json": JSON.stringify({
				id: "x",
				name: "X",
				description: "d",
				storeType: "agent",
				category: "not-a-category",
			}),
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "manifest-category-valid");
		expect(r?.pass).toBe(false);
	});

	it("fails when id is not slug format", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"agent.json": JSON.stringify({
				id: "My Agent!",
				name: "X",
				description: "d",
				storeType: "agent",
				category: "general",
			}),
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "manifest-slug-format");
		expect(r?.pass).toBe(false);
	});

	it("passes with valid slug", async () => {
		const dir = tmpDir();
		writeFiles(dir, { "agent.json": VALID_MANIFEST });
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "manifest-slug-format");
		expect(r?.pass).toBe(true);
	});
});

// --- wrangler checks ---

describe("wrangler checks", () => {
	it("fails when wrangler.toml is missing", async () => {
		const dir = tmpDir();
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "wrangler-exists");
		expect(r?.pass).toBe(false);
	});

	it("passes with a valid wrangler.toml", async () => {
		const dir = tmpDir();
		writeFiles(dir, { "wrangler.toml": VALID_WRANGLER });
		const results = await runChecks(dir);
		expect(results.find((r) => r.name === "wrangler-exists")?.pass).toBe(true);
		expect(results.find((r) => r.name === "wrangler-name")?.pass).toBe(true);
		expect(results.find((r) => r.name === "wrangler-routes")?.pass).toBe(true);
	});

	it("fails when wrangler.toml has no routes", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"wrangler.toml": 'name = "proagentstore-x"\nmain = "src/index.ts"',
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "wrangler-routes");
		expect(r?.pass).toBe(false);
	});

	it("fails when wrangler.toml has no name", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"wrangler.toml": 'main = "src/index.ts"\n[[routes]]\npattern = "x.proagentstore.online/*"',
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "wrangler-name");
		expect(r?.pass).toBe(false);
	});
});

// --- security checks ---

describe("security checks", () => {
	it("passes when no .env files or secrets present", async () => {
		const dir = tmpDir();
		writeFiles(dir, { "src/index.ts": 'export default { fetch() {} }' });
		const results = await runChecks(dir);
		expect(results.find((r) => r.name === "security-no-env-files")?.pass).toBe(true);
		expect(results.find((r) => r.name === "security-no-hardcoded-secrets")?.pass).toBe(true);
	});

	it("fails when a .env file is present", async () => {
		const dir = tmpDir();
		writeFiles(dir, { ".env": "SECRET=abc123" });
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "security-no-env-files");
		expect(r?.pass).toBe(false);
		expect(r?.message).toContain(".env");
	});

	it("does not flag .env.example", async () => {
		const dir = tmpDir();
		writeFiles(dir, { ".env.example": "SECRET=your-key-here" });
		const results = await runChecks(dir);
		expect(results.find((r) => r.name === "security-no-env-files")?.pass).toBe(true);
	});

	it("fails when OpenAI key is hardcoded", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"src/index.ts": 'const key = "sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789012345";',
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "security-no-hardcoded-secrets");
		expect(r?.pass).toBe(false);
	});

	it("fails when AWS key is hardcoded", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"src/index.ts": 'const awsKey = "AKIAIOSFODNN7EXAMPLE";',
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "security-no-hardcoded-secrets");
		expect(r?.pass).toBe(false);
	});
});

// --- structure checks ---

describe("structure checks", () => {
	it("fails when src/index.ts is missing", async () => {
		const dir = tmpDir();
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "structure-src-index");
		expect(r?.pass).toBe(false);
		expect(r?.severity).toBe("error");
	});

	it("passes when all required files exist", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"src/index.ts": "export default {}",
			"package.json": '{"name":"x"}',
			".github/workflows/deploy.yml": "on: push",
			"README.md": "# My Agent",
		});
		const results = await runChecks(dir);
		expect(results.find((r) => r.name === "structure-src-index")?.pass).toBe(true);
		expect(results.find((r) => r.name === "structure-package-json")?.pass).toBe(true);
		expect(results.find((r) => r.name === "structure-deploy-yml")?.pass).toBe(true);
		expect(results.find((r) => r.name === "structure-readme")?.pass).toBe(true);
	});

	it("warns (not errors) when README.md is missing", async () => {
		const dir = tmpDir();
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "structure-readme");
		expect(r?.pass).toBe(false);
		expect(r?.severity).toBe("warning");
	});
});

// --- metadata checks ---

describe("metadata checks", () => {
	it("fails when description is empty", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"agent.json": JSON.stringify({
				id: "x",
				name: "X",
				description: "",
				storeType: "agent",
				category: "general",
			}),
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "metadata-description-not-empty");
		expect(r?.pass).toBe(false);
	});

	it("warns when description exceeds 200 chars", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"agent.json": JSON.stringify({
				id: "x",
				name: "X",
				description: "a".repeat(201),
				storeType: "agent",
				category: "general",
			}),
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "metadata-description-length");
		expect(r?.pass).toBe(false);
		expect(r?.severity).toBe("warning");
	});

	it("warns when name exceeds 50 chars", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"agent.json": JSON.stringify({
				id: "x",
				name: "A".repeat(51),
				description: "short",
				storeType: "agent",
				category: "general",
			}),
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "metadata-name-length");
		expect(r?.pass).toBe(false);
		expect(r?.severity).toBe("warning");
	});

	it("passes with valid metadata", async () => {
		const dir = tmpDir();
		writeFiles(dir, { "agent.json": VALID_MANIFEST });
		const results = await runChecks(dir);
		expect(results.find((r) => r.name === "metadata-description-not-empty")?.pass).toBe(true);
		expect(results.find((r) => r.name === "metadata-description-length")?.pass).toBe(true);
		expect(results.find((r) => r.name === "metadata-name-length")?.pass).toBe(true);
	});
});

// --- model checks ---

describe("model checks", () => {
	it("warns when no model field in agent.json", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"agent.json": JSON.stringify({ id: "x", name: "X", description: "d" }),
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "model-specified");
		expect(r?.pass).toBe(false);
		expect(r?.severity).toBe("warning");
	});

	it("passes with a valid Workers AI model", async () => {
		const dir = tmpDir();
		writeFiles(dir, { "agent.json": VALID_MANIFEST });
		const results = await runChecks(dir);
		expect(results.find((r) => r.name === "model-not-deprecated")?.pass).toBe(true);
		expect(results.find((r) => r.name === "model-valid-workers-ai")?.pass).toBe(true);
	});

	it("fails with deprecated model", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"agent.json": JSON.stringify({
				id: "x",
				name: "X",
				description: "d",
				storeType: "agent",
				category: "general",
				model: "@cf/meta/llama-2-13b-chat-fp16",
			}),
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "model-not-deprecated");
		expect(r?.pass).toBe(false);
		expect(r?.severity).toBe("error");
	});

	it("warns with unknown model ID", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"agent.json": JSON.stringify({
				id: "x",
				name: "X",
				description: "d",
				storeType: "agent",
				category: "general",
				model: "@cf/unknown/future-model-v99",
			}),
		});
		const results = await runChecks(dir);
		const r = results.find((r) => r.name === "model-valid-workers-ai");
		expect(r?.pass).toBe(false);
		expect(r?.severity).toBe("warning");
	});
});

// --- runChecks integration ---

describe("runChecks", () => {
	it("returns CheckResult[] with name, pass, message, severity on every item", async () => {
		const dir = tmpDir();
		const results = await runChecks(dir);
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(typeof r.name).toBe("string");
			expect(typeof r.pass).toBe("boolean");
			expect(typeof r.message).toBe("string");
			expect(["error", "warning", "info"]).toContain(r.severity);
		}
	});

	it("returns all passing results for a fully valid agent", async () => {
		const dir = tmpDir();
		writeFiles(dir, {
			"agent.json": VALID_MANIFEST,
			"wrangler.toml": VALID_WRANGLER,
			"src/index.ts": "export default {}",
			"package.json": '{"name":"proagentstore-my-agent"}',
			".github/workflows/deploy.yml": "on: push",
			"README.md": "# My Agent",
		});
		const results = await runChecks(dir);
		const errors = results.filter((r) => !r.pass && r.severity === "error");
		expect(errors).toHaveLength(0);
	});
});
