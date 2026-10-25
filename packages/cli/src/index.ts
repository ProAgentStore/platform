#!/usr/bin/env node
/**
 * @proagentstore/cli — create and publish server-powered AI agents.
 * Create, publish, and run server-powered AI agents from the terminal.
 */
import { createRequire } from "node:module";
import { Command } from "commander";
import { checkCommand } from "./commands/check.js";
import { devicesCommand } from "./commands/devices.js";
import { initCommand } from "./commands/init.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/login.js";
import { machinesCommand } from "./commands/machines.js";
import { watchdogCommand } from "./commands/watchdog.js";
import { mcpCommand } from "./commands/mcp.js";
import { remoteAuthCommand } from "./commands/remote-auth.js";
import { publishCommand } from "./commands/publish.js";
import { runnerCommand } from "./commands/runner.js";
import { logsCommand, statusCommand } from "./commands/status.js";
import { downCommand, upCommand } from "./commands/up.js";
import { writeError } from "./output.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
	.name("pags")
	.description(
		"ProAgentStore CLI — create and publish server-powered AI agents",
	)
	.version(version);

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(devicesCommand);
program.addCommand(upCommand);
program.addCommand(watchdogCommand);
program.addCommand(downCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(initCommand);
program.addCommand(checkCommand);
program.addCommand(publishCommand);
program.addCommand(runnerCommand);
program.addCommand(machinesCommand);
program.addCommand(mcpCommand);
program.addCommand(remoteAuthCommand);

try {
	await program.parseAsync();
} catch (error) {
	writeError(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
