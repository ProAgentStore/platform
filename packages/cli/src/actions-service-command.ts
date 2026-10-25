import { Command } from "commander";
import { installMacActionsService, removeMacActionsService } from "./actions-service.js";
import { serviceContext } from "./service-context.js";

export const serviceCommand = new Command("service")
	.description("Install or remove a pre-login Actions runner system service (macOS; asks for administrator approval)")
	.addCommand(new Command("install").requiredOption("--dir <absolute-directory>", "Configured runner directory").action(async (opts: { dir: string }) => {
		for (const line of await installMacActionsService(opts.dir, serviceContext())) process.stdout.write(`${line}\n`);
	}))
	.addCommand(new Command("remove").requiredOption("--dir <absolute-directory>", "Configured runner directory").action((opts: { dir: string }) => {
		for (const line of removeMacActionsService(opts.dir, serviceContext())) process.stdout.write(`${line}\n`);
	}));
