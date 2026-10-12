#!/usr/bin/env node
/**
 * `wrangler deploy` for one Worker, retried on Cloudflare's transient API failures only (#1046).
 * The policy and the status words are `lib/deploy-worker.mjs`.
 *
 *   node scripts/deploy-worker.mjs --cwd workers/api -- --var API_BUILD:abc123
 *
 * Runs `pnpm exec wrangler deploy <args>` in `--cwd`, streaming wrangler's output as it goes.
 * Writes `status` and `attempts` to $GITHUB_OUTPUT, one line to $GITHUB_STEP_SUMMARY, and an
 * annotation; exits 0 only for `deployed` / `deployed_after_retry`.
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deployWithRetry, describe, exitCodeFor } from "./lib/deploy-worker.mjs";

function parseArgs(argv) {
	const split = argv.indexOf("--");
	const own = split === -1 ? argv : argv.slice(0, split);
	const wranglerArgs = split === -1 ? [] : argv.slice(split + 1);
	const cwd = own[own.indexOf("--cwd") + 1];
	if (!own.includes("--cwd") || !cwd) throw new Error("usage: deploy-worker.mjs --cwd <worker dir> [-- <wrangler deploy args>]");
	return { cwd: resolve(cwd), wranglerArgs };
}

/** One `wrangler deploy`, teed: the log keeps wrangler's own output, the retry policy reads it. */
function runWrangler(cwd, args) {
	return new Promise((done) => {
		const child = spawn("pnpm", ["exec", "wrangler", "deploy", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (d) => {
			process.stdout.write(d);
			output += d;
		});
		child.stderr.on("data", (d) => {
			process.stderr.write(d);
			output += d;
		});
		child.on("error", (err) => done({ code: 1, output: `${output}\n${err.message}` }));
		child.on("close", (code) => done({ code: code ?? 1, output }));
	});
}

async function main() {
	const { cwd, wranglerArgs } = parseArgs(process.argv.slice(2));
	const worker = /^name\s*=\s*"([^"]+)"/m.exec(readFileSync(join(cwd, "wrangler.toml"), "utf8"))?.[1] ?? cwd;
	const result = await deployWithRetry({
		attempt: (n) => {
			console.log(`\n── ${worker}: wrangler deploy, attempt ${n} ──`);
			return runWrangler(cwd, wranglerArgs);
		},
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		log: (line) => console.log(line),
	});
	const { line, annotation } = describe(worker, result);
	console.log(`\nDeploy status: ${result.status} — ${line}`);
	if (annotation) console.log(annotation);
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status}\nattempts=${result.attempts.length}\n`);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Deploy status: \`${result.status}\`** — ${line}\n\n`);
	process.exitCode = exitCodeFor(result.status);
}

main().catch((error) => {
	console.error(`::error title=deploy-worker::${error.message}`);
	process.exitCode = 1;
});
