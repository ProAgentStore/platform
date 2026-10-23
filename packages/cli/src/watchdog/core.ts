/**
 * The watchdog (#1320): the always-on control channel.
 *
 * `pags up` is the runner. It can crash, wedge, be mid-rollback, or never have started — and while it is any of those it cannot be asked
 * to update, restart or roll back (`runner_update` needs its relay). The watchdog is a SECOND, tiny service on the machine with its own
 * heartbeat to the platform, so none of that stops it. Each beat it reports what it can see (versions, whether a runner is alive, crash
 * count, last error, load, disk, any trial or rollback) and the capability record, and the answer carries the commands the owner queued.
 *
 * The commands are a CLOSED set — status, update, restart, rollback, diagnose(check) — with validated arguments. There is no command line,
 * no shell and no path anywhere in the protocol; `diagnose` reads from a fixed list. Everything that touches the machine goes through
 * {@link WatchdogDeps}, so every behaviour here is tested without a service manager, a network or a real install.
 */
import type { CapabilityReporter, MachineCapabilities } from "../capabilities/detect.js";

export const WATCHDOG_HEARTBEAT_MS = 30_000;
/** After a command ran, beat again soon so its result reaches the owner quickly. */
export const WATCHDOG_AFTER_COMMAND_MS = 2_000;
export const WATCHDOG_BACKOFF_MIN_MS = 5_000;
export const WATCHDOG_BACKOFF_MAX_MS = 300_000;
export const COMMAND_TIMEOUT_MS = 10 * 60_000;
export const DIAGNOSE_CHECKS = ["disk", "node", "payloads", "runner", "service", "log_tail"] as const;
export type DiagnoseCheck = (typeof DIAGNOSE_CHECKS)[number];
export type WatchdogKind = "status" | "update" | "restart" | "rollback" | "diagnose";

export interface WatchdogCommand {
	id: string;
	kind: WatchdogKind;
	args: Record<string, string>;
}
export interface CommandResult {
	id: string;
	state: "done" | "failed";
	detail: string;
}

export interface PayloadFacts {
	/** Versions in the cache, newest first. */
	versions: string[];
	/** Versions given up on, with why. */
	bad: Record<string, string>;
	trial: { version: string; previous: string | null; starts: number } | null;
	rollback: { from: string; to: string | null; reason: string } | null;
}

export interface WatchdogStatusBody {
	version: string | null;
	uptimeSec: number;
	runner: { alive: boolean; uptimeSec: number | null };
	running: string | null;
	payloads: string[];
	trial: { version: string; startsLeft: number | null } | null;
	rollback: { from: string; to: string | null; reason: string } | null;
	crashes24h: number | null;
	lastError: string | null;
	cpuLoad1: number | null;
	memUsedPct: number | null;
	diskUsedPct: number | null;
	nodeVersion: string | null;
	service: "launchd" | "systemd" | "scheduled-task" | "unmanaged";
}

export interface WatchdogDeps {
	now: () => number;
	startedAt: number;
	/** This process's own CLI version. */
	version: string;
	nodeVersion: string;
	/** What the cache holds. */
	payloads: () => PayloadFacts;
	/** Is a `pags up` runner alive, and for how long. */
	runner: () => { alive: boolean; uptimeSec: number | null };
	/** Restarts and crashes the service manager's log shows in the last 24 hours, and the last failure line. */
	history: () => { crashes24h: number | null; lastError: string | null };
	machine: () => { cpuLoad1: number | null; memUsedPct: number | null; diskUsedPct: number | null; diskFreeGb: number | null };
	service: () => WatchdogStatusBody["service"];
	/** Bring the runner back on whatever version the cache says is newest. Resolves with one sentence. Rejects with the reason. */
	restartRunner: () => Promise<string>;
	/** The newest published release, or null (and why) when npm cannot be asked. */
	latestRelease: () => Promise<{ version: string } | { error: string }>;
	/** Fetch `version` into the cache beside the others (all-or-nothing, pre-flighted) and put it on trial. Rejects with the reason. */
	install: (version: string, previous: string | null) => Promise<void>;
	/** Give `version` up so the cache falls back to `to`. */
	markBad: (version: string, reason: string, to: string | null) => void;
	logTail: () => string;
	serviceDescription: () => string;
	log: (line: string) => void;
}

