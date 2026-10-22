import { cp, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const defaultCliRoot = resolve(dirname(self), "..");

export async function copyBrowserRunner({ cliRoot = defaultCliRoot, runnerRoot = resolve(cliRoot, "../browser-runner") } = {}) {
	const manifest = async (root) => JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
	const [cli, runner] = await Promise.all([manifest(cliRoot), manifest(runnerRoot)]);
	// This is copied JavaScript, not a bundle. Its external imports resolve through the CLI's
	// published dependencies even when the CLI's own TypeScript never imports those packages.
	for (const [name, range] of Object.entries(runner.dependencies ?? {})) {
		if (cli.dependencies?.[name] !== range) {
			throw new Error(`Copied browser runner requires ${name}@${range}; CLI declares ${cli.dependencies?.[name] ?? "nothing"}. Keep the CLI's runtime dependencies aligned before building.`);
		}
	}
	const target = resolve(cliRoot, "dist/browser-runner");
	await rm(target, { force: true, recursive: true });
	await cp(resolve(runnerRoot, "dist"), target, { recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === self) await copyBrowserRunner();
