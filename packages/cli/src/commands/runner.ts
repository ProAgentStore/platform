import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { arch, homedir, platform } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { loadSession } from "./login.js";

/** First free TCP port at/after `start` on 127.0.0.1 — avoids EADDRINUSE collisions. */
async function findFreePort(start: number): Promise<number> {
	for (let p = start; p < start + 25; p++) {
		const free = await new Promise<boolean>((res) => {
			const s = createServer();
			s.once("error", () => res(false));
			s.once("listening", () => s.close(() => res(true)));
			s.listen(p, "127.0.0.1");
		});
		if (free) return p;
	}
	return start;
}
import { Command } from "commander";
import { writeError, writeLine } from "../output.js";

interface RunnerStartOptions {
	host?: string;
	port?: string;
	dataDir?: string;
	token?: string;
	instanceId?: string;
	headless?: boolean;
}

interface RunnerRequestOptions {
	url?: string;
	token?: string;
	instanceId?: string;
}

interface PagsRequestOptions {
	apiBase?: string;
	pagsToken?: string;
}

interface RuntimeRegisterOptions extends PagsRequestOptions, RunnerRequestOptions {
	endpointUrl: string;
	runnerToken?: string;
	placement?: string;
	runnerVersion?: string;
	capability?: string[];
	probe?: boolean;
}

interface RunnerConnectOptions extends RunnerStartOptions, PagsRequestOptions {
	cloudflared?: string;
	runnerVersion?: string;
	skipProbe?: boolean;
}

export const runnerCommand = createRunnerCommand();

export function runnerBaseUrl(url?: string): string {
	return (clean(url) || clean(process.env.PAGS_RUNNER_URL) || "http://127.0.0.1:49171").replace(/\/$/, "");
}

export function pagsApiBase(url?: string): string {
	return (clean(url) || clean(process.env.PAGS_API_BASE) || "https://api.proagentstore.online").replace(/\/$/, "");
}

export function pagsHeaders(token?: string): Record<string, string> {
	// Fall back to the saved login (pags login) so `runner connect` works without
	// PAGS_TOKEN — same token `pags up` uses.
	const resolved = clean(token) || clean(process.env.PAGS_TOKEN) || clean(loadSession()?.token);
	return resolved ? { Authorization: `Bearer ${resolved}` } : {};
}

export function runnerHeaders(token?: string): Record<string, string> {
	const resolved = clean(token) || clean(process.env.PAGS_RUNNER_TOKEN);
	return resolved ? { Authorization: `Bearer ${resolved}` } : {};
}

export function runnerRequestHeaders(opts: RunnerRequestOptions): Record<string, string> {
	const resolved = clean(opts.token) || clean(process.env.PAGS_RUNNER_TOKEN);
	const headers: Record<string, string> = resolved ? { Authorization: `Bearer ${resolved}` } : {};
	const instanceId = clean(opts.instanceId) || clean(process.env.PAGS_INSTANCE_ID);
	if (instanceId) headers["X-PAGS-Instance-Id"] = instanceId;
	return headers;
}

export function apiPathSegment(value: string): string {
	return encodeURIComponent(value);
}

export function buildRunnerArgs(opts: RunnerStartOptions): string[] {
	const args: string[] = [];
	if (clean(opts.host)) args.push("--host", clean(opts.host) as string);
	if (clean(opts.port)) args.push("--port", clean(opts.port) as string);
	if (clean(opts.dataDir)) args.push("--data-dir", clean(opts.dataDir) as string);
	if (clean(opts.token)) args.push("--token", clean(opts.token) as string);
	if (clean(opts.instanceId)) args.push("--instance-id", clean(opts.instanceId) as string);
	if (opts.headless) args.push("--headless");
	return args;
}

export function buildCloudflaredArgs(localUrl: string): string[] {
	return ["tunnel", "--url", localUrl];
}

interface CloudflaredAsset {
	asset: string;
	executableName: string;
	archive: boolean;
}

