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

		const target = instances[0];
		writeLine(`\nConnecting runner to: ${target.name || target.id.slice(0, 8)}...`);

		// Spawn `pags runner connect <id> --pags-token <token>` as a child process
		const { spawn } = await import("node:child_process");
		const cliPath = process.argv[1]; // path to the current CLI entry point
		const args = [
			cliPath, "runner", "connect", target.id,
			"--pags-token", session.token,
		];
		if (opts.headless) args.push("--headless");

		const child = spawn(process.execPath, args, {
			stdio: "inherit",
			env: process.env,
		});

		child.on("exit", (code) => {
			process.exit(code || 0);
		});
	});
