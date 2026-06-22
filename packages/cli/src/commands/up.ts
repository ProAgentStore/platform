import { Command } from "commander";
import { requireSession } from "./login.js";
import { writeLine, writeError } from "../output.js";
import { clearScreen, printLogo, printStatus, printStep, printEvent, waitForKey, type TuiState } from "../tui.js";

const API_BASE = "https://api.proagentstore.online";

export const upCommand = new Command("up")
	.description("Start the browser runner for all your agent instances")
	.option("--headless", "Run browser in headless mode")
	.option("--instance <id>", "Connect to a specific instance only")
	.action(async (opts: { headless?: boolean; instance?: string }) => {
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
		};

		clearScreen();
		printLogo();
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

		const target = instances[0];
		state.activeInstance = target.name || target.slug || target.id.slice(0, 8);
		printStep(`Connecting: ${state.activeInstance}`, "wait");

		// Spawn runner connect as child process
		const { spawn } = await import("node:child_process");
		const cliPath = process.argv[1];
		const args = [cliPath, "runner", "connect", target.id];
		if (opts.headless) args.push("--headless");

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

				// Parse tunnel URL
				const tunnelMatch = trimmed.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
				if (tunnelMatch) {
					state.tunnel = "online";
					state.tunnelUrl = tunnelMatch[0];
					state.lastEvent = "Tunnel created";
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
				if (trimmed.includes("fetch failed")) {
					state.registration = "failed";
					state.lastEvent = "PAGS registration failed (will retry on next task)";
					printStatus(state);
					continue;
				}

				// Skip cloudflared noise
				if (trimmed.includes("INF ")) continue;

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
				// Show last few log lines as error context
				const recent = logs.slice(-5).filter(l => !l.includes("INF "));
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
				await waitForKey(["r", "l", "q", " ", "\r"]);
				printStatus(state);
			}
			if (key === "r") {
				if (childDead) {
					// Restart
					writeLine("  Restarting runner...");
					state.runner = "starting";
					state.tunnel = "offline";
					state.tunnelUrl = "";
					state.registration = "pending";
					state.lastEvent = "Restarting...";
					// Re-exec pags up
					const { execSync } = await import("node:child_process");
					try {
						execSync(`${process.execPath} ${process.argv[1]} up${opts.headless ? " --headless" : ""}`, {
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