export function cloudflaredAssetForPlatform(
	os = platform(),
	cpu = arch(),
): CloudflaredAsset {
	if (os === "darwin") {
		if (cpu === "arm64") {
			return {
				asset: "cloudflared-darwin-arm64.tgz",
				executableName: "cloudflared",
				archive: true,
			};
		}
		if (cpu === "x64") {
			return {
				asset: "cloudflared-darwin-amd64.tgz",
				executableName: "cloudflared",
				archive: true,
			};
		}
	}
	if (os === "linux") {
		if (cpu === "x64") {
			return {
				asset: "cloudflared-linux-amd64",
				executableName: "cloudflared",
				archive: false,
			};
		}
		if (cpu === "arm64") {
			return {
				asset: "cloudflared-linux-arm64",
				executableName: "cloudflared",
				archive: false,
			};
		}
	}
	if (os === "win32" && cpu === "x64") {
		return {
			asset: "cloudflared-windows-amd64.exe",
			executableName: "cloudflared.exe",
			archive: false,
		};
	}
	throw new Error(
		`Automatic cloudflared download is not supported on ${os}/${cpu}. Install cloudflared and pass --cloudflared <path>.`,
	);
}

export function cloudflaredDownloadUrl(asset: string): string {
	return `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
}

export function extractCloudflaredBinary(asset: CloudflaredAsset, bytes: Uint8Array): Buffer {
	const buffer = Buffer.from(bytes);
	if (!asset.archive) return buffer;
	const tar = gunzipSync(buffer);
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const rawName = header.subarray(0, 100).toString("utf8");
		const name = rawName.slice(0, rawName.indexOf("\0") === -1 ? undefined : rawName.indexOf("\0"));
		const rawSize = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
		const size = Number.parseInt(rawSize || "0", 8);
		const contentStart = offset + 512;
		const contentEnd = contentStart + size;
		if (name.split("/").pop() === asset.executableName) {
			return tar.subarray(contentStart, contentEnd);
		}
		offset = contentStart + Math.ceil(size / 512) * 512;
	}
	throw new Error(`Downloaded ${asset.asset} did not contain ${asset.executableName}`);
}

function cloudflaredCacheDir(): string {
	return resolve(homedir(), ".config", "proagentstore", "bin");
}

function cachedCloudflaredPath(asset: CloudflaredAsset): string {
	const suffix = asset.asset.replace(/[^a-zA-Z0-9._-]/g, "-");
	return resolve(cloudflaredCacheDir(), `${asset.executableName}-${suffix}`);
}

async function commandAvailable(command: string): Promise<boolean> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, ["--version"], {
			stdio: "ignore",
			shell: process.platform === "win32",
		});
		child.on("error", () => resolvePromise(false));
		child.on("exit", (code) => resolvePromise(code === 0));
	});
}

async function downloadCloudflared(asset: CloudflaredAsset): Promise<string> {
	const target = cachedCloudflaredPath(asset);
	if (existsSync(target)) return target;
	await mkdir(cloudflaredCacheDir(), { recursive: true });
	const url = cloudflaredDownloadUrl(asset.asset);
	writeLine(`cloudflared not found; downloading ${asset.asset}...`);
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`cloudflared download failed: ${res.status} ${res.statusText}`);
	}
	const binary = extractCloudflaredBinary(asset, new Uint8Array(await res.arrayBuffer()));
	await writeFile(target, binary);
	if (process.platform !== "win32") await chmod(target, 0o755);
	writeLine(`cloudflared cached at ${target}`);
	return target;
}

async function resolveCloudflaredCommand(requested?: string): Promise<string> {
	const explicit = clean(requested);
	if (explicit && explicit !== "cloudflared") return explicit;
	if (await commandAvailable("cloudflared")) return "cloudflared";
	return downloadCloudflared(cloudflaredAssetForPlatform());
}

export function parseCloudflaredTunnelUrl(text: string): string | null {
	// Return the tunnel subdomain, skipping cloudflared's own API host
	// (api.trycloudflare.com) which appears in its connection logs — registering
	// that bogus URL is what made PAGS show the runner offline after a reconnect.
	const matches = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi) || [];
	for (const m of matches) {
		if (!/^https:\/\/api\.trycloudflare\.com/i.test(m)) return m;
	}
	return null;
}

export function buildRuntimeRegistrationBody(opts: RuntimeRegisterOptions, capabilities: string[] = []) {
	return {
		endpointUrl: clean(opts.endpointUrl) || opts.endpointUrl,
		token: clean(opts.runnerToken) || clean(opts.token) || clean(process.env.PAGS_RUNNER_TOKEN),
		placement: opts.placement === "managed" ? "managed" : "local",
		capabilities,
		runnerVersion: clean(opts.runnerVersion) || "",
	};
}

function clean(value?: string): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function findWorkspaceRoot(): string {
	let dir = process.cwd();
	for (let i = 0; i < 8; i++) {
		if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return process.cwd();
}

export function bundledRunnerPath(): string {
	return fileURLToPath(new URL("./browser-runner/index.js", import.meta.url));
}

function runnerSpawnSpec(opts: RunnerStartOptions): { command: string; args: string[]; cwd: string } {
	const root = findWorkspaceRoot();
	const localPackage = resolve(root, "packages", "browser-runner", "src", "index.ts");
	const bundledPackage = bundledRunnerPath();
	const runnerArgs = buildRunnerArgs(opts);
	let cwd = root;
	let command = "pags-browser-runner";
	let args = runnerArgs;

	if (existsSync(localPackage)) {
		command = "pnpm";
		args = ["--filter", "@proagentstore/browser-runner", "dev", "--", ...runnerArgs];
	} else if (existsSync(bundledPackage)) {
		cwd = process.cwd();
		command = process.execPath;
		args = [bundledPackage, ...runnerArgs];
	}
	return { command, args, cwd };
}

function startRunnerForeground(opts: RunnerStartOptions): Promise<void> {
	const spec = runnerSpawnSpec(opts);

	return new Promise((resolvePromise, reject) => {
		const child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code && code !== 0) reject(new Error(`runner exited with code ${code}`));
			else resolvePromise();
		});
	});
}

async function waitForLocalRunner(opts: RunnerRequestOptions, timeoutMs = 15_000): Promise<void> {
	const started = Date.now();
	let lastError: unknown;
	while (Date.now() - started < timeoutMs) {
		try {
			await requestRunner("GET", "/health", opts);
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
		}
	}
	throw new Error(`runner did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function requestRunner<T>(
	method: string,
	path: string,
	opts: RunnerRequestOptions,
	body?: unknown,
): Promise<T> {
	const headers: Record<string, string> = {
		...runnerRequestHeaders(opts),
	};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(`${runnerBaseUrl(opts.url)}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const { text, data } = await readResponse(res);
	if (!res.ok) {
		const message = responseErrorMessage(data, text, res.statusText);
		throw new Error(`${res.status} ${message}`);
	}
	return data as T;
}

export async function requestPags<T>(
	method: string,
	path: string,
	opts: PagsRequestOptions,
	body?: unknown,
): Promise<T> {
	const headers: Record<string, string> = {
		...pagsHeaders(opts.pagsToken),
	};
	if (!headers.Authorization) {
		throw new Error("PAGS token required. Set PAGS_TOKEN or pass --pags-token.");
	}
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(`${pagsApiBase(opts.apiBase)}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const { text, data } = await readResponse(res);
	if (!res.ok) {
		const message = responseErrorMessage(data, text, res.statusText);
		throw new Error(`${res.status} ${message}`);
	}
	return data as T;
}

async function readResponse(res: Response): Promise<{ text: string; data: Record<string, unknown> }> {
	const text = await res.text();
	if (!text) return { text, data: {} };
	try {
		return { text, data: JSON.parse(text) as Record<string, unknown> };
	} catch {
		return { text, data: {} };
	}
}

function responseErrorMessage(
	data: Record<string, unknown>,
	text: string,
	statusText: string,
): string {
	return typeof data.error === "string" ? data.error : text || statusText;
}

function collectCapability(value: string, previous: string[] = []): string[] {
	return [...previous, value];
}

export function createRunnerCommand(): Command {
	const command = new Command("runner").description(
		"Manage the local FAGS browser runtime for ProAgentStore agents",
	);

	command
		.command("start")
		.description("Start the local FAGS browser runtime in the foreground")
	.option("--host <host>", "Host to bind", "127.0.0.1")
	.option("--port <port>", "Port to bind", "49171")
	.option("--data-dir <path>", "Runner data directory")
	.option("--token <token>", "Require this bearer token")
	.option("--instance-id <id>", "Bind runner requests to a PAGS instance id")
	.option("--headless", "Run Playwright headless")
	.action(async (opts: RunnerStartOptions) => {
		await startRunnerForeground(opts);
	});

	command
		.command("connect <instanceIds...>")
		.description("Start ONE local runtime, open a Cloudflare quick tunnel, and register it for every given PAGS instance")
		.option("--host <host>", "Host to bind", "127.0.0.1")
		.option("--port <port>", "Port to bind", "49171")
		.option("--data-dir <path>", "Runner data directory")
		.option("--token <token>", "Runner bearer token. Defaults to PAGS_RUNNER_TOKEN or a generated token")
		.option("--headless", "Run Playwright headless")
		.option("--api-base <url>", "PAGS API base URL")
		.option("--pags-token <token>", "PAGS session token. Defaults to PAGS_TOKEN")
		.option("--cloudflared <path>", "cloudflared executable")
		.option("--runner-version <version>", "Runner version")
		.option("--skip-probe", "Skip PAGS FAGS-runtime probe after registration")
		.action(async (instanceIds: string[], opts: RunnerConnectOptions) => {
			const runnerToken = clean(opts.token) || clean(process.env.PAGS_RUNNER_TOKEN) || `pags_runner_${randomUUID()}`;
			const host = clean(opts.host) || "127.0.0.1";
			// Pick a free port so a stale/orphaned runner on 49171 can't cause an
			// EADDRINUSE or a 401 (stale token) on the next `pags up`.
			const port = clean(opts.port) || String(await findFreePort(49171));
			const localUrl = `http://${host}:${port}`;
			// One runner serves ALL the given instances (one machine = one runner =
			// one tunnel). It is NOT bound to a single instance id — auth is by the
			// shared runner token, and the server accepts any instance the brain
			// calls with. `primary` is just for health-probe headers + display.
			const primary = instanceIds[0];
			const runnerOpts: RunnerStartOptions = {
				...opts,
				host,
				port,
				token: runnerToken,
			};
			const spec = runnerSpawnSpec(runnerOpts);
			const runner = spawn(spec.command, spec.args, {
				cwd: spec.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				shell: process.platform === "win32",
			});
			runner.stdout?.on("data", (data) => process.stdout.write(data));
			runner.stderr?.on("data", (data) => process.stderr.write(data));
			runner.on("exit", (code) => {
				if (code && code !== 0) writeError(`runner exited with code ${code}`);
			});

			let tunnel: ReturnType<typeof spawn> | null = null;
			const shutdown = () => {
				if (tunnel && !tunnel.killed) tunnel.kill("SIGTERM");
				if (!runner.killed) runner.kill("SIGTERM");
			};
			process.once("SIGINT", () => {
				shutdown();
				process.exit(0);
			});
			process.once("SIGTERM", () => {
				shutdown();
				process.exit(0);
			});

			try {
				await waitForLocalRunner({ url: localUrl, token: runnerToken, instanceId: primary });
				writeLine(`Local FAGS runtime healthy at ${localUrl}`);

				const cloudflaredPath = await resolveCloudflaredCommand(opts.cloudflared);

				// Spawn a cloudflared quick tunnel; resolve once its public URL appears.
				const openTunnel = (): Promise<{ url: string; proc: ReturnType<typeof spawn> }> =>
					new Promise((resolveTunnel, reject) => {
						let output = "";
						const proc = spawn(cloudflaredPath, buildCloudflaredArgs(localUrl), {
							stdio: ["ignore", "pipe", "pipe"],
							shell: process.platform === "win32",
						});
						const onData = (data: Buffer) => {
							output += data.toString("utf-8");
							const parsed = parseCloudflaredTunnelUrl(output);
							if (parsed) resolveTunnel({ url: parsed, proc });
						};
						proc.stdout?.on("data", onData);
						proc.stderr?.on("data", onData);
						proc.on("error", reject);
						setTimeout(() => reject(new Error("timed out waiting for cloudflared tunnel URL")), 45_000).unref();
					});

				// (Re-)register the current tunnel URL with PAGS for EVERY instance —
				// they all point at this one runner + tunnel.
				const registerRuntime = async (url: string): Promise<void> => {
					const capabilities = await requestRunner<{ capabilities?: unknown }>("GET", "/capabilities", { url: localUrl, token: runnerToken, instanceId: primary });
					const caps = Array.isArray(capabilities.capabilities) ? capabilities.capabilities.filter((item): item is string => typeof item === "string") : [];
					// Register each instance independently — one failing instance must
					// not stop the others from registering (the heartbeat loop retries
					// any that didn't stick).
					for (const id of instanceIds) {
						try {
							await requestPags("POST", `/v1/instances/${apiPathSegment(id)}/runtime`, opts, {
								endpointUrl: url,
								token: runnerToken,
								placement: "local",
								capabilities: caps,
								runnerVersion: clean(opts.runnerVersion) || "",
							});
						} catch (error) {
							writeError(`register ${id.slice(0, 8)}… failed (${error instanceof Error ? error.message : String(error)}); will retry`);
						}
					}
				};

				const first = await openTunnel();
				tunnel = first.proc;
				let tunnelUrl = first.url;
				// Don't crash if the first registration fails (e.g. WiFi still flaky at
				// startup) — the heartbeat loop below re-registers until it sticks.
				await registerRuntime(tunnelUrl).catch((error) => {
					writeError(`registration will retry (${error instanceof Error ? error.message : String(error)})`);
				});
				writeLine("Runtime registered with PAGS ✓");
				writeLine("");
				writeLine("═══════════════════════════════════════════════");
				writeLine("  ✅ CONNECTED — runner is live");
				writeLine(`  Agents:   ${instanceIds.length} instance${instanceIds.length === 1 ? "" : "s"} served by this runner`);
				writeLine(`  Tunnel:   ${tunnelUrl}`);
				writeLine("  Auto-reconnect is on — keep this terminal open. Ctrl+C to disconnect.");
				writeLine("═══════════════════════════════════════════════");

				// Watchdog: cloudflared quick tunnels drop SILENTLY (process stays up,
				// public URL stops routing → PAGS probe fails → offline). Probe the
				// public URL ourselves; respawn + re-register when it dies, heartbeat
				// otherwise. This is what keeps the runner reliably online.
				//
				// Rate-limit guard: require 3 consecutive probe failures before
				// respawning (a single slow response shouldn't trigger a new tunnel).
				// Exponential backoff on respawn failures (30s → 60s → 120s → cap 5min)
				// so we don't hammer Cloudflare's quick-tunnel API into a 429.
				let stopped = false;
				let consecutiveFailures = 0;
				let respawnBackoffMs = 30_000;
				const PROBE_FAIL_THRESHOLD = 3;
				const MAX_BACKOFF_MS = 5 * 60_000;

				const probeTunnel = async (url: string): Promise<boolean> => {
					try {
						const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
							headers: { Authorization: `Bearer ${runnerToken}`, "X-PAGS-Instance-Id": primary },
							signal: AbortSignal.timeout(10_000),
						});
						return res.ok;
					} catch {
						return false;
					}
				};
				// Heartbeat every instance this runner serves; report whether all stuck.
				const heartbeatAll = async (): Promise<boolean> => {
					let allOk = true;
					for (const id of instanceIds) {
						const ok = await requestPags("POST", `/v1/instances/${apiPathSegment(id)}/runtime/heartbeat`, opts, {})
							.then(() => true)
							.catch(() => false);
						if (!ok) allOk = false;
					}
					return allOk;
				};
				void (async () => {
					while (!stopped) {
						await new Promise((r) => setTimeout(r, 30_000));
						if (stopped) break;
						if (await probeTunnel(tunnelUrl)) {
							consecutiveFailures = 0;
							respawnBackoffMs = 30_000; // reset backoff on success
							const beat = await heartbeatAll();
							if (!beat) {
								await registerRuntime(tunnelUrl).then(() => writeLine("✅ Re-registered with PAGS")).catch(() => undefined);
							}
							continue;
						}
						consecutiveFailures++;
						if (consecutiveFailures < PROBE_FAIL_THRESHOLD) {
							writeLine(`⚠ Tunnel probe failed (${consecutiveFailures}/${PROBE_FAIL_THRESHOLD}) — will retry`);
							continue;
						}
						writeLine("⚠ Tunnel unreachable — reconnecting…");
						consecutiveFailures = 0;
						try { if (tunnel && !tunnel.killed) tunnel.kill("SIGTERM"); } catch { /* ignore */ }
						try {
							const next = await openTunnel();
							tunnel = next.proc;
							tunnelUrl = next.url;
							await registerRuntime(tunnelUrl);
							respawnBackoffMs = 30_000; // reset on success
							writeLine(`✅ Reconnected: ${tunnelUrl}`);
						} catch (error) {
							writeError(`reconnect failed (${error instanceof Error ? error.message : String(error)}); retrying in ${Math.round(respawnBackoffMs / 1000)}s`);
							// Wait the backoff before the next loop iteration (on top of the 30s sleep).
							await new Promise((r) => setTimeout(r, respawnBackoffMs));
							respawnBackoffMs = Math.min(respawnBackoffMs * 2, MAX_BACKOFF_MS);
						}
					}
				})();

				// Stay alive until the runner process exits — the tunnel self-heals.
				await new Promise<void>((resolvePromise) => { runner.on("exit", () => resolvePromise()); });
				stopped = true;
			} catch (error) {
				shutdown();
				throw error;
			}
		});

	command
		.command("status")
	.description("Check local FAGS runtime health and capabilities")
	.option("--url <url>", "Runner URL")
	.option("--token <token>", "Runner bearer token")
	.option("--instance-id <id>", "PAGS instance id header")
	.action(async (opts: RunnerRequestOptions) => {
		const health = await requestRunner("GET", "/health", opts);
		const capabilities = await requestRunner("GET", "/capabilities", opts);
		writeLine(JSON.stringify({ health, capabilities }, null, 2));
	});

	command
	.command("task")
	.description("Create a local FAGS runtime task")
	.requiredOption("--type <type>", "Task type, e.g. echo or browser.open")
	.option("--url <url>", "Runner URL")
	.option("--token <token>", "Runner bearer token")
	.option("--instance-id <id>", "PAGS instance id header")
	.option("--input <json>", "Task input JSON")
	.option("--job-url <url>", "Shortcut input for browser.open")
	.option("--approve", "Create task in needs_approval state")
	.option("--approval-prompt <text>", "Approval prompt")
	.action(
		async (
			opts: RunnerRequestOptions & {
				type: string;
				input?: string;
				jobUrl?: string;
				approve?: boolean;
				approvalPrompt?: string;
			},
		) => {
			let input: Record<string, unknown> = {};
			if (opts.input) {
				try {
					input = JSON.parse(opts.input) as Record<string, unknown>;
				} catch {
					writeError("--input must be valid JSON");
					process.exit(1);
				}
			}
			if (opts.jobUrl) input.url = opts.jobUrl;
			const task = await requestRunner("POST", "/tasks", opts, {
				type: opts.type,
				input,
				requiresApproval: Boolean(opts.approve),
				approvalPrompt: opts.approvalPrompt,
			});
			writeLine(JSON.stringify(task, null, 2));
		},
	);

	command
	.command("register <instanceId>")
	.description("Register a local or managed FAGS runtime endpoint with a PAGS instance")
	.requiredOption("--endpoint-url <url>", "FAGS runtime endpoint URL to store in PAGS")
	.option("--api-base <url>", "PAGS API base URL")
	.option("--pags-token <token>", "PAGS session token. Defaults to PAGS_TOKEN")
	.option("--runner-token <token>", "FAGS runtime bearer token to store in PAGS")
	.option("--url <url>", "Local FAGS runtime URL to probe for capabilities")
	.option("--token <token>", "Local FAGS runtime bearer token for capability probe")
	.option("--instance-id <id>", "PAGS instance id header for capability probe")
	.option("--placement <placement>", "Runtime placement: local or managed", "local")
	.option("--runner-version <version>", "Runner version")
	.option("--capability <name>", "Runtime capability; repeatable", collectCapability, [])
	.option("--probe", "Read capabilities from the FAGS runtime before registering")
	.action(async (instanceId: string, opts: RuntimeRegisterOptions) => {
		let capabilities = opts.capability || [];
		if (opts.probe) {
			const data = await requestRunner<{ capabilities?: unknown }>("GET", "/capabilities", {
				url: opts.url || opts.endpointUrl,
				token: opts.token || opts.runnerToken,
				instanceId: opts.instanceId || instanceId,
			});
			capabilities = Array.isArray(data.capabilities)
				? data.capabilities.filter((item): item is string => typeof item === "string")
				: capabilities;
		}
		const body = buildRuntimeRegistrationBody(opts, capabilities);
		const result = await requestPags("POST", `/v1/instances/${apiPathSegment(instanceId)}/runtime`, opts, body);
		writeLine(JSON.stringify(result, null, 2));
	});

	command
	.command("runtime <instanceId>")
	.description("Read the PAGS runtime registration for an instance")
	.option("--api-base <url>", "PAGS API base URL")
	.option("--pags-token <token>", "PAGS session token. Defaults to PAGS_TOKEN")
	.option("--probe", "Ask PAGS to probe /health and /capabilities on the FAGS runtime")
	.action(async (instanceId: string, opts: PagsRequestOptions & { probe?: boolean }) => {
		const path = opts.probe
			? `/v1/instances/${apiPathSegment(instanceId)}/runtime/status`
			: `/v1/instances/${apiPathSegment(instanceId)}/runtime`;
		const result = await requestPags("GET", path, opts);
		writeLine(JSON.stringify(result, null, 2));
	});

	command
	.command("unregister <instanceId>")
	.description("Remove the PAGS runtime registration for an instance")
	.option("--api-base <url>", "PAGS API base URL")
	.option("--pags-token <token>", "PAGS session token. Defaults to PAGS_TOKEN")
	.action(async (instanceId: string, opts: PagsRequestOptions) => {
		const result = await requestPags("DELETE", `/v1/instances/${apiPathSegment(instanceId)}/runtime`, opts);
		writeLine(JSON.stringify(result, null, 2));
	});

	command
	.command("run <instanceId>")
	.description("Create a task through PAGS on an instance's registered FAGS runtime")
	.requiredOption("--type <type>", "Task type, e.g. echo or browser.open")
	.option("--api-base <url>", "PAGS API base URL")
	.option("--pags-token <token>", "PAGS session token. Defaults to PAGS_TOKEN")
	.option("--input <json>", "Task input JSON")
	.option("--job-url <url>", "Shortcut input for browser.open")
	.option("--approve", "Create task in needs_approval state")
	.option("--approval-prompt <text>", "Approval prompt")
	.action(
		async (
			instanceId: string,
			opts: PagsRequestOptions & {
				type: string;
				input?: string;
				jobUrl?: string;
				approve?: boolean;
				approvalPrompt?: string;
			},
		) => {
			let input: Record<string, unknown> = {};
			if (opts.input) {
				try {
					input = JSON.parse(opts.input) as Record<string, unknown>;
				} catch {
					writeError("--input must be valid JSON");
					process.exit(1);
				}
			}
			if (opts.jobUrl) input.url = opts.jobUrl;
			const result = await requestPags("POST", `/v1/instances/${apiPathSegment(instanceId)}/tasks`, opts, {
				type: opts.type,
				input,
				requiresApproval: Boolean(opts.approve),
				approvalPrompt: opts.approvalPrompt,
			});
			writeLine(JSON.stringify(result, null, 2));
		},
	);

	command
	.command("approve-task <instanceId> <taskId>")
	.description("Approve a registered FAGS runtime task through PAGS")
	.option("--api-base <url>", "PAGS API base URL")
	.option("--pags-token <token>", "PAGS session token. Defaults to PAGS_TOKEN")
	.action(async (instanceId: string, taskId: string, opts: PagsRequestOptions) => {
		const result = await requestPags(
			"POST",
			`/v1/instances/${apiPathSegment(instanceId)}/tasks/${apiPathSegment(taskId)}/approve`,
			opts,
		);
		writeLine(JSON.stringify(result, null, 2));
	});

	command
	.command("cancel-task <instanceId> <taskId>")
	.description("Cancel a registered FAGS runtime task through PAGS")
	.option("--api-base <url>", "PAGS API base URL")
	.option("--pags-token <token>", "PAGS session token. Defaults to PAGS_TOKEN")
	.action(async (instanceId: string, taskId: string, opts: PagsRequestOptions) => {
		const result = await requestPags(
			"POST",
			`/v1/instances/${apiPathSegment(instanceId)}/tasks/${apiPathSegment(taskId)}/cancel`,
			opts,
		);
		writeLine(JSON.stringify(result, null, 2));
	});

	command
	.command("task-events <instanceId>")
	.description("Read registered FAGS runtime task events through PAGS")
	.option("--api-base <url>", "PAGS API base URL")
	.option("--pags-token <token>", "PAGS session token. Defaults to PAGS_TOKEN")
	.option("--limit <n>", "Number of events", "50")
	.action(async (instanceId: string, opts: PagsRequestOptions & { limit: string }) => {
		const result = await requestPags(
			"GET",
			`/v1/instances/${apiPathSegment(instanceId)}/task-events?limit=${Number(opts.limit) || 50}`,
			opts,
		);
		writeLine(JSON.stringify(result, null, 2));
	});

	command
	.command("approve <taskId>")
	.description("Approve a task waiting on human approval")
	.option("--url <url>", "Runner URL")
	.option("--token <token>", "Runner bearer token")
	.option("--instance-id <id>", "PAGS instance id header")
	.action(async (taskId: string, opts: RunnerRequestOptions) => {
		const task = await requestRunner("POST", `/tasks/${apiPathSegment(taskId)}/approve`, opts);
		writeLine(JSON.stringify(task, null, 2));
	});

	command
	.command("cancel <taskId>")
	.description("Cancel a local FAGS runtime task")
	.option("--url <url>", "Runner URL")
	.option("--token <token>", "Runner bearer token")
	.option("--instance-id <id>", "PAGS instance id header")
	.action(async (taskId: string, opts: RunnerRequestOptions) => {
		const task = await requestRunner("POST", `/tasks/${apiPathSegment(taskId)}/cancel`, opts);
		writeLine(JSON.stringify(task, null, 2));
	});

	command
	.command("events")
	.description("List recent FAGS runtime events")
	.option("--url <url>", "Runner URL")
	.option("--token <token>", "Runner bearer token")
	.option("--instance-id <id>", "PAGS instance id header")
	.option("--limit <n>", "Number of events", "50")
	.action(async (opts: RunnerRequestOptions & { limit: string }) => {
		const events = await requestRunner("GET", `/events?limit=${Number(opts.limit) || 50}`, opts);
		writeLine(JSON.stringify(events, null, 2));
	});

	return command;
}
