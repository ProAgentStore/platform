import { Command } from "commander";
import { requireSession } from "./login.js";
import { writeLine, writeError } from "../output.js";

const API_BASE = "https://api.proagentstore.online";

export const upCommand = new Command("up")
	.description("Start the browser runner for all your agent instances")
	.option("--headless", "Run browser in headless mode")
	.option("--instance <id>", "Connect to a specific instance only")
	.action(async (opts: { headless?: boolean; instance?: string }) => {
		const session = requireSession();
		writeLine(`Signed in as ${session.user.login}`);

		// Fetch instances
		writeLine("Fetching your instances...");
		const res = await fetch(`${API_BASE}/v1/instances/my/instances`, {
			headers: { Authorization: `Bearer ${session.token}` },
		});
		if (!res.ok) {
			writeError(`Failed to fetch instances: ${res.status}`);
			process.exit(1);
		}
		const data = await res.json() as { instances?: Array<{ id: string; agent_id: string; status: string; name?: string; slug?: string }> };
		let instances = (data.instances || []).filter((i) => i.status === "active");

		if (opts.instance) {
			instances = instances.filter((i) => i.id === opts.instance || i.slug === opts.instance);
		}

		if (instances.length === 0) {
			writeError("No active instances found. Subscribe to an agent first at https://proagentstore.online");
			process.exit(1);
		}

		writeLine(`Found ${instances.length} instance${instances.length === 1 ? "" : "s"}:`);
		for (const inst of instances) {
			writeLine(`  ${inst.name || inst.slug || inst.id.slice(0, 8)} (${inst.id.slice(0, 8)}...)`);
		}

		// Connect to the first instance (multi-instance support later)
		const target = instances[0];
		writeLine(`\nConnecting runner to: ${target.name || target.id.slice(0, 8)}...`);

		// Import and run the connect command logic
		const { runnerCommand } = await import("./runner.js");
		const connectCmd = runnerCommand.commands.find((c) => c.name() === "connect");
		if (!connectCmd) {
			writeError("Runner connect command not found");
			process.exit(1);
		}

		// Build args and run connect
		const args = [
			"node", "pags", "runner", "connect", target.id,
			"--pags-token", session.token,
		];
		if (opts.headless) args.push("--headless");

		// Re-parse with the connect subcommand
		process.argv = args;
		try {
			await connectCmd.parseAsync(args.slice(2), { from: "user" });
		} catch (err) {
			writeError(err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	});
