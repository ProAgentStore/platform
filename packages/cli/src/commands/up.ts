import { createRequire } from "node:module";
import { Command } from "commander";
import { requireSession } from "./login.js";
import { writeLine } from "../output.js";
import { clearScreen, printLogo, printStatus, printStep, waitForKey, type TuiState } from "../tui.js";

const API_BASE = "https://api.proagentstore.online";
const CLI_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/**
 * Kill any stale runner processes from previous runs. Critical: without
 * this, every `pags up` stacks another runner, they fight over ports,
 * and the health check hits the wrong one → 401.
 */
async function stopRunnerProcesses(): Promise<boolean> {
	if (process.platform === "win32") return false;
	const { execSync } = await import("node:child_process");
	const patterns = [
		"dist/browser-runner/index.js",
		"browser-runner/src/index",
		"runner connect",
	];
	let stopped = false;
	for (const p of patterns) {
		try {
			execSync(`pkill -f ${JSON.stringify(p)}`, { stdio: "ignore" });
			stopped = true;
		} catch {
			/* nothing matched — fine */
		}
	}
	return stopped;
}

export const upCommand = new Command("up")
	.description("Start the browser runner for all your agent instances")
	.option("--headless", "Run browser in headless mode")
	.option("--instance <id>", "Connect to a specific instance only")
	.option("--force", "Take over from another connected machine")
	.action(async (opts: { headless?: boolean; instance?: string; force?: boolean }) => {
		const session = requireSession();

		const state: TuiState = {
			user: session.user.login,
			instances: [],
			activeInstance: "",
			runner: "starting",
			tunnel: "offline",
			tunnelUrl: "",
			registration: "pending",
			lastEvent: "Fetching instances...",
			taskCount: 0,
			version: CLI_VERSION,
		};

		clearScreen();
		printLogo(CLI_VERSION);
		printStep("Signed in as " + session.user.login, "ok");

		// Fetch instances
		printStep("Fetching instances...", "wait");
		const res = await fetch(`${API_BASE}/v1/instances/my/instances`, {
			headers: { Authorization: `Bearer ${session.token}` },
		});
		if (!res.ok) {
			printStep("Failed to fetch instances: " + res.status, "fail");
			process.exit(1);
		}
		const data = await res.json() as { instances?: Array<{ id: string; agent_id: string; status: string; name?: string; slug?: string }> };
		let instances = (data.instances || []).filter((i) => i.status === "active");

		if (opts.instance) {
			instances = instances.filter((i) => i.id === opts.instance || i.slug === opts.instance);
		}

		if (instances.length === 0) {
			printStep("No active instances found", "fail");
			writeLine("  Subscribe to an agent at https://proagentstore.online");
			process.exit(1);
		}

		state.instances = instances.map((i) => ({ id: i.id, name: i.name || i.slug || i.id.slice(0, 8) }));
		printStep(`Found ${instances.length} instance${instances.length === 1 ? "" : "s"}`, "ok");
		for (const inst of state.instances) {
			writeLine(`    ${inst.name} (${inst.id.slice(0, 8)}...)`);
		}

		state.activeInstance =
			instances.length === 1
				? instances[0].name || instances[0].slug || instances[0].id.slice(0, 8)
				: `${instances.length} agents`;
		printStep(`Connecting ${state.activeInstance}…`, "wait");

		// Clean slate: kill any stale runner from a previous run.
		await stopRunnerProcesses();

		// Spawn ONE runner connect that serves ALL active instances.
		const { spawn } = await import("node:child_process");
		const cliPath = process.argv[1];
		const args = [cliPath, "runner", "connect", ...instances.map((i) => i.id)];
		if (opts.headless) args.push("--headless");
		if (opts.force) args.push("--force");

		const child = spawn(process.execPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PAGS_TOKEN: session.token },
		});

		const logs: string[] = [];

		const handleOutput = (data: Buffer) => {
			const text = data.toString("utf-8");
			for (const line of text.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				logs.push(trimmed);
				if (logs.length > 200) logs.shift();

				if (trimmed.includes("Relay connected:")) {
					state.tunnel = "online";
					state.tunnelUrl = "WebSocket relay";
					state.lastEvent = "Relay connected";
					printStatus(state);
					continue;
				}
				if (trimmed.includes("WebSocket relay")) {
					state.tunnel = "online";
					state.tunnelUrl = "WebSocket relay";
					state.registration = "registered";
					state.lastEvent = "Connected via WebSocket relay";
					printStatus(state);
					continue;
				}

				if (trimmed.includes("FAGS browser runtime listening")) {
					state.runner = "online";
					state.lastEvent = "Runner started";
					printStatus(state);
					continue;
				}
				if (trimmed.includes("Runtime registered") || trimmed.includes("CONNECTED")) {
					state.registration = "registered";
					state.lastEvent = "Registered with PAGS — ready for tasks";
					printStatus(state);
					continue;
				}
				if (trimmed.includes("Another machine")) {
					state.registration = "failed";
					state.lastEvent = trimmed.slice(0, 80);
					printStatus(state);
					continue;
				}
				if (trimmed.includes("fetch failed")) {
					state.registration = "failed";
					state.lastEvent = "PAGS registration failed";
					printStatus(state);
					continue;
				}

				// Show errors
				if (/error|Error|EADDRINUSE|ECONNREFUSED|failed/i.test(trimmed)) {
					state.lastEvent = trimmed.slice(0, 80);
					printStatus(state);
				}
			}
		};

		child.stdout?.on("data", handleOutput);
		child.stderr?.on("data", handleOutput);

		let childDead = false;
		child.on("exit", (code) => {
			childDead = true;
			if (code && code !== 0) {
				state.runner = "error";
				state.lastEvent = `Runner exited (code ${code})`;
				const recent = logs.slice(-5);
				if (recent.length) state.lastEvent += ": " + recent[recent.length - 1].slice(0, 60);
				printStatus(state);
			}
		});

		const shutdown = () => {
			child.kill();
			clearScreen();
			writeLine("  Runner stopped.");
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		// Interactive loop — stay alive even if child dies
		while (true) {
			const key = await waitForKey(["r", "l", "q"]);
			if (key === "q") {
				shutdown();
				break;
			}
			if (key === "l") {
				clearScreen();
				writeLine("  Recent logs (last 30 lines):");
				writeLine("");
				for (const line of logs.slice(-30)) {
					writeLine("  " + line);
				}
				writeLine("");
				writeLine("  Press any key to go back...");
				await waitForKey([]); // any key goes back
				printStatus(state);
			}
			if (key === "r") {
				if (childDead) {
					writeLine("  Restarting runner...");
					const { execSync } = await import("node:child_process");
					try {
						execSync(`${process.execPath} ${process.argv[1]} up${opts.headless ? " --headless" : ""}${opts.force ? " --force" : ""}`, {
							stdio: "inherit",
							env: process.env,
						});
					} catch {}
					process.exit(0);
				}
				printStatus(state);
			}
		}
	});

export const downCommand = new Command("down")
	.description("Stop the browser runner and disconnect")
	.action(async () => {
		clearScreen();
		printLogo(CLI_VERSION);
		if (process.platform === "win32") {
			writeLine("  On Windows: switch to the 'pags up' window and press Ctrl+C to disconnect.");
			writeLine("");
			return;
		}
		const stopped = await stopRunnerProcesses();
		if (stopped) {
			writeLine("  " + "✓ Runner stopped — you're disconnected.");
			writeLine("");
			writeLine("  Your agent won't act on the web until you run 'pags up' again.");
		} else {
			writeLine("  No runner was running — nothing to stop.");
		}
		writeLine("");
	});
