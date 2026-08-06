import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { writeError, writeLine } from "../../output.js";
import {
	apiPathSegment,
	buildRuntimeRegistrationBody,
	clean,
	requestPags,
	requestRunner,
} from "./http.js";
import {
	findFreePort,
	runnerSpawnSpec,
	startRunnerForeground,
	waitForLocalRunner,
} from "./process.js";
import { connectViaRelay } from "./relay.js";
import type {
	PagsRequestOptions,
	RunnerConnectOptions,
	RunnerRequestOptions,
	RunnerStartOptions,
	RuntimeRegisterOptions,
} from "./types.js";

function collectCapability(value: string, previous: string[] = []): string[] {
	return [...previous, value];
}

export function createRunnerCommand(): Command {
	const command = new Command("runner").description(
		"Manage the local ProAgentStore browser runtime for ProAgentStore agents",
	);

	command
		.command("start")
		.description("Start the local ProAgentStore browser runtime in the foreground")
	.option("--host <host>", "Host to bind", "127.0.0.1")
	// NO default: commander would then always populate `opts.port`, so the `|| findFreePort(…)`
	// fallback below never ran and the EADDRINUSE guard it exists for was dead code. Anything
	// already bound to 49171 (a second OS user's runner, an unrelated dev server) made the runner
	// fail to bind, and `pags up` reported a runner exit after a 15s health-poll instead of just
	// picking 49172.
	.option("--port <port>", "Port to bind (default: first free port from 49171)")
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
		.option("--watch-instances", "Attach newly eligible agents while running, without a restart")
		.action(async (instanceIds: string[], opts: RunnerConnectOptions & { force?: boolean; watchInstances?: boolean }) => {
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
				await connectViaRelay(instanceIds, localUrl, runnerToken, opts, Boolean(opts.force), Boolean(opts.watchInstances));
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
