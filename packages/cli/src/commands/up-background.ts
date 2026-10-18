/**
 * `pags up --background` (#499): start the runner detached, prove it is up, and say how to see and
 * stop it. Reached only after `pags up` has done everything a foreground start does — discovery,
 * the pin rule, the #896 lock check and any `--replace` — so the background runner serves exactly
 * the agents a foreground one here would. See `background.ts` for what this mode is and is not.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { BACKGROUND_ENV, BACKGROUND_LOG_ENV, backgroundLogPath, backgroundRestartCommand, backgroundStatePath, spawnDetached, tailLines, waitForBackgroundHolder, writeBackgroundState } from "../background.js";
import { inspectHolder, pidAlive } from "../runner-lock.js";
import { writeLine } from "../output.js";
import { printStep } from "../tui.js";
import { RESTART_COMMAND_ENV, restartUpArgs } from "./runner/self-update.js";

export interface BackgroundStart {
	session: { token: string; user: { login: string } };
	opts: { headless?: boolean; instance?: string; force?: boolean };
	/** `[cliPath, "runner", "connect", ...ids, ...flags]` — exactly what the foreground child runs. */
	runnerArgs: string[];
	instances: Array<{ id: string; name: string }>;
	lockFile: string;
	watching: boolean;
}

export interface BackgroundDeps {
	env: NodeJS.ProcessEnv;
	execPath: string;
	platform: NodeJS.Platform;
	spawn: typeof nodeSpawn;
	alive: (pid: number) => boolean;
	inspect: typeof inspectHolder;
	timeoutMs?: number;
	log: (line: string) => void;
	step: (text: string, status: "ok" | "wait" | "fail") => void;
}

const processDeps = (): BackgroundDeps => ({
	env: process.env,
	execPath: process.execPath,
	platform: process.platform,
	spawn: nodeSpawn,
	alive: pidAlive,
	inspect: inspectHolder,
	log: (line) => writeLine(line),
	step: printStep,
});

/** Start it and wait for proof. Returns the exit code for `pags up`: 0 running, 1 not. */
export async function startInBackground(start: BackgroundStart, deps: BackgroundDeps = processDeps()): Promise<number> {
	const account = start.session.user.login;
	const logPath = backgroundLogPath(account, deps.env);
	const upArgs = restartUpArgs(start.opts);
	// Deliberately NOT the supervisor flag the foreground child gets: nothing here waits on this
	// process. A remote update restarts it through the restart command instead (#860's `command`).
	const env: NodeJS.ProcessEnv = {
		...deps.env,
		PAGS_LOCK_ACCOUNT: account,
		[BACKGROUND_ENV]: "1",
		[BACKGROUND_LOG_ENV]: logPath,
		[RESTART_COMMAND_ENV]: backgroundRestartCommand(deps.execPath, start.runnerArgs[0], upArgs, deps.platform),
	};
	delete env.PAGS_UP_SUPERVISED;
	// The runner reads session.json itself (#1163): the account session is in no environment it, its runtime or its engines inherit.
	delete env.PAGS_TOKEN;

	deps.step("Starting the runner in the background…", "wait");
	const pid = spawnDetached(deps.execPath, start.runnerArgs, env, logPath, deps.spawn);
	writeBackgroundState(backgroundStatePath(account, deps.env), {
		v: 1,
		pid,
		startedAt: Date.now(),
		logPath,
		args: [...upArgs, "--background"],
		instances: start.instances,
		watching: start.watching,
	});

	const outcome = await waitForBackgroundHolder(pid, () => deps.inspect(start.lockFile), deps.alive, { timeoutMs: deps.timeoutMs });
	if (outcome === "live") {
		deps.step(`Running in the background (pid ${pid}) — this terminal can be closed`, "ok");
		deps.log("");
		deps.log(`  Serving ${start.instances.length} agent${start.instances.length === 1 ? "" : "s"}${start.watching ? ", and attaching newly eligible ones" : ""}.`);
		deps.log("  It keeps running until `pags down`, a reboot, or logging out — it does not start by itself.");
		deps.log("");
		deps.log("    pags status   — is it running, and what is it serving");
		deps.log(`    pags logs     — its output (${logPath})`);
		deps.log("    pags down     — stop it");
		deps.log("");
		return 0;
	}
	deps.step(outcome === "exited" ? "The background runner stopped before it was ready" : "The background runner did not confirm it was ready", "fail");
	for (const line of tailLines(logPath, 10) ?? []) deps.log(`    ${line}`);
	deps.log("");
	deps.log(outcome === "exited" ? "  Fix what the log says, then `pags up --background` again." : `  It may still be starting (pid ${pid}): check \`pags status\`, or stop it with \`pags down\`.`);
	deps.log("");
	return 1;
}
