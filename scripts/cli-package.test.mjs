import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBrowserRunner } from "../packages/cli/scripts/copy-browser-runner.mjs";

const roots = [];
async function fixture(cliDependencies) {
	const root = await mkdtemp(join(tmpdir(), "pags-copy-runner-"));
	roots.push(root);
	const cliRoot = join(root, "cli");
	const runnerRoot = join(root, "runner");
	await mkdir(join(cliRoot, "dist", "browser-runner"), { recursive: true });
	await mkdir(join(runnerRoot, "dist"), { recursive: true });
	await writeFile(join(cliRoot, "package.json"), JSON.stringify({ dependencies: cliDependencies }));
	await writeFile(join(runnerRoot, "package.json"), JSON.stringify({ dependencies: { "runtime-dependency": "1.2.3" } }));
	await writeFile(join(cliRoot, "dist", "browser-runner", "previous.txt"), "previous build");
	await writeFile(join(runnerRoot, "dist", "server.js"), "export const version = 'new build';\n");
	return { cliRoot, runnerRoot };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("CLI copied runtime dependency boundary", () => {
	// Invariant: copying unbundled code cannot produce a package that omits its runtime dependencies.
	it("refuses a missing runner dependency before replacing the previous build", async () => {
		const dirs = await fixture({});
		await expect(copyBrowserRunner(dirs)).rejects.toThrow("runtime-dependency@1.2.3");
		expect(await readFile(join(dirs.cliRoot, "dist/browser-runner/previous.txt"), "utf8")).toBe("previous build");
	});

	it("refuses a dependency range different from the runner's tested range", async () => {
		const dirs = await fixture({ "runtime-dependency": "0.9.0" });
		await expect(copyBrowserRunner(dirs)).rejects.toThrow("CLI declares 0.9.0");
	});

	it("copies a runner when its dependencies are published by the CLI", async () => {
		const dirs = await fixture({ "runtime-dependency": "1.2.3", "cli-only": "2.0.0" });
		await copyBrowserRunner(dirs);
		expect(await readFile(join(dirs.cliRoot, "dist/browser-runner/server.js"), "utf8")).toBe("export const version = 'new build';\n");
		await expect(readFile(join(dirs.cliRoot, "dist/browser-runner/previous.txt"))).rejects.toThrow();
	});
});
