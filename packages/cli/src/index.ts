#!/usr/bin/env node
/**
 * @proagentstore/cli — create and publish server-powered AI agents.
 * Mirrors FAGS CLI (@freeagentstore/cli) for platform consistency.
 */
import { createRequire } from "node:module";
import { Command } from "commander";
import { checkCommand } from "./commands/check.js";
import { initCommand } from "./commands/init.js";
import { publishCommand } from "./commands/publish.js";
import { runnerCommand } from "./commands/runner.js";
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

program.addCommand(initCommand);
program.addCommand(checkCommand);
program.addCommand(publishCommand);
program.addCommand(runnerCommand);

try {
	await program.parseAsync();
} catch (error) {
	writeError(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
