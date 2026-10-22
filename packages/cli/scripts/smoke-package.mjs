#!/usr/bin/env node
/** Verify the published dependency boundary, outside the workspace that can mask missing imports. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "pags-cli-package-"));
const env = { ...process.env, PAGS_NO_SELF_UPDATE: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
// Inherited loaders or workspace search paths would defeat the clean-install check.
delete env.NODE_PATH;
delete env.NODE_OPTIONS;

function run(command, args, cwd, timeout = 120_000) {
	return execFileSync(command, args, { cwd, env, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
}

try {
	const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], cliRoot));
	if (packed.length !== 1 || !packed[0].filename) throw new Error("npm pack did not return exactly one tarball");
	const prefix = join(scratch, "install");
	run("npm", ["install", "--prefix", prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", join(scratch, packed[0].filename)], scratch);
	const installed = join(prefix, "node_modules", "@proagentstore", "cli");
	const version = run(process.execPath, ["dist/index.js", "--version"], installed, 30_000).trim();
	const help = run(process.execPath, ["dist/browser-runner/index.js", "--help"], installed, 30_000);
	if (!version || !help.includes("pags-browser-runner")) throw new Error("Installed CLI or runner did not answer its smoke probe");
	// Playwright itself is imported lazily when a browser job starts, so --help alone misses it.
	run(process.execPath, ["--input-type=module", "--eval", "const { chromium } = await import('playwright'); if (typeof chromium.launch !== 'function') throw new Error('Playwright browser launcher unavailable');"], installed, 30_000);
	console.log(`CLI PACKAGE GREEN ${version}: clean install, CLI, runner and browser dependency loaded`);
} catch (error) {
	console.error("CLI PACKAGE RED: the packed CLI cannot load with its published dependencies");
	console.error(error.stderr?.toString() || error.message);
	process.exitCode = 1;
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
