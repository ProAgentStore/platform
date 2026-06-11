import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { writeLine } from "../output.js";

interface CheckResult {
	name: string;
	pass: boolean;
	message: string;
}

export const checkCommand = new Command("check")
	.description("Run compliance checks on an agent")
	.option("-d, --dir <path>", "Agent directory", ".")
	.action((opts: { dir: string }) => {
		const dir = resolve(opts.dir);
		const results: CheckResult[] = [];

		// 1. agent.json exists
		const manifestPath = join(dir, "agent.json");
		const hasManifest = existsSync(manifestPath);
		results.push({
			name: "agent.json",
			pass: hasManifest,
			message: hasManifest ? "Found" : "Missing agent.json manifest",
		});

		let manifest: Record<string, unknown> = {};
		if (hasManifest) {
			try {
				manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
			} catch {
				results.push({
					name: "agent.json parse",
					pass: false,
					message: "Invalid JSON",
				});
			}
		}

		// 2. Required manifest fields
		for (const field of ["id", "name", "storeType", "category"]) {
			const has = !!manifest[field];
			results.push({
				name: `manifest.${field}`,
				pass: has,
				message: has ? String(manifest[field]) : `Missing ${field}`,
			});
		}

		// 3. wrangler.toml
		const hasWrangler = existsSync(join(dir, "wrangler.toml"));
		results.push({
			name: "wrangler.toml",
			pass: hasWrangler,
			message: hasWrangler ? "Found" : "Missing",
		});

		// 4. src/index.ts
		const hasEntry = existsSync(join(dir, "src", "index.ts"));
		results.push({
			name: "src/index.ts",
			pass: hasEntry,
			message: hasEntry ? "Found" : "Missing entry point",
		});

		// 5. package.json
		const hasPkg = existsSync(join(dir, "package.json"));
		results.push({
			name: "package.json",
			pass: hasPkg,
			message: hasPkg ? "Found" : "Missing",
		});

		// 6. Deploy workflow
		const hasWorkflow = existsSync(
			join(dir, ".github", "workflows", "deploy.yml"),
		);
		results.push({
			name: "deploy.yml",
			pass: hasWorkflow,
			message: hasWorkflow ? "Found" : "Missing deploy workflow",
		});

		// 7. README
		const hasReadme = existsSync(join(dir, "README.md"));
		results.push({
			name: "README.md",
			pass: hasReadme,
			message: hasReadme ? "Found" : "Missing",
		});

		// 8. No secrets in source
		const wranglerContent = hasWrangler
			? readFileSync(join(dir, "wrangler.toml"), "utf-8")
			: "";
		const hasSecretInWrangler =
			/secret|password|token/i.test(wranglerContent) &&
			/sk-|gsk_|sk-ant-/.test(wranglerContent);
		results.push({
			name: "no secrets",
			pass: !hasSecretInWrangler,
			message: hasSecretInWrangler
				? "Possible secret in wrangler.toml!"
				: "Clean",
		});

		// Print results
		const passed = results.filter((r) => r.pass).length;
		const total = results.length;
		writeLine(
			`\n  ProAgentStore compliance check: ${passed}/${total} passed\n`,
		);
		for (const r of results) {
			writeLine(
				`  ${r.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name} — ${r.message}`,
			);
		}
		writeLine();

		if (passed < total) process.exit(1);
	});
