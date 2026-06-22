#!/usr/bin/env node
/**
 * @proagentstore/cli — create and publish server-powered AI agents.
 * Mirrors FAGS CLI (@freeagentstore/cli) for platform consistency.
 */
import { createRequire } from "node:module";
import { Command } from "commander";
import { checkCommand } from "./commands/check.js";
import { initCommand } from "./commands/init.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/login.js";
import { mcpCommand } from "./commands/mcp.js";
import { publishCommand } from "./commands/publish.js";
import { runnerCommand } from "./commands/runner.js";
import { upCommand } from "./commands/up.js";
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
program.addCommand(upCommand);
program.addCommand(initCommand);
program.addCommand(checkCommand);
program.addCommand(publishCommand);
program.addCommand(runnerCommand);
program.addCommand(mcpCommand);

try {
	await program.parseAsync();
} catch (error) {
	writeError(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
