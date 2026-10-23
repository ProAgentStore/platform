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
import { processRestartDeps, restartPagsUp, RUNNER_DIED_EXIT_CODE, runnerExitAction, upRestartMode } from "./up-restart.js";
import { restartUpArgs, SUPERVISED_ENV, SUPERVISOR_RESTARTS } from "./runner/self-update.js";
import { configDir, holderMessage, inspectHolder, isTakeable, lockPath, readLock, releaseLock } from "../runner-lock.js";
import { crashPaths, deliverCrashReports, recordChildExit } from "../crash-delivery.js";
import { alreadyRunningLines, RUNNER_ALREADY_RUNNING_EXIT_CODE } from "../existing-runner.js";
import { RelayLinks } from "../relay-link.js";
import { LineSplitter } from "../line-buffer.js";
import { replaceHolder } from "../runner-replace.js";
import { startInBackground } from "./up-background.js";
import { BACKGROUND_RESTART_ENV, waitUntilTakeable } from "../background.js";
import { installService, uninstallService } from "../service-install.js";
import { serviceContext } from "../service-context.js";
import { ensureWatchdogInstalled } from "../watchdog/ensure.js";
import { logUpdateStep } from "../bootstrap/update-log.js";

const API_BASE = "https://api.proagentstore.online";
const CLI_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/**
 * `stopRunnerProcesses()` — `pkill -f` over three name patterns — was deleted here (#896).
 *
 * It ran on every `pags up` and every `pags down`, and it was the cause of the failure this issue
 * was filed from rather than a defence against it:
 *
 *  - it killed ANY matching process of this OS user: a deliberate scoped `runner connect`, a dev
 *    runner from the monorepo, a runner signed in as a DIFFERENT account, and a launchd/systemd
 *    one that the service manager then restarted — so the two fought in a loop;
 *  - it killed the live runner's CHILD, whose SIGTERM exit reads as `code === null`; the old
 *    supervisor's `if (code && code !== 0)` then treated that as a clean exit, so a five-day-old
 *    terminal kept showing "connected" while owning nothing. Pressing `r` there killed the real
 *    runner in turn;
 *  - since the local runtimes shipped it destroyed real work on every start: a Codex or Grok turn,
 *    a local browser research run, a Tailor run, an Application Runner fill — each lost, with the
 *    owner told nothing until the cloud gave up on it minutes later;
 *  - on Windows it was skipped entirely, so there was no protection there at all.
 *
 * What replaces it: an exclusive per-account lock (`runner-lock.ts`), which refuses rather than
 * kills, takes over only a lock whose process is GONE, and makes replacement an explicit
 * `--replace` that stops the holder gracefully through its own control endpoint.
 */

