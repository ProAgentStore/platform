// `pags watchdog` — the always-on control channel (#1320). `run` is what the OS service executes; `install` / `uninstall` manage that
// service; `status` says what this machine's watchdog knows. See watchdog/core.ts for what it does and why it is separate from `pags up`.
import { createRequire } from "node:module";
import { Command } from "commander";
import { CapabilityReporter } from "../capabilities/detect.js";
import { loadMachineIdentity } from "../machine.js";
import { writeError, writeLine } from "../output.js";
import { serviceContext } from "../service-context.js";
import { installWatchdogService, uninstallWatchdogService, watchdogLogPath } from "../service-install.js";
import { runWatchdogLoop, type WatchdogLink } from "../watchdog/core.js";
import { payloadFacts, realWatchdogDeps, runnerFromLocks } from "../watchdog/local.js";
import { sessionToken } from "./runner/session-token.js";
import { apiPathSegment, requestPags } from "./runner/http.js";

const CLI_VERSION: string = (() => {
	try {
		return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
	} catch {
		return "";
	}
})();

const stamp = (line: string) => process.stdout.write(`[${new Date().toISOString()}] watchdog: ${line}\n`);

/** The platform end of the loop: this machine's id, the account's sign-in, and a bounded request per beat. */
export function platformLink(sleep: (ms: number) => Promise<void>, stopped: () => boolean): WatchdogLink {
	return {
		sleep,
		stopped,
		beat: async (body) => {
			const token = sessionToken();
			if (!token) throw new Error("not signed in — run `pags login` on this machine");
			const id = loadMachineIdentity().id;
			if (!id) throw new Error("this machine has no identity yet — run `pags up` once so it is registered");
			return requestPags("POST", `/v1/terminals/machines/${apiPathSegment(id)}/watchdog/heartbeat`, { pagsToken: token }, body, AbortSignal.timeout(30_000));
		},
	};
}

const runCommand = new Command("run").description("Run the watchdog in the foreground (what the service executes)").action(async () => {
	let stop = false;
	const wake: Array<() => void> = [];
	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, () => {
			stop = true;
			for (const w of wake.splice(0)) w();
		});
	}
	const sleep = (ms: number) => new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		wake.push(() => {
			clearTimeout(t);
			resolve();
		});
	});
	stamp(`started (CLI ${CLI_VERSION || "unknown"}, Node ${process.versions.node})`);
	const deps = realWatchdogDeps(stamp, serviceContext(), CLI_VERSION);
	await runWatchdogLoop(deps, platformLink(sleep, () => stop), new CapabilityReporter());
	stamp("stopped");
});

const installCommand = new Command("install").description("Install the watchdog as an OS service that keeps running without `pags up`").action(() => {
	if (!sessionToken()) {
		writeError("Sign in first (`pags login`): the watchdog runs as this user, on this sign-in.");
		process.exitCode = 1;
		return;
	}
	const result = installWatchdogService(serviceContext());
	for (const line of result.lines) writeLine(line);
	if (!result.ok) process.exitCode = 1;
});

const uninstallCommand = new Command("uninstall").description("Remove the watchdog service").action(() => {
	for (const line of uninstallWatchdogService(serviceContext()).lines) writeLine(line);
});

const statusCommand = new Command("status").description("What this machine's watchdog can see locally").action(() => {
	const p = payloadFacts();
	const r = runnerFromLocks();
	writeLine(`  CLI ${CLI_VERSION || "unknown"} · cached ${p.versions.join(", ") || "none"}${p.trial ? ` · ${p.trial.version} on trial` : ""}`);
	writeLine(`  runner: ${r.alive ? `alive (${r.launch ?? "?"}${r.uptimeSec !== null ? `, up ${r.uptimeSec}s` : ""})` : "not running"}`);
	for (const [v, why] of Object.entries(p.bad)) writeLine(`  given up on ${v}: ${why}`);
	writeLine(`  log: ${watchdogLogPath(serviceContext())}`);
});

export const watchdogCommand = new Command("watchdog")
	.description("The always-on control channel: updates, restarts and rolls back pags even when `pags up` is not running")
	.addCommand(runCommand)
	.addCommand(installCommand)
	.addCommand(uninstallCommand)
	.addCommand(statusCommand);
