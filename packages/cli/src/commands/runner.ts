import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadSession } from "./login.js";

const CLI_VERSION: string = (() => { try { return (createRequire(import.meta.url)("../package.json") as { version: string }).version; } catch { return ""; } })();

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
	runnerVersion?: string;
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


export function buildRuntimeRegistrationBody(opts: RuntimeRegisterOptions, capabilities: string[] = []) {
	return {
		endpointUrl: clean(opts.endpointUrl) || opts.endpointUrl,
		token: clean(opts.runnerToken) || clean(opts.token) || clean(process.env.PAGS_RUNNER_TOKEN),
		placement: opts.placement === "managed" ? "managed" : "local",
		capabilities,
		runnerVersion: clean(opts.runnerVersion) || "",
		runnerNode: hostname(),
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

/**
 * Connect to PAGS via WebSocket relay — no tunnel, no cloudflared.
 * Opens one WS per instance to the RelayDO and dispatches incoming commands
 * to the local runner HTTP server.
 */
async function connectViaRelay(
	instanceIds: string[],
	localUrl: string,
	runnerToken: string,
	opts: PagsRequestOptions,
	force = false,
): Promise<void> {
	const apiBase = pagsApiBase(opts.apiBase).replace(/^http/, "ws"); // https → wss
	const pagsToken = clean(opts.pagsToken) || clean(process.env.PAGS_TOKEN) || clean(loadSession()?.token);
	if (!pagsToken) throw new Error("PAGS token required for WebSocket relay");
	const runnerNode = hostname();

	// Register the runtime (needed for the status badge / getRunnerConn)
	const capabilities = await requestRunner<{ capabilities?: unknown }>("GET", "/capabilities", { url: localUrl, token: runnerToken, instanceId: instanceIds[0] });
	const caps = Array.isArray(capabilities.capabilities) ? capabilities.capabilities.filter((item): item is string => typeof item === "string") : [];
	for (const id of instanceIds) {
		try {
			await requestPags("POST", `/v1/instances/${apiPathSegment(id)}/runtime`, opts, {
				endpointUrl: localUrl,
				token: runnerToken,
				placement: "local",
				capabilities: caps,
				runnerVersion: CLI_VERSION,
				runnerNode,
				force,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			writeError(`register ${id.slice(0, 8)}… failed: ${msg}`);
		}
	}

	for (const id of instanceIds) {
		// Each connect mints a fresh instance-scoped relay token using the account
		// session token (resolved above; opts.pagsToken may be unset if it came from
		// the saved session).
		const mintToken = () =>
			requestPags<{ token: string }>("POST", `/v1/relay/${apiPathSegment(id)}/token`, { ...opts, pagsToken }, {}).then((r) => r.token);
		openRelaySocket(id, apiBase, mintToken, localUrl, runnerToken, force);
	}

	writeLine("Runtime registered with PAGS ✓");
	writeLine("");
	writeLine("═══════════════════════════════════════════════");
	writeLine(`  ✅ CONNECTED — WebSocket relay · ${hostname()}`);
	writeLine(`  Agents:   ${instanceIds.length} instance${instanceIds.length === 1 ? "" : "s"}`);
	writeLine("  No cloudflared needed. Ctrl+C to disconnect.");
	writeLine("═══════════════════════════════════════════════");

	// Heartbeat loop — keeps the runtime status "online" in D1.
	// Uses unref'd timers so the loop doesn't prevent process exit.
	const heartbeat = () => {
		const timer = setTimeout(async () => {
			for (const id of instanceIds) {
				await requestPags("POST", `/v1/instances/${apiPathSegment(id)}/runtime/heartbeat`, opts, { runnerNode }).catch(() => undefined);
			}
			heartbeat();
		}, 30_000);
		timer.unref(); // don't keep the process alive just for heartbeats
	};
	heartbeat();
}

function openRelaySocket(
	instanceId: string,
	wsBase: string,
	mintToken: () => Promise<string>,
	localUrl: string,
	runnerToken: string,
	force = false,
): void {
	let backoffMs = 1000;
	let reconnecting = false;

	const connect = async () => {
		// Mint a fresh short-lived, instance-scoped relay token per connect — the
		// long-lived account session token is never placed in the WS URL.
		let relayToken: string;
		try {
			relayToken = await mintToken();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// 402 = the runner is a Pro feature and this account isn't subscribed.
			// Retrying can never succeed — surface the upgrade message and stop
			// (otherwise a free user sits in an infinite mint-retry loop).
			if (/^402\b/.test(msg)) {
				writeLine(`Runner unavailable for ${instanceId.slice(0, 8)}…: ${msg.replace(/^402\s*/, "")}`);
				return;
			}
			const hint = /401|token|sign/i.test(msg) ? " (run `pags login`)" : "";
			writeLine(`Relay token mint failed: ${instanceId.slice(0, 8)}…${hint} — retrying in ${Math.round(backoffMs / 1000)}s`);
			setTimeout(() => { connect(); }, backoffMs);
			backoffMs = Math.min(backoffMs * 2, 30_000);
			return;
		}
		const params = new URLSearchParams({ token: relayToken, node: hostname() });
		if (force) params.set("force", "1");
		const url = `${wsBase}/v1/relay/${encodeURIComponent(instanceId)}/connect?${params.toString()}`;
		const ws = new WebSocket(url);

		ws.onopen = () => {
			backoffMs = 1000;
			writeLine(`Relay connected: ${instanceId.slice(0, 8)}…`);
		};

		ws.onmessage = async (event) => {
			const text = typeof event.data === "string" ? event.data : String(event.data);
			// Server pings to verify liveness — respond with pong
			if (text === "ping") { try { ws.send("pong"); } catch { /* closed */ } return; }
			let cmd: { id: string; method?: string; path: string; body?: unknown };
			try {
				cmd = JSON.parse(text) as { id: string; method?: string; path: string; body?: unknown };
			} catch {
				return;
			}
			if (!cmd.id || !cmd.path) return;

			// Dispatch to local runner HTTP server
			const method = (cmd.method || "POST").toUpperCase();
			const hasBody = method !== "GET" && method !== "HEAD" && cmd.body !== undefined;
			try {
				const headers: Record<string, string> = {};
				if (hasBody) headers["Content-Type"] = "application/json";
				if (runnerToken) headers.Authorization = `Bearer ${runnerToken}`;
				headers["X-PAGS-Instance-Id"] = instanceId;
				const res = await fetch(`${localUrl}${cmd.path}`, {
					method,
					headers,
					body: hasBody ? JSON.stringify(cmd.body) : undefined,
				});
				const text = await res.text().catch(() => "");
				let result: unknown;
				try { result = text ? JSON.parse(text) : {}; } catch { result = { raw: text.slice(0, 500) }; }
				try { ws.send(JSON.stringify({ id: cmd.id, status: res.status, result })); } catch { /* WS closed mid-flight */ }
			} catch (err) {
				try { ws.send(JSON.stringify({ id: cmd.id, status: 500, error: err instanceof Error ? err.message : String(err) })); } catch { /* WS closed */ }
			}
		};

		ws.onclose = (ev) => {
			if (reconnecting) return;
			reconnecting = true;
			// 401 on reconnect = token expired → tell the user clearly
			const reason = ev.code === 4401 || ev.code === 1008 ? ' (token expired — run `pags login` then `pags up`)' : '';
			writeLine(`Relay disconnected: ${instanceId.slice(0, 8)}…${reason} — reconnecting in ${Math.round(backoffMs / 1000)}s`);
			setTimeout(() => {
				reconnecting = false;
				connect();
			}, backoffMs);
			backoffMs = Math.min(backoffMs * 2, 30_000);
		};

		ws.onerror = () => {
			// onclose will fire after onerror -- reconnect handled there
		};
	};

	connect();
}

export function createRunnerCommand(): Command {
	const command = new Command("runner").description(
		"Manage the local ProAgentStore browser runtime for ProAgentStore agents",
	);

	command
		.command("start")
		.description("Start the local ProAgentStore browser runtime in the foreground")
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
		.description("Start ONE local runtime, connect via WebSocket relay, and register it for every given PAGS instance")
		.option("--host <host>", "Host to bind", "127.0.0.1")
		.option("--port <port>", "Port to bind", "49171")
		.option("--data-dir <path>", "Runner data directory")
		.option("--token <token>", "Runner bearer token. Defaults to PAGS_RUNNER_TOKEN or a generated token")
		.option("--headless", "Run Playwright headless")
		.option("--api-base <url>", "PAGS API base URL")
		.option("--pags-token <token>", "PAGS session token. Defaults to PAGS_TOKEN")
		.option("--runner-version <version>", "Runner version")
		.option("--force", "Take over from another connected machine")
		.action(async (instanceIds: string[], opts: RunnerConnectOptions & { force?: boolean }) => {
			const runnerToken = clean(opts.token) || clean(process.env.PAGS_RUNNER_TOKEN) || `pags_runner_${randomUUID()}`;
			const host = clean(opts.host) || "127.0.0.1";
			const port = clean(opts.port) || String(await findFreePort(49171));
			const localUrl = `http://${host}:${port}`;
			const primary = instanceIds[0];
			const runnerOpts: RunnerStartOptions = { ...opts, host, port, token: runnerToken };
			const spec = runnerSpawnSpec(runnerOpts);
			const runner = spawn(spec.command, spec.args, {
				cwd: spec.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				shell: process.platform === "win32",
			});
			runner.stdout?.on("data", (data) => process.stdout.write(data));
			runner.stderr?.on("data", (data) => process.stderr.write(data));
			let shuttingDown = false;
			runner.on("exit", (code) => {
				if (shuttingDown) return; // we asked it to stop (SIGINT/SIGTERM below)
				// The local runner died on its own (crash / OOM / Playwright fault). The relay
				// WS would otherwise keep this process alive and keep forwarding commands to a
				// now-dead local HTTP server — every task returns 500 while the agent still shows
				// "connected". Fail loudly and exit so the user (or a supervisor) restarts.
				writeError(`Local browser runtime exited unexpectedly${code ? ` (code ${code})` : ""}. Run \`pags up\` again to reconnect.`);
				process.exit(code ?? 1);
			});

			const shutdown = () => { shuttingDown = true; if (!runner.killed) runner.kill("SIGTERM"); };
			process.once("SIGINT", () => { shutdown(); process.exit(0); });
			process.once("SIGTERM", () => { shutdown(); process.exit(0); });

			try {
				await waitForLocalRunner({ url: localUrl, token: runnerToken, instanceId: primary });
				writeLine(`Local browser runtime healthy at ${localUrl}`);
				await connectViaRelay(instanceIds, localUrl, runnerToken, opts, Boolean(opts.force));
				await new Promise<void>((resolvePromise) => { runner.on("exit", () => resolvePromise()); });
			} catch (error) {
				shutdown();
				throw error;
			}
		});

	command
		.command("status")
	.description("Check local browser runtime health and capabilities")
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
	.description("Create a local browser runtime task")
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
	.description("Register a local or managed browser runtime endpoint with a PAGS instance")
	.requiredOption("--endpoint-url <url>", "browser runtime endpoint URL to store in PAGS")
	.option("--api-base <url>", "PAGS API base URL")
	.option("--pags-token <token>", "PAGS session token. Defaults to PAGS_TOKEN")
	.option("--runner-token <token>", "browser runtime bearer token to store in PAGS")
	.option("--url <url>", "Local browser runtime URL to probe for capabilities")
	.option("--token <token>", "Local browser runtime bearer token for capability probe")
	.option("--instance-id <id>", "PAGS instance id header for capability probe")
	.option("--placement <placement>", "Runtime placement: local or managed", "local")
	.option("--runner-version <version>", "Runner version")
	.option("--capability <name>", "Runtime capability; repeatable", collectCapability, [])
	.option("--probe", "Read capabilities from the browser runtime before registering")
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
	.option("--probe", "Ask PAGS to probe /health and /capabilities on the browser runtime")
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
	.description("Create a task through PAGS on an instance's registered browser runtime")
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
	.description("Approve a registered browser runtime task through PAGS")
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
	.description("Cancel a registered browser runtime task through PAGS")
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
	.description("Read registered browser runtime task events through PAGS")
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
	.description("Cancel a local browser runtime task")
	.option("--url <url>", "Runner URL")
	.option("--token <token>", "Runner bearer token")
	.option("--instance-id <id>", "PAGS instance id header")
	.action(async (taskId: string, opts: RunnerRequestOptions) => {
		const task = await requestRunner("POST", `/tasks/${apiPathSegment(taskId)}/cancel`, opts);
		writeLine(JSON.stringify(task, null, 2));
	});

	command
	.command("events")
	.description("List recent browser runtime events")
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