export const upCommand = new Command("up")
	.description("Start the browser runner for all your agent instances")
	.option("--headless", "Run browser in headless mode")
	.option("--instance <id>", "Connect to a specific instance only")
	.option("--force", "Take over from another connected machine")
	// #896. Deliberately NOT `--force`, which already means something else here: `--force` takes an
	// agent's relay slot from ANOTHER MACHINE, while `--replace` stops another `pags up` on THIS
	// one. Folding them together would make one flag mean two unrelated takeovers.
	.option("--replace", "Stop the `pags up` already running here for this account, then take over")
	.option("--now", "With --replace: stop it even though work is running on it (that work is lost)")
	// #499: opt-in, never the default. Same discovery, pins and lock as the foreground runner; the
	// runner then runs detached and logs to a file. Stop it with `pags down`, see it with `pags status`.
	.option("--background", "Run the runner in the background, with no terminal open (stop it with `pags down`)")
	// #1141: an OS supervisor (launchd / systemd / Scheduled Task) that starts `pags up` again whenever it exits — a
	// crash, an update that never came back, a reboot — with backoff. See service-install.ts.
	.option("--install-service", "Install an OS service that keeps `pags up` running (launchd, systemd or a Scheduled Task), then exit")
	.option("--uninstall-service", "Remove the service --install-service installed, then exit")
	.action(async (opts: { headless?: boolean; instance?: string; force?: boolean; replace?: boolean; now?: boolean; background?: boolean; installService?: boolean; uninstallService?: boolean }) => {
		if (opts.uninstallService) {
			for (const line of uninstallService(serviceContext()).lines) writeLine(line);
			return;
		}
		// One restart owner from the FIRST start (#1154): a terminal `pags up` with no service or launcher above it
		// becomes the launcher and runs the real one as its child, so a crash of the runner — or of that child —
		// is started again rather than final. Not `--background`, which detaches and exits, nor the service verbs.
		if (!opts.background && !opts.installService && upRestartMode(process.env) === "launcher") {
			restartPagsUp(process.argv.slice(2), {}, { ...processRestartDeps(), log: (line) => writeLine(`  ${line}`) }, { initial: true });
			return;
		}
		const session = requireSession();
		if (opts.installService) {
			// Signed in first: the service runs as this user, on this sign-in.
			const result = installService(serviceContext());
			for (const line of result.lines) writeLine(line);
			writeLine(result.ok
				? "The service starts `pags up` now and whenever it exits. A `pags up` already running here keeps the lock; the service takes over once it stops."
				: "The service was not fully installed — see the FAILED line above.");
			if (!result.ok) process.exitCode = 1;
			return;
		}

		// The always-on control channel (#1320): a runner the OS service started installs the watchdog service beside itself, once.
		if (process.env.PAGS_SERVICE === "1") {
			const w = ensureWatchdogInstalled(serviceContext());
			if (w.action === "installed" || w.action === "failed") logUpdateStep(`watchdog: ${w.action} — ${w.why}`);
		}

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

		// A start nobody is watching — the restart after a remote update (#1151). It must not end on a failure a
		// retry would clear: on 2026-10-17 no process was left to start it again once it had.
		const unattended = process.env.PAGS_NO_PROMPT === "1";
		logUpdateStep(`start: pags up ${CLI_VERSION}${unattended ? " (unattended)" : ""}`);

		clearScreen();
		printLogo(CLI_VERSION);
		printStep("Signed in as " + session.user.login, "ok");

		// Fetch instances
		printStep("Fetching instances...", "wait");
		type Listed = { instances?: Array<DiscoverableInstance & { agent_id: string; slug?: string }> };
		let data: Listed;
		for (let failures = 1; ; failures++) {
			let failure: string;
			try {
				const res = await fetch(`${API_BASE}/v1/instances/my/instances`, { headers: { Authorization: `Bearer ${session.token}` } });
				if (res.ok) {
					data = (await res.json()) as Listed;
					break;
				}
				failure = `HTTP ${res.status}`;
			} catch (e) {
				failure = e instanceof Error ? e.message : String(e);
			}
			logUpdateStep(`start: fetching instances failed (${failure})${unattended ? "" : " — exiting"}`);
			if (!unattended) {
				printStep("Failed to fetch instances: " + failure, "fail");
				process.exit(1);
			}
			const wait = Math.min(5 * 60_000, 5_000 * 2 ** (failures - 1));
			printStep(`Failed to fetch instances (${failure}) — retrying in ${Math.round(wait / 1000)}s`, "wait");
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
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
			const me = loadMachineIdentity(hostname());
			const split = partitionByPin(instances, hostname(), [...me.names, me.id], me.id);
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

		// One `pags up` per account on this machine (#896). The lock is held by the `runner connect`
		// child, which owns the sockets; this checks it FIRST so a second start can refuse with who
		// holds it rather than killing them. `--replace` asks that holder to stop, gracefully.
		const lockFile = lockPath(session.user.login);
		// A restart after a remote update is started as the old runner leaves (#499, #1151): give it a bounded moment
		// to release the lock before judging it.
		if (unattended || (opts.background && process.env[BACKGROUND_RESTART_ENV] === "1")) await waitUntilTakeable(() => inspectHolder(lockFile), { timeoutMs: 60_000 });
		const held = await inspectHolder(lockFile);
		if (held.lock && !isTakeable(held.verdict)) {
			logUpdateStep(`start: the lock is held by pid ${held.lock.pid} (${held.verdict})${opts.replace ? " — replacing it" : " — exiting"}`);
			if (!opts.replace) {
				clearScreen();
				printLogo(CLI_VERSION);
				for (const line of holderMessage(held.lock, held.verdict)) writeLine(`  ${line}`);
				writeLine("");
				// Not a failure (#1295): a launcher must not start this again, and ends cleanly on this code. An UNATTENDED
				// start keeps exit 1 — a restart after an update waits for the old runner to let go, and is retried (#1151).
				process.exit(unattended ? 1 : RUNNER_ALREADY_RUNNING_EXIT_CODE);
			}
			const replaced = await replaceHolder(held.lock, { now: opts.now === true });
			if (!replaced.ok) {
				clearScreen();
				printLogo(CLI_VERSION);
				for (const line of replaced.lines) writeLine(`  ${line}`);
				writeLine("");
				process.exit(1);
			}
			for (const line of replaced.lines) printStep(line, "ok");
		}

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

		if (opts.background) {
			const code = await startInBackground({ session, opts, runnerArgs: args, instances: state.instances, lockFile, watching: !opts.instance });
			process.exit(code);
		}

		// Supervised (#859): the child may exit asking for a restart after `runner_update` installed a new
		// CLI. {@link SUPERVISOR_RESTARTS} tells it this `pags up` restarts ITSELF on the new release (#860).
		const child = spawn(process.execPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			// The child is the lock HOLDER (#896): it owns the relay sockets, so it is what a
			// contender must find and what `--replace` must be able to stop.
			// No PAGS_TOKEN (#1163): the child reads session.json itself, so the account session is in no
			// environment its runtime and engines could inherit.
			env: { ...process.env, PAGS_TOKEN: undefined, [SUPERVISED_ENV]: SUPERVISOR_RESTARTS, PAGS_LOCK_ACCOUNT: session.user.login },
		});

		// The child's recent output, IN MEMORY ONLY and bounded at 200 lines (#1087): it feeds the
		// status line and the exit message, and dies with this process. It is deliberately not a
		// transcript — what must survive a crash is the crash REPORT, which the runtime and
		// `runner connect` write to disk themselves (`crash-reports.ts`), and the exit of this child,
		// recorded below.
		const logs: string[] = [];
		const relayLinks = new RelayLinks(state.instances.map((i) => i.id));
		/** Our child's own process id (#896), announced on its first status line. */
		let childRsid = "";

		// One splitter per stream (#1299): chunks are not lines, so a status line split across two reads used to be parsed as
		// two fragments and never recognised, and stdout's half-line must not be joined to stderr's.
		const handleLine = (line: string) => {
			{
				const trimmed = line.trim();
				if (!trimmed) return;

				logs.push(trimmed);
				if (logs.length > 200) logs.shift();

				// The child STATES its product-level facts; everything below is prose (#497).
				// Registration and the heartbeat used to be inferred from relay wording, which is
				// how a machine that registered nothing still showed a green ProAgentStore light.
				const rsidLine = trimmed.match(/^STATUS runner-session=(\S+)/);
				if (rsidLine) childRsid = rsidLine[1];
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
					return;
				}

				// The Secure link is the sum of the per-agent relays, from their own lifecycle lines (#1300): a disconnect takes
				// the light away, one agent of several is not "all", and a reconnect brings it back. The one-off "CONNECTED —
				// WebSocket relay" banner is printed whether or not any socket opened, so it no longer lights anything.
				const link = relayLinks.apply(trimmed);
				if (link) {
					state.tunnel = link.tunnel;
					state.tunnelNote = link.note;
					state.tunnelUrl = link.tunnel === "online" ? "WebSocket relay" : "";
					state.lastEvent = link.event;
					printStatus(state);
					return;
				}
				if (trimmed.includes("WebSocket relay")) return;

				if (trimmed.includes("browser runtime listening")) {
					state.runner = "online";
					state.lastEvent = "Runner started";
					printStatus(state);
					return;
				}
				// (Relay conflict / conflict cleared are lifecycle lines too: RelayLinks above says them, #497 / #1300.)

				// Show errors
				if (/error|Error|EADDRINUSE|ECONNREFUSED|failed|expired/i.test(trimmed)) {
					state.lastEvent = trimmed.slice(0, 80);
					printStatus(state);
				}
			}
		};

		let childDead = false;
		/** We are stopping the child ourselves (Ctrl-C) — its exit is not a crash. */
		let stopping = false;
		const stdoutLines = new LineSplitter();
		const stderrLines = new LineSplitter();
		const drain = () => {
			for (const line of [...stdoutLines.flush(), ...stderrLines.flush()]) handleLine(line);
		};
		child.stdout?.on("data", (data: Buffer) => { for (const line of stdoutLines.push(data)) handleLine(line); });
		child.stderr?.on("data", (data: Buffer) => { for (const line of stderrLines.push(data)) handleLine(line); });
		// The last line may have no newline: say it at the end of its stream, and before the exit is judged on `logs`.
		child.stdout?.on("end", () => { for (const line of stdoutLines.flush()) handleLine(line); });
		child.stderr?.on("end", () => { for (const line of stderrLines.flush()) handleLine(line); });
		const crashes = crashPaths(configDir(), session.user.login);
		const recordConnectExit = (code: number | null, signal: string | null, tail: string[]) => {
			recordChildExit({ paths: crashes, account: session.user.login, build: CLI_VERSION, kind: "connect_exit", what: "runner connect", code, signal, tail });
			void deliverCrashReports({ apiBase: API_BASE, token: session.token, account: session.user.login, paths: crashes }).catch(() => undefined);
		};
		child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
			drain();
			const action = runnerExitAction(code, stopping);
			if (action === "restart") {
				// `runner_update` installed a newer CLI and asked to be started again (#859) — not a crash. The WHOLE
				// `pags up` restarts, not only this child (#860). No prompt on the way back: nobody may be there.
				logUpdateStep("restart: runner connect asked for a restart (exit 75)");
				restartUp("Runner updated remotely — restarting pags up on the new version…", { PAGS_NO_PROMPT: "1" });
				return;
			}
			childDead = true;
			logUpdateStep(`runner connect ${signal ? `was killed by ${signal}` : `exited ${code}`}${stopping ? " (stopping)" : ""}`);
			if (action === "ignore") return;
			// A deliberate stop — `pags down`, or `--replace` from another terminal — ends `runner connect` with 0: this
			// `pags up` has nothing left to do, and leaves cleanly so its owner does not start it again.
			if (action === "stop") {
				clearScreen();
				writeLine("  Runner stopped (pags down, or replaced by another pags up).");
				process.exit(0);
			}
			// A healthy runner of this account already serves this machine (#1295): said once, nothing recorded or retried.
			if (action === "already-running") {
				clearScreen();
				printLogo(CLI_VERSION);
				for (const line of alreadyRunningLines()) writeLine(`  ${line}`);
				writeLine("");
				process.exit(0);
			}
			// It DIED — crashed, OOM-killed, killed by a signal (#896 F1: `code === null`). Record it with its last lines
			// (#1087), then hand it to this `pags up`'s restart owner (#1154). It used to redraw "Runner exited" and
			// stay up holding nothing, so neither the service supervisor nor a launcher ever noticed a dead runner.
			recordConnectExit(code, signal ?? null, logs.slice(-20));
			const recent = logs.slice(-5).at(-1);
			restartUp(`Runner ${signal ? `was killed by ${signal}` : `exited (code ${code})`}${recent ? `: ${recent.slice(0, 60)}` : ""} — starting it again…`, { PAGS_NO_PROMPT: "1" }, RUNNER_DIED_EXIT_CODE);
		});

		/**
		 * `pags up` again with the SAME flags, leaving no blocked ancestor behind (#1036): the service or
		 * restart command takes over, or this process stays as the one launcher that starts it on the same
		 * terminal and starts it again if it fails (#1151) — see `up-restart.ts`. Stdin is released first so
		 * the new process reads every keystroke.
		 */
		function restartUp(why: string, env: NodeJS.ProcessEnv = {}, exitCode?: number): never {
			writeLine(`  ${why}`);
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
			process.stdin.pause();
			restartPagsUp(restartUpArgs(opts), env, { ...processRestartDeps(), log: (line) => writeLine(`  ${line}`) }, { exitCode });
			process.exit(1); // unreachable: every path above exits this process
		}

		const shutdown = () => {
			stopping = true;
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
				// #896 F2: `r` ran `pags up` again, whose `pkill` killed whatever runner was live —
				// so two stale terminals took turns killing each other's runner. The restart now
				// goes through the lock like any other start, and refuses while somebody holds it.
				if (childDead) {
					const other = await inspectHolder(lockFile);
					if (other.lock && other.lock.rsid !== childRsid && !isTakeable(other.verdict)) {
						state.lastEvent = `Another \`pags up\` holds this machine (pid ${other.lock.pid}) — restart refused`;
						printStatus(state);
						continue;
					}
					restartUp("Restarting runner...");
				}
				printStatus(state);
			}
		}
	});

