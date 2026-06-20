#!/usr/bin/env node
import { startTestJobServer } from "./test-job-server.js";

function arg(name: string, fallback?: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1) return fallback;
	return process.argv[index + 1] || fallback;
}

function flag(name: string): boolean {
	return process.argv.includes(name);
}

if (flag("--help") || flag("-h")) {
	process.stdout.write(`ProAgentStore test job server

Usage:
  pags-test-job-server [--port 49210]

Routes:
  GET  /jobs/software-engineer
  POST /apply
  GET  /success/:id
  GET  /submissions
`);
	process.exit(0);
}

const port = Number(arg("--port", process.env.PAGS_TEST_JOB_PORT || "49210"));
const server = await startTestJobServer(port);
process.stdout.write(`PAGS test job server listening at ${server.url}\n`);
process.stdout.write(`Job URL: ${server.jobUrl}\n`);

const shutdown = async () => {
	await server.close();
	process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
