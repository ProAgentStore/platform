#!/usr/bin/env node
// Release smoke test (#1152): the candidate CLI must start and heartbeat, and the previous release must be able to
// self-update to it and come back — BEFORE it is published. Run by the "Publish to npm" workflow on Linux and Windows.
//
//   node scripts/release-smoke/run.mjs [--timeout-s 240] [--keep]
//
// Nothing here touches the real platform or the real npm account. The candidate is `npm pack`ed from packages/cli (build it
// first) and installed with `npm install`, exactly as a user's machine gets it. One local server then plays both the
// platform API (the sign-in, the agent list, runtime registration and heartbeats) and an npm registry (the candidate as
// `latest`, the previous release and every dependency passed through from the real registry). The compiled-in API address
// of a RELEASED version is redirected to it by a preloaded hook (redirect.mjs), so the previous release runs unmodified.
//
//   1. START:  the candidate, via the bootstrap stub, runs `pags up --headless`: it must register a runtime and heartbeat.
//   2. UPDATE: the previous release does the same with auto-update ON; its own updater must find the candidate, install
//              it, leave, and the candidate must come back — registered and heartbeating.
//
// Exit 0 = both passed; 1 = one failed (the reason and the tail of the runner's update log are printed).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cliPackument, missingForVersion, previousRelease } from "./lib.mjs";
import { attachProbeRelay } from "./relay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..", "..", "packages", "cli");
const UPSTREAM = "https://registry.npmjs.org";
const PKG = "@proagentstore/cli";
const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const STAGE_TIMEOUT_MS = Number(flag("--timeout-s", "240")) * 1000;
const KEEP = argv.includes("--keep");
const win = process.platform === "win32";

const say = (line) => console.log(`[release-smoke] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function npm(args, { cwd, env, timeout = 180_000 } = {}) {
	const r = spawnSync("npm", args, { cwd, env, encoding: "utf8", timeout, shell: win });
	if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed (${r.status ?? r.signal}): ${(r.stderr || r.stdout || r.error?.message || "").trim().split("\n").slice(-6).join("\n")}`);
	return r.stdout;
}

/** npm while the fake registry is running IN THIS PROCESS: a blocking spawn would starve the server it is waiting on. */
function npmAsync(args, { cwd, env, timeout = 180_000 } = {}) {
	return new Promise((ok, fail) => {
		const child = spawn("npm", args, { cwd, env, shell: win, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => { out = (out + d).slice(-6000); });
		child.stderr.on("data", (d) => { out = (out + d).slice(-6000); });
		const timer = setTimeout(() => { killTree(child); fail(new Error(`npm ${args.join(" ")} timed out after ${timeout / 1000}s\n${out.split("\n").slice(-6).join("\n")}`)); }, timeout);
		child.on("error", (e) => { clearTimeout(timer); fail(e); });
		child.on("close", (code) => { clearTimeout(timer); code === 0 ? ok(out) : fail(new Error(`npm ${args.join(" ")} failed (${code})\n${out.split("\n").slice(-8).join("\n")}`)); });
	});
}

// ── the fake platform + registry ──────────────────────────────────────────────────────────────────────────────────
async function startServer({ candidateTarball, candidateManifest, previousManifest }) {
	const requests = [];
	const state = { autoUpdate: false };
	let base = "";
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://x");
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const raw = Buffer.concat(chunks).toString("utf8");
		let body;
		try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
		const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };

		if (url.pathname.startsWith("/v1/")) {
			requests.push({ seq: requests.length, method: req.method, path: url.pathname, body });
			if (url.pathname === "/v1/instances/my/instances") return json({ instances: [{ id: "smoke-i1", agentId: "smoke-a1", name: "smoke", status: "active", agentSlug: "coder", capabilities: { surfaces: ["coding"], runtime: "coding" } }] });
			if (/^\/v1\/relay\/[^/]+\/token$/.test(url.pathname)) return json({ token: "smoke", expiresAt: new Date(Date.now() + 600_000).toISOString() });
			// Registration and heartbeat both answer with the owner's auto-update switch, as the platform does.
			if (/\/runtime(\/heartbeat)?$/.test(url.pathname)) return json({ ok: true, autoUpdatePolicy: state.autoUpdate });
			return json({});
		}
		// ── npm registry ──
		const packument = url.pathname === "/@proagentstore%2fcli" || url.pathname === "/@proagentstore/cli";
		if (packument) return json(cliPackument({ name: PKG, candidate: candidateManifest, tarball: candidateTarball, tarballUrl: `${base}/-/candidate.tgz`, previous: previousManifest }));
		if (url.pathname === "/-/candidate.tgz") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(candidateTarball); }
		// Everything else (dependencies' packuments and tarballs, the previous release's tarball) is the real registry's.
		try {
			const up = await fetch(UPSTREAM + url.pathname + url.search, { headers: { accept: req.headers.accept ?? "*/*" } });
			res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/octet-stream" });
			res.end(Buffer.from(await up.arrayBuffer()));
		} catch (e) {
			res.writeHead(502); res.end(String(e));
		}
	});
	// The candidate must pass its real start probe before the previous runner swaps to it (#1369).
	const relay = attachProbeRelay(server, { instanceId: "smoke-i1", token: "smoke" });
	await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
	base = `http://127.0.0.1:${server.address().port}`;
	return { base, requests, state, close: () => new Promise((ok) => { relay.close(); server.closeAllConnections?.(); server.close(ok); }) };
}