const ver = /^\d+\.\d+\.\d+/;
const older = (a: string, b: string): boolean => {
	const p = (v: string) => v.split(/[-+]/)[0].split(".").map((x) => Number.parseInt(x, 10) || 0);
	const [x, y] = [p(a), p(b)];
	for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
	return false;
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(-300);

export function collectStatus(d: WatchdogDeps): WatchdogStatusBody {
	const p = d.payloads();
	const m = d.machine();
	const h = d.history();
	const live = p.versions.filter((v) => !p.bad[v]);
	return {
		version: d.version || null,
		uptimeSec: Math.max(0, Math.round((d.now() - d.startedAt) / 1000)),
		runner: d.runner(),
		running: live[0] ?? null,
		payloads: p.versions.filter((_, i) => i < 5),
		trial: p.trial ? { version: p.trial.version, startsLeft: Math.max(0, 6 - p.trial.starts) } : null,
		rollback: p.rollback,
		crashes24h: h.crashes24h,
		lastError: h.lastError,
		cpuLoad1: m.cpuLoad1,
		memUsedPct: m.memUsedPct,
		diskUsedPct: m.diskUsedPct,
		nodeVersion: d.nodeVersion || null,
		service: d.service(),
	};
}

async function update(c: WatchdogCommand, d: WatchdogDeps): Promise<string> {
	const p = d.payloads();
	const live = p.versions.filter((v) => !p.bad[v]);
	const current = live[0] ?? d.version;
	let target = c.args.version;
	if (!target) {
		const latest = await d.latestRelease();
		if ("error" in latest) throw new Error(`npm could not be asked for the latest release: ${latest.error}`);
		target = latest.version;
	}
	if (!ver.test(target)) throw new Error(`"${target.slice(0, 40)}" is not a release number`);
	if (p.bad[target]) throw new Error(`${target} was installed here and rolled back (${p.bad[target]}); it is never installed again. Wait for a newer release.`);
	if (!older(current, target) && !c.args.version) return `already on ${current}, the latest release`;
	if (current === target) return `already on ${target}`;
	// Side by side, pre-flighted, all-or-nothing, on trial: a failure here leaves the machine exactly as it was.
	await d.install(target, current);
	const runner = d.runner();
	if (!runner.alive) {
		const restarted = await d.restartRunner();
		return `installed ${target} beside ${current} (on trial); the runner was not running, so it was started: ${restarted}`;
	}
	// A live runner is never cut off by an update: it takes the new release at its next restart (its own idle-aware update, or a restart command).
	return `installed ${target} beside ${current} (on trial). The runner is running ${current} and picks ${target} up at its next restart; send restart to switch now.`;
}

async function rollback(d: WatchdogDeps): Promise<string> {
	const p = d.payloads();
	const live = p.versions.filter((v) => !p.bad[v]);
	if (live.length < 2) throw new Error(live.length ? `only ${live[0]} is cached, so there is nothing to roll back to` : "no version is cached");
	const [from, to] = live;
	d.markBad(from, "rolled back by the owner's command", to);
	const restarted = await d.restartRunner();
	return `rolled back from ${from} to ${to} (${from} will not be installed again); ${restarted}`;
}

function diagnose(check: string, d: WatchdogDeps): string {
	switch (check) {
		case "disk": {
			const m = d.machine();
			return `disk ${m.diskUsedPct ?? "?"}% used, ${m.diskFreeGb ?? "?"} GB free; memory ${m.memUsedPct ?? "?"}% used; load ${m.cpuLoad1 ?? "?"}`;
		}
		case "node":
			return `Node ${d.nodeVersion}`;
		case "payloads": {
			const p = d.payloads();
			return `cached ${p.versions.join(", ") || "none"}${Object.keys(p.bad).length ? `; given up on ${Object.entries(p.bad).map(([v, w]) => `${v} (${w})`).join("; ")}` : ""}${p.trial ? `; ${p.trial.version} on trial (started ${p.trial.starts}×)` : ""}`;
		}
		case "runner": {
			const r = d.runner();
			const h = d.history();
			return `${r.alive ? `runner alive${r.uptimeSec !== null ? `, up ${r.uptimeSec}s` : ""}` : "runner not running"}; ${h.crashes24h ?? "?"} restart(s) in 24h${h.lastError ? `; last error: ${h.lastError}` : ""}`;
		}
		case "service":
			return d.serviceDescription();
		case "log_tail":
			return d.logTail();
		default:
			throw new Error(`"${check.slice(0, 30)}" is not a diagnostic this watchdog runs (${DIAGNOSE_CHECKS.join(", ")})`);
	}
}

/** Run one command. Never throws: the outcome is the result. */
export async function executeCommand(c: WatchdogCommand, d: WatchdogDeps): Promise<CommandResult> {
	d.log(`command ${c.id.slice(0, 8)}: ${c.kind}${Object.keys(c.args).length ? ` ${JSON.stringify(c.args)}` : ""}`);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const work = (async () => {
			switch (c.kind) {
				case "status":
					return `reported: ${JSON.stringify(collectStatus(d))}`.slice(0, 1500);
				case "update":
					return update(c, d);
				case "restart":
					return `restarted: ${await d.restartRunner()}`;
				case "rollback":
					return rollback(d);
				case "diagnose":
					return diagnose(c.args.check ?? "", d);
				default:
					throw new Error(`"${String(c.kind).slice(0, 30)}" is not a command this watchdog runs`);
			}
		})();
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`timed out after ${COMMAND_TIMEOUT_MS / 60_000} minutes`)), COMMAND_TIMEOUT_MS);
		});
		const detail = await Promise.race([work, timeout]);
		d.log(`command ${c.id.slice(0, 8)}: done — ${detail.slice(0, 200)}`);
		return { id: c.id, state: "done", detail: detail.slice(0, 1500) };
	} catch (e) {
		d.log(`command ${c.id.slice(0, 8)}: FAILED — ${msg(e)}`);
		return { id: c.id, state: "failed", detail: msg(e) };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface WatchdogLink {
	/** One heartbeat to the platform. Rejects when it cannot be sent. */
	beat: (body: { status: WatchdogStatusBody; results: CommandResult[]; capabilityHash?: string; capabilities?: MachineCapabilities }) => Promise<{ commands?: WatchdogCommand[]; capabilitiesStored?: boolean; capabilitiesWanted?: boolean }>;
	sleep: (ms: number) => Promise<void>;
	/** True once the loop should end (a signal, or a test). */
	stopped: () => boolean;
}

/** The loop: beat, run what came back, beat again soon with the results; back off when the platform cannot be reached. Never throws. */
export async function runWatchdogLoop(d: WatchdogDeps, link: WatchdogLink, reporter: Pick<CapabilityReporter, "payload" | "accept">): Promise<void> {
	let pending: CommandResult[] = [];
	let backoff = WATCHDOG_BACKOFF_MIN_MS;
	let failing = false;
	while (!link.stopped()) {
		let wait = WATCHDOG_HEARTBEAT_MS;
		try {
			const answer = await link.beat({ status: collectStatus(d), results: pending, ...reporter.payload() });
			pending = [];
			backoff = WATCHDOG_BACKOFF_MIN_MS;
			if (failing) {
				failing = false;
				d.log("the platform is reachable again");
			}
			reporter.accept(answer as Record<string, unknown>);
			for (const c of (answer.commands ?? []).filter((_, i) => i < 3)) {
				pending.push(await executeCommand(c, d));
				wait = WATCHDOG_AFTER_COMMAND_MS;
			}
		} catch (e) {
			// Results not delivered stay pending for the next beat; the wait doubles up to five minutes.
			if (!failing) d.log(`cannot reach the platform: ${msg(e)}`);
			failing = true;
			wait = backoff;
			backoff = Math.min(backoff * 2, WATCHDOG_BACKOFF_MAX_MS);
		}
		await link.sleep(wait);
	}
}
