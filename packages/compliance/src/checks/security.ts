import fs from "node:fs";
import path from "node:path";
import type { CheckResult } from "../types.js";

// Patterns that look like real secrets (not just the words)
const SECRET_PATTERNS = [
	/sk-[A-Za-z0-9]{20,}/,           // OpenAI
	/sk-ant-[A-Za-z0-9-]{20,}/,      // Anthropic
	/gsk_[A-Za-z0-9]{20,}/,          // Groq
	/AIza[A-Za-z0-9_-]{35}/,         // Google API key
	/AKIA[A-Z0-9]{16}/,               // AWS access key
	/(?:gh[pos]|github_pat)_[A-Za-z0-9_]{36,}/i, // GitHub PAT
	/Bearer\s+[A-Za-z0-9._-]{20,}/,  // Bearer tokens
	/['"]\s*[A-Za-z0-9+/]{40,}={0,2}\s*['"]/,    // Long base64 strings that look like keys
] as const;

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|toml|yaml|yml|env)$/;
const ENV_FILE_RE = /^\.env(\.|$)/;

function walkSrc(dir: string, skip: Set<string>): string[] {
	const files: string[] = [];
	if (!fs.existsSync(dir)) return files;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (skip.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkSrc(full, skip));
		} else if (SOURCE_EXTENSIONS.test(entry.name)) {
			files.push(full);
		}
	}
	return files;
}

export async function checkSecurity(dir: string): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const skip = new Set(["node_modules", "dist", ".git"]);

	// Check for .env files committed (anything named .env, .env.production, etc.)
	const envFiles: string[] = [];
	function findEnvFiles(d: string) {
		if (!fs.existsSync(d)) return;
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			if (skip.has(entry.name)) continue;
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) findEnvFiles(full);
			else if (ENV_FILE_RE.test(entry.name) && entry.name !== ".env.example") {
				envFiles.push(path.relative(dir, full));
			}
		}
	}
	findEnvFiles(dir);

	results.push({
		name: "security-no-env-files",
		pass: envFiles.length === 0,
		message:
			envFiles.length === 0
				? "No .env files found"
				: `Committed .env files found: ${envFiles.join(", ")}`,
		severity: "error",
	});

	// Scan source files for hardcoded secrets
	const sourceFiles = walkSrc(dir, skip);
	const secretHits: string[] = [];

	for (const file of sourceFiles) {
		// Skip lock files and .gitignore-style files
		if (file.endsWith("pnpm-lock.yaml") || file.endsWith("package-lock.json")) continue;
		const content = fs.readFileSync(file, "utf-8");
		for (const pattern of SECRET_PATTERNS) {
			if (pattern.test(content)) {
				secretHits.push(path.relative(dir, file));
				break;
			}
		}
	}

	results.push({
		name: "security-no-hardcoded-secrets",
		pass: secretHits.length === 0,
		message:
			secretHits.length === 0
				? "No hardcoded tokens found"
				: `Possible hardcoded secrets in: ${secretHits.join(", ")}`,
		severity: "error",
	});

	return results;
}