// ── processes ─────────────────────────────────────────────────────────────────────────────────────────────────────
function killTree(child) {
	if (!child.pid || child.exitCode !== null) return;
	try {
		if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		else process.kill(-child.pid, "SIGKILL");
	} catch { /* already gone */ }
}

async function main() {
	const scratch = mkdtempSync(join(tmpdir(), "pags-smoke-"));
	const children = [];
	let server;
	let failed = null;
	const cleanup = async () => {
		for (const c of children) killTree(c);
		await server?.close();
		if (!KEEP) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
		else say(`kept ${scratch}`);
	};
	try {
		if (!existsSync(join(cliRoot, "dist", "bootstrap.js"))) throw new Error("packages/cli/dist is missing — build the CLI first (pnpm --filter @proagentstore/cli build)");
		const candidateManifest = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
		const version = candidateManifest.version;
		say(`candidate ${PKG}@${version}`);

		const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: cliRoot }));
		const candidateTarball = readFileSync(join(scratch, packed[0].filename));

		// The previous release, as the real registry describes it (asked BEFORE any registry override).
		const published = JSON.parse(npm(["view", PKG, "versions", "--json"]));
		const previous = previousRelease(Array.isArray(published) ? published : [published], version);
		const previousManifest = previous ? JSON.parse(npm(["view", `${PKG}@${previous}`, "--json"])) : null;
		say(previous ? `previous release ${previous}` : "no earlier release is published: the self-update stage is skipped");

		server = await startServer({ candidateTarball, candidateManifest, previousManifest });
		const redirect = pathToFileURL(join(here, "redirect.mjs")).href;

		const stage = async (name, installVersion, { autoUpdate }) => {
			const home = join(scratch, `home-${name}`);
			const prefix = join(scratch, `prefix-${name}`);
			mkdirSync(join(home, ".config", "proagentstore"), { recursive: true });
			writeFileSync(join(home, ".config", "proagentstore", "session.json"), JSON.stringify({ token: "smoke-token", user: { id: "smoke", login: "smoke", avatar: "" }, expiresAt: Date.now() + 86_400_000 }));
			const env = {
				...process.env,
				HOME: home, USERPROFILE: home,
				npm_config_registry: server.base, NPM_CONFIG_REGISTRY: server.base,
				NODE_OPTIONS: `--import ${redirect}`, SMOKE_API: server.base,
				PAGS_NO_WATCHDOG: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
			};
			delete env.NODE_PATH; delete env.PAGS_BOOTSTRAP; delete env.PAGS_SERVICE;
			say(`${name}: installing ${PKG}@${installVersion}`);
			await npmAsync(["install", "--prefix", prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", `${PKG}@${installVersion}`], { cwd: scratch, env, timeout: 300_000 });
			const entry = join(prefix, "node_modules", ...PKG.split("/"), "dist", "bootstrap.js");
			if (name === "start") {
				const actions = spawnSync(process.execPath, [entry, "actions", "supervise", "--help"], { env, cwd: home, encoding: "utf8", timeout: 30_000 });
				if (actions.status !== 0 || !/supervise/.test(actions.stdout ?? "")) throw new Error(`A packed Actions supervisor did not start (${actions.status ?? actions.signal}): ${(actions.stderr || actions.stdout || "").slice(-600)}`);
				say("Actions supervisor command loads from the packed CLI");
			}
			server.requests.length = 0;
			server.state.autoUpdate = autoUpdate;
			let out = "";
			const child = spawn(process.execPath, [entry, "up", "--headless"], { env, cwd: home, detached: !win, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			children.push(child);
			child.stdout.on("data", (d) => { out = (out + d).slice(-6000); });
			child.stderr.on("data", (d) => { out = (out + d).slice(-6000); });
			return { home, child, out: () => out };
		};
		const waitUntil = async (what, check, run) => {
			const deadline = Date.now() + STAGE_TIMEOUT_MS;
			let last = "";
			while (Date.now() < deadline) {
				last = check();
				if (!last) return;
				await sleep(1000);
			}
			const log = join(run.home, ".config", "proagentstore", "update.log");
			const tail = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").slice(-25).join("\n") : "(no update.log)";
			throw new Error(`${what}: ${last}\n--- update.log (tail) ---\n${tail}\n--- runner output (tail) ---\n${run.out().slice(-1800)}`);
		};

		// 1. START
		const started = await stage("start", version, { autoUpdate: false });
		await waitUntil(`START: the candidate ${version} did not start and heartbeat`, () => missingForVersion(server.requests, version), started);
		say(`START ok: ${version} registered and heartbeated`);
		killTree(started.child);
		await sleep(1500);

		// 2. UPDATE
		if (previous) {
			const updating = await stage("update", previous, { autoUpdate: true });
			await waitUntil(`UPDATE: the previous release ${previous} did not start and heartbeat`, () => missingForVersion(server.requests, previous), updating);
			say(`UPDATE: ${previous} is running; waiting for its updater to move it to ${version}`);
			await waitUntil(`UPDATE: ${previous} did not update itself to ${version} and come back`, () => missingForVersion(server.requests, version), updating);
			say(`UPDATE ok: ${previous} → ${version}, back and heartbeating`);
		}
		say("PASSED");
	} catch (e) {
		failed = e;
		console.error(`[release-smoke] FAILED — ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		await cleanup();
	}
	process.exit(failed ? 1 : 0);
}

await main();
