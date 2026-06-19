#!/usr/bin/env node
/**
 * @proagentstore/cli — create and publish server-powered AI agents.
 * Mirrors FAGS CLI (@freeagentstore/cli) for platform consistency.
 */
import { Command } from "commander";
import { checkCommand } from "./commands/check.js";
import { initCommand } from "./commands/init.js";
import { publishCommand } from "./commands/publish.js";
import { runnerCommand } from "./commands/runner.js";
import { writeError } from "./output.js";

const program = new Command();

program
	.name("pags")
	.description(
		"ProAgentStore CLI — create and publish server-powered AI agents",
	)
	.version("0.1.0");

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
