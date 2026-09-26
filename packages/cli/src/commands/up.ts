import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Command } from "commander";
import { requireSession } from "./login.js";
import { maybeClaimMachineNames } from "../machine-claim.js";
import { loadMachineIdentity } from "../machine.js";
import { partitionByPin, type DiscoverableInstance } from "./runner/membership.js";
import { hostname } from "node:os";
import { writeLine } from "../output.js";
import { clearScreen, printLogo, printStatus, printStep, waitForKey, type TuiState } from "../tui.js";
import { parseStatusLine } from "./runner/status-line.js";
import { restartUpArgs, RUNNER_RESTART_EXIT_CODE, SUPERVISED_ENV, SUPERVISOR_RESTARTS } from "./runner/self-update.js";

const API_BASE = "https://api.proagentstore.online";
const CLI_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/**
 * Kill any stale runner processes from previous runs. Critical: without
 * this, every `pags up` stacks another runner, they fight over ports,
 * and the health check hits the wrong one → 401.
 */
async function stopRunnerProcesses(): Promise<boolean> {
	if (process.platform === "win32") return false;
	const { execFileSync } = await import("node:child_process");
	const patterns = [
		"dist/browser-runner/index.js",
		"browser-runner/src/index",
		"runner connect",
	];
	let stopped = false;
	for (const p of patterns) {
		try {
			// execFileSync (argv, no shell) — the pattern never touches a shell, so there's
			// no command-injection surface even if a pattern ever becomes dynamic.
			execFileSync("pkill", ["-f", p], { stdio: "ignore" });
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
			heartbeat: "ok",
			lastEvent: "Fetching instances...",
			taskCount: 0,
			version: CLI_VERSION,
			// What "a few seconds" is measured against: a state that never resolves was described
			// as taking a few seconds, indefinitely, because nothing counted (#497).
			startedAt: Date.now(),
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
		const data = await res.json() as { instances?: Array<DiscoverableInstance & { agent_id: string; slug?: string }> };
		const active = (data.instances || []).filter((i) => i.status === "active");
		let instances = active;
		/** Runtime agents pinned to ANOTHER machine — served there, listed here, never attached (#810). */
		let elsewhere: typeof active = [];

		if (opts.instance) {
			// Explicit pin: honor it as-is (the user knows what they're debugging).
			instances = instances.filter((i) => i.id === opts.instance || i.slug === opts.instance);
		} else {
			// Auto: only register agents that actually USE a local runner (coding/browser).
			// Chat/RAG/connector agents (runtime:null) run entirely in the cloud and never
			// call the runner — registering them just creates noise (relay DOs, heartbeats,
			// and phantom entries on the Terminals page).
			instances = instances.filter((i) => i.capabilities?.runtime != null);
		}

		if (instances.length === 0) {
			// Distinguish "you have agents, none need a runner" from "no agents at all".
			if (!opts.instance && active.length > 0) {
				printStep("None of your agents need a local runner", "ok");
				writeLine("  They run in the cloud (chat, knowledge, connectors) — nothing to connect here.");
				writeLine("  Only coding (Coder) and browser agents (e.g. Job Application Assistant) use `pags up`.");
				process.exit(0);
			}
			printStep("No active instances found", "fail");
			writeLine("  Subscribe to an agent at https://proagentstore.online");
			process.exit(1);
		}

		// Before the runner registers: offer the account's UNCLAIMED machine names (#460), so a
		// laptop the network has renamed can say so and reconnect the pins stranded on its old
		// names. Must happen here, ahead of the spawn — the child reads `machine.json` when it
		// registers, and that register is what stamps the claim onto the rows — and ahead of the
		// pin split below, so a name claimed just now counts as this machine's.
		//
		// Wrapped, gated and time-bounded: `pags up` is the entry point for every runtime agent, so
		// nothing about a convenience prompt may keep it from starting. `--headless`, a non-TTY
		// stdin, `CI` and `PAGS_NO_PROMPT` return before any network call is made.
		await maybeClaimMachineNames({
			token: session.token,
			apiBase: API_BASE,
			headless: opts.headless,
		}).catch(() => undefined);

		// The pin rule, applied at the START (#810). It is the same rule discovery applies 20
		// seconds in; applying it only there meant every runtime agent on the account was
		// attached and force-registered first — suspending the OTHER machine's coding sessions on
		// agents this one would then detach — and counted for the life of the process, so the
		// screen never left "Still connecting". `--instance X` is exempt: it names exactly that
		// agent, and the user debugging it knows where it is pinned.
		if (!opts.instance) {
			const split = partitionByPin(instances, hostname(), loadMachineIdentity(hostname()).names);
			instances = split.here;
			elsewhere = split.elsewhere;
		}

		if (instances.length === 0) {
			// Every runtime agent is pinned to some other machine. Not an error — those machines
			// serve them — but nothing for this one to do, said plainly rather than as a screen
			// that never finishes connecting.
			printStep(`All ${elsewhere.length} of your runtime agents are pinned to other machines`, "ok");
			for (const inst of elsewhere) writeLine(`    ${inst.name || inst.slug || inst.id.slice(0, 8)} → ${inst.config?.runnerNode}`);
			writeLine("  They are served there. To run one from this machine, change its \"Runs on\" pin in the console, then `pags up` again.");
			process.exit(0);
		}

		state.instances = instances.map((i) => ({ id: i.id, name: i.name || i.slug || i.id.slice(0, 8) }));
		printStep(`Found ${instances.length} instance${instances.length === 1 ? "" : "s"}`, "ok");
		for (const inst of state.instances) {
			writeLine(`    ${inst.name} (${inst.id.slice(0, 8)}...)`);
		}
		if (elsewhere.length) {
			printStep(`${elsewhere.length} more pinned to other machines — served there, not attached here`, "ok");
			for (const inst of elsewhere) writeLine(`    ${inst.name || inst.slug || inst.id.slice(0, 8)} → ${inst.config?.runnerNode}`);
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
		// Watch for newly eligible agents so subscribing to one attaches it without a restart
		// (#229). NOT for a scoped run: `--instance X` means exactly that agent, and quietly
		// fanning back out to the whole account is the bug the restart path already guards.
		if (!opts.instance) args.push("--watch-instances");

		// Supervised (#859): the child may exit asking for a restart after `runner_update` installed a new
		// CLI. {@link SUPERVISOR_RESTARTS} tells it this `pags up` restarts ITSELF on the new release (#860).
		const child = spawn(process.execPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PAGS_TOKEN: session.token, [SUPERVISED_ENV]: SUPERVISOR_RESTARTS },
		});

		const logs: string[] = [];

		const handleOutput = (data: Buffer) => {
			const text = data.toString("utf-8");
			for (const line of text.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				logs.push(trimmed);
				if (logs.length > 200) logs.shift();

				// The child STATES its product-level facts; everything below is prose (#497).
				// Registration and the heartbeat used to be inferred from relay wording, which is
				// how a machine that registered nothing still showed a green ProAgentStore light.
				const status = parseStatusLine(trimmed);
				if (status) {
					if (status.registration) {
						state.registration = status.registration === "ok" ? "registered" : "failed";
						state.lastEvent = status.registration === "ok"
							? `Registered with PAGS — ${status.agents ?? "all"} agents ready`
							: `PAGS registration ${status.registration}${status.agents ? ` (${status.agents} agents)` : ""}${status.reason ? `: ${status.reason}` : ""}`;
					}
					if (status.heartbeat) {
						// Its OWN state. Borrowing registration's is what turned a 30s heartbeat
						// blip into a permanent "not registered", with no line able to clear it.
						state.heartbeat = status.heartbeat === "ok" ? "ok" : "failing";
						state.lastEvent = status.heartbeat === "ok"
							? "Heartbeat recovered — this machine reads as online again"
							: `Heartbeat failing${status.reason ? `: ${status.reason}` : ""} — the console will show this machine offline`;
					}
					printStatus(state);
					continue;
				}

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
					state.lastEvent = "Connected via WebSocket relay";
					printStatus(state);
					continue;
				}

				if (trimmed.includes("browser runtime listening")) {
					state.runner = "online";
					state.lastEvent = "Runner started";
					printStatus(state);
					continue;
				}
				// A relay conflict is the one failure with a one-command remedy, and it matched
				// NOTHING here: the old branch tested for "Another machine", a string nothing in
				// the repo ever printed, while the CLI's real line ("Relay conflict: …") contains
				// neither "error" nor "failed" and so missed the catch-all below too (#497).
				if (trimmed.includes("Relay conflict:")) {
					state.lastEvent = "Another runner holds this agent — run `pags up --force` here to take it over";
					printStatus(state);
					continue;
				}
				if (trimmed.includes("Relay conflict cleared:")) {
					state.lastEvent = "Relay conflict cleared — reattaching";
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

		let childDead = false;
		child.stdout?.on("data", handleOutput);
		child.stderr?.on("data", handleOutput);
		child.on("exit", (code: number | null) => {
			// `runner_update` installed a newer CLI and asked to be started again (#859) — not a crash.
			// The WHOLE `pags up` restarts, not only this child (#860): respawning just the child left
			// this supervisor on the old code until someone restarted it at the machine. No prompt on the
			// way back — nobody may be at the keyboard, and every agent must re-attach unattended.
			if (code === RUNNER_RESTART_EXIT_CODE) {
				restartUp("Runner updated remotely — restarting pags up on the new version…", { PAGS_NO_PROMPT: "1" });
				return;
			}
			childDead = true;
			if (code && code !== 0) {
				state.runner = "error";
				state.lastEvent = `Runner exited (code ${code})`;
				const recent = logs.slice(-5);
				if (recent.length) state.lastEvent += ": " + recent[recent.length - 1].slice(0, 60);
				printStatus(state);
			}
		});

		/**
		 * `pags up` again with the SAME flags, on this terminal, leaving with its exit status. Node cannot
		 * exec in place, so this process waits, blocked, while the new one owns the terminal — blocked
		 * rather than awaiting, so it never reads a keystroke meant for the new one. `process.argv[1]` is
		 * the installed `pags` (the #862 stub when there is one), so the new process runs the newest CLI.
		 */
		function restartUp(why: string, env: NodeJS.ProcessEnv = {}): never {
			writeLine(`  ${why}`);
			try {
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				process.stdin.pause();
				// execFileSync (argv, no shell) so an instance id/slug can't be mis-quoted.
				execFileSync(process.execPath, [process.argv[1], ...restartUpArgs(opts)], { stdio: "inherit", env: { ...process.env, ...env } });
			} catch (e) {
				// Restarting IS what `r` promises. Swallowing the failure and exiting 0 told the
				// shell — and anything scripting `pags up` — that the runner had been restarted
				// while nothing was left running and no agent could be reached from the cloud.
				const status = (e as { status?: number }).status;
				writeLine(`  Restart failed${typeof status === "number" ? ` (exit ${status})` : ""} — the runner is NOT running. Run 'pags up' again.`);
				process.exit(typeof status === "number" && status !== 0 ? status : 1);
			}
			process.exit(0);
		}

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
			// Ctrl+C must take the SAME path as `q` — otherwise it exits the TUI and orphans the
			// runner child, which keeps the relay open and the browser alive.
			const key = await waitForKey(["r", "l", "q"], shutdown);
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
				if (childDead) restartUp("Restarting runner...");
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
