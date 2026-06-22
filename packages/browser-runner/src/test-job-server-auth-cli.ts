#!/usr/bin/env node
import { startTestJobServerAuth } from "./test-job-server-auth.js";

function arg(name: string, fallback?: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1) return fallback;
	return process.argv[index + 1] || fallback;
}

function flag(name: string): boolean {
	return process.argv.includes(name);
}

if (flag("--help") || flag("-h")) {
	process.stdout.write(`ProAgentStore test job server (with auth)

Usage:
  pags-test-job-server-auth [--port 49211]

Routes:
  GET  /register              Registration form
  POST /register              Create account
  GET  /login                 Login form
  POST /login                 Sign in
  POST /logout                Sign out
  GET  /jobs/software-engineer  Job posting (public)
  GET  /apply                 Application form (requires auth)
  POST /apply                 Submit application (requires auth)
  GET  /dashboard             User's applications (requires auth)
  GET  /success/:id           Submission confirmation (requires auth)
  GET  /submissions           All submissions (JSON, no auth)
`);
	process.exit(0);
}

const port = Number(arg("--port", process.env.PAGS_TEST_JOB_AUTH_PORT || "49211"));
const server = await startTestJobServerAuth(port);
process.stdout.write(`PAGS test job server (auth) listening at ${server.url}\n`);
process.stdout.write(`Job URL: ${server.jobUrl}\n`);
process.stdout.write(`Register: ${server.registerUrl}\n`);
process.stdout.write(`Login: ${server.loginUrl}\n`);

const shutdown = async () => {
	await server.close();
	process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
