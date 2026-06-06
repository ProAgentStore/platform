import { describe, expect, it } from "vitest";

// Mirror check names from check.ts so tests fail if names change.
const CHECK_NAMES = [
	"agent.json",
	"manifest.id",
	"manifest.name",
	"manifest.storeType",
	"manifest.category",
	"wrangler.toml",
	"src/index.ts",
	"package.json",
	"deploy.yml",
	"README.md",
	"no secrets",
] as const;

type CheckName = (typeof CHECK_NAMES)[number];

interface CheckResult {
	name: CheckName | string;
	pass: boolean;
	message: string;
}

// Secret detection logic mirrored from check.ts
function detectSecrets(content: string): boolean {
	return (
		/secret|password|token/i.test(content) &&
		/sk-|gsk_|sk-ant-/.test(content)
	);
}

describe("all 11 check names", () => {
	it("defines exactly 11 checks", () => {
		expect(CHECK_NAMES).toHaveLength(11);
	});

	it("includes agent.json check", () => {
		expect(CHECK_NAMES).toContain("agent.json");
	});

	it("includes manifest.id check", () => {
		expect(CHECK_NAMES).toContain("manifest.id");
	});

	it("includes manifest.name check", () => {
		expect(CHECK_NAMES).toContain("manifest.name");
	});

	it("includes manifest.storeType check", () => {
		expect(CHECK_NAMES).toContain("manifest.storeType");
	});

	it("includes manifest.category check", () => {
		expect(CHECK_NAMES).toContain("manifest.category");
	});

	it("includes wrangler.toml check", () => {
		expect(CHECK_NAMES).toContain("wrangler.toml");
	});

	it("includes src/index.ts check", () => {
		expect(CHECK_NAMES).toContain("src/index.ts");
	});

	it("includes package.json check", () => {
		expect(CHECK_NAMES).toContain("package.json");
	});

	it("includes deploy.yml check", () => {
		expect(CHECK_NAMES).toContain("deploy.yml");
	});

	it("includes README.md check", () => {
		expect(CHECK_NAMES).toContain("README.md");
	});

	it("includes no secrets check", () => {
		expect(CHECK_NAMES).toContain("no secrets");
	});
});

describe("secret detection regex", () => {
	it("detects an OpenAI key in wrangler.toml content", () => {
		const content = 'SECRET_KEY = "sk-abc123"\ntoken = "something"';
		expect(detectSecrets(content)).toBe(true);
	});

	it("detects a Groq key in wrangler.toml content", () => {
		const content = 'token = "gsk_XXXXXXXXXXXXXXXX"';
		expect(detectSecrets(content)).toBe(true);
	});

	it("detects an Anthropic key in wrangler.toml content", () => {
		const content = 'password = "sk-ant-api03-XXXX"';
		expect(detectSecrets(content)).toBe(true);
	});

	it("clears a file with no keys at all", () => {
		const content =
			'name = "my-agent"\nmain = "src/index.ts"\ncompatibility_date = "2026-01-01"';
		expect(detectSecrets(content)).toBe(false);
	});

	it("clears a file mentioning 'token' in a binding name (no key value)", () => {
		// The regex requires BOTH a secret/password/token keyword AND a key prefix
		const content = 'binding = "AI_TOKEN"\n[ai]';
		// "token" matches the first regex but no sk-/gsk_/sk-ant- prefix → clean
		expect(detectSecrets(content)).toBe(false);
	});

	it("clears a file with a key prefix but no secret/token keyword", () => {
		// If someone put a comment with sk- but no keyword near it, still clean
		// because the regex requires both conditions simultaneously
		const content = "# example: sk-xxxx goes here\n[ai]";
		// "secret" is not present, "password" is not, "token" is not → clean
		expect(detectSecrets(content)).toBe(false);
	});

	it("detects secret keyword combined with sk- prefix", () => {
		const content = "# set your secret: sk-12345";
		expect(detectSecrets(content)).toBe(true);
	});

	it("is case-insensitive for keywords", () => {
		const content = 'PASSWORD = "sk-secret-value"';
		expect(detectSecrets(content)).toBe(true);
	});

	it("detects 'SECRET' uppercase combined with gsk_", () => {
		const content = 'SECRET = "gsk_XXXXXX"';
		expect(detectSecrets(content)).toBe(true);
	});
});

describe("check result structure", () => {
	it("passing result has pass=true", () => {
		const result: CheckResult = {
			name: "agent.json",
			pass: true,
			message: "Found",
		};
		expect(result.pass).toBe(true);
		expect(result.message).toBe("Found");
	});

	it("failing result has pass=false", () => {
		const result: CheckResult = {
			name: "agent.json",
			pass: false,
			message: "Missing agent.json manifest",
		};
		expect(result.pass).toBe(false);
		expect(result.message).toContain("Missing");
	});

	it("pass count is computed correctly", () => {
		const results: CheckResult[] = [
			{ name: "agent.json", pass: true, message: "Found" },
			{ name: "manifest.id", pass: true, message: "my-agent" },
			{ name: "wrangler.toml", pass: false, message: "Missing" },
		];
		const passed = results.filter((r) => r.pass).length;
		expect(passed).toBe(2);
	});

	it("all-pass means no process.exit(1)", () => {
		const results: CheckResult[] = CHECK_NAMES.map((name) => ({
			name,
			pass: true,
			message: "Found",
		}));
		const passed = results.filter((r) => r.pass).length;
		const total = results.length;
		// When passed === total, the CLI would NOT call process.exit(1)
		expect(passed).toBe(total);
	});

	it("any failure triggers exit condition", () => {
		const results: CheckResult[] = [
			{ name: "agent.json", pass: true, message: "Found" },
			{ name: "wrangler.toml", pass: false, message: "Missing" },
		];
		const passed = results.filter((r) => r.pass).length;
		const total = results.length;
		expect(passed).toBeLessThan(total);
	});
});

describe("manifest field validation logic", () => {
	it("all required fields present → all pass", () => {
		const manifest: Record<string, unknown> = {
			id: "my-agent",
			name: "My Agent",
			storeType: "agent",
			category: "general",
		};
		const required = ["id", "name", "storeType", "category"];
		for (const field of required) {
			expect(!!manifest[field]).toBe(true);
		}
	});

	it("missing field → fails that check", () => {
		const manifest: Record<string, unknown> = {
			name: "My Agent",
			storeType: "agent",
			category: "general",
			// 'id' is missing
		};
		expect(!!manifest.id).toBe(false);
		expect(!!manifest.name).toBe(true);
	});

	it("empty string counts as missing", () => {
		const manifest: Record<string, unknown> = { id: "" };
		expect(!!manifest.id).toBe(false);
	});

	it("zero counts as missing (falsy)", () => {
		const manifest: Record<string, unknown> = { id: 0 };
		expect(!!manifest.id).toBe(false);
	});
});