export const downCommand = new Command("down")
	.description("Stop the browser runner and disconnect")
	// #896: `pags down` stops THE LOCK HOLDER — this account's own runner on this machine — by
	// asking it to, through the same drain `--replace` uses. It used to `pkill -f` three name
	// patterns, which stopped any matching process of this OS user: another account's runner, a
	// deliberate scoped one, a service-managed one (restarted seconds later), and whatever work was
	// mid-flight. Windows had no such path at all, so `pags down` did nothing there; now it works
	// the same way everywhere, because asking a process to stop needs no signals (Q6).
	.option("--now", "Stop it even though work is running on it (that work is lost)")
	.action(async (opts: { now?: boolean }) => {
		clearScreen();
		printLogo(CLI_VERSION);
		const session = requireSession();
		const lock = readLock(lockPath(session.user.login));
		if (!lock) {
			writeLine("  No runner of yours is running on this machine — nothing to stop.");
			writeLine("");
			return;
		}
		const stopped = await replaceHolder(lock, { now: opts.now === true });
		if (stopped.ok) {
			// The holder releases its own lock on the way out; this clears a lock it left behind.
			releaseLock(lockPath(session.user.login), lock.rsid);
			writeLine("  ✓ Runner stopped — you're disconnected.");
			writeLine("");
			writeLine("  Your agent won't act on the web until you run 'pags up' again.");
		} else {
			for (const line of stopped.lines) writeLine(`  ${line}`);
		}
		writeLine("");
	});
