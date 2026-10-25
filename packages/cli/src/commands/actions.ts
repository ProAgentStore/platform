import { Command } from "commander";
import { serviceCommand } from "../actions-service-command.js";
import { readSupervisorConfig, readSupervisorStatus, requestSupervisorRecovery, runActionsSupervisor } from "../actions-supervisor.js";
import { writeLine } from "../output.js";

const supervise = new Command("supervise")
  .description("Run the PAGS-managed GitHub Actions listener for one configured runner")
  .requiredOption("--dir <path>", "absolute runner directory")
  .action(async ({ dir }: { dir: string }) => runActionsSupervisor(dir));

const recover = new Command("recover")
  .description("Safely request a listener reconnect for one managed runner")
  .requiredOption("--dir <path>", "absolute runner directory")
  .action(({ dir }: { dir: string }) => writeLine(JSON.stringify(requestSupervisorRecovery(dir))));

const status = new Command("status")
  .description("Show one runner's local supervisor and AC recovery status")
  .requiredOption("--dir <path>", "absolute runner directory")
  .action(({ dir }: { dir: string }) => writeLine(JSON.stringify({ config: readSupervisorConfig(dir), status: readSupervisorStatus(dir) }, null, 2)));

export const actionsCommand = new Command("actions")
  .description("Manage this machine's GitHub Actions runner services")
  .addCommand(supervise)
  .addCommand(recover)
  .addCommand(status)
  .addCommand(serviceCommand);
