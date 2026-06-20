#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { startRunnerServer } from "./server.js";
import type { RunnerConfig } from "./types.js";

function arg(name: string, fallback?: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1) return fallback;
	return process.argv[index + 1] || fallback;
}

function flag(name: string): boolean {
	return process.argv.includes(name);
}

function configFromArgs(): RunnerConfig {
	const dataDir =
		arg("--data-dir") ||
		process.env.PAGS_RUNNER_DATA_DIR ||
		join(homedir(), ".config", "proagentstore", "browser-runner");
	return {
		host: arg("--host", process.env.PAGS_RUNNER_HOST || "127.0.0.1") || "127.0.0.1",
		port: Number(arg("--port", process.env.PAGS_RUNNER_PORT || "49171")),
		dataDir,
		token: arg("--token", process.env.PAGS_RUNNER_TOKEN),
		instanceId: arg("--instance-id", process.env.PAGS_INSTANCE_ID),
		headless: flag("--headless") || process.env.PAGS_RUNNER_HEADLESS === "1",
	};
}

if (flag("--help") || flag("-h")) {
	process.stdout.write(`ProAgentStore browser runner

Usage:
  pags-browser-runner [--host 127.0.0.1] [--port 49171] [--data-dir path] [--token token] [--instance-id id] [--headless]

Endpoints:
  GET  /health
  GET  /capabilities
  GET  /tasks
  POST /tasks
  GET  /tasks/:id
  POST /tasks/:id/approve
  POST /tasks/:id/cancel
  GET  /events
`);
	process.exit(0);
}

const config = configFromArgs();
const started = await startRunnerServer(config);
process.stdout.write(`PAGS browser runner listening at ${started.url}\n`);
process.stdout.write(`Data dir: ${config.dataDir}\n`);
process.stdout.write(`Brain placement: PAGS; runner role: tool-executor\n`);
if (config.token) process.stdout.write("Auth: bearer token required\n");
if (config.instanceId) process.stdout.write(`Instance binding: ${config.instanceId}\n`);

const shutdown = async () => {
	await started.close();
	process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
