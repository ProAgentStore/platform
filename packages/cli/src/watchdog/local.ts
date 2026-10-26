/**
 * The watchdog's real hands (#1320): the payload cache, the runner lock, the service manager and the log, behind {@link WatchdogDeps}.
 * Everything here is best-effort and bounded; none of it can throw into the loop.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BOOTSTRAP_ENV, cachedPayloads, latestPublishedRelease, olderThan, payloadRoot } from "../bootstrap/payload.js";
import { activatePayload, badVersions, markBad, peekRollbackNotice, readTrial } from "../bootstrap/trial.js";
import { installVersion } from "../commands/runner/self-update.js";
import { sampleMemAvailable } from "../commands/runner/resources.js";
import { configDir, lockDir, pidAlive, readLock } from "../runner-lock.js";
import { serviceContext } from "../service-context.js";
import { runnerServiceRestart, serviceLogPath, servicePlan, type ServiceContext } from "../service-install.js";
import type { PayloadFacts, WatchdogDeps } from "./core.js";
import { scrubText } from "./scrub.js";

const run = promisify(execFile);
const LOG_TAIL_LINES = 30;
const LOG_TAIL_CHARS = 4_000;

export function payloadFacts(root: string = payloadRoot()): PayloadFacts {
	const versions = cachedPayloads(root)
		.map((p) => p.version)
		.sort((a, b) => (olderThan(a, b) ? 1 : -1));
	const trial = readTrial(root);
	const notice = peekRollbackNotice(root);
	return {
		versions,
		bad: badVersions(root),
		trial: trial ? { version: trial.version, previous: trial.previous, starts: trial.starts } : null,
		rollback: notice ? { from: notice.from, to: notice.to, reason: notice.reason } : null,
	};
}

/** A live `pags up` runner, from the account locks in the machine's config folder. */
export function runnerFromLocks(dir: string = lockDir(), now = Date.now()): { alive: boolean; uptimeSec: number | null; launch: string | null } {
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((n) => /^up-.*\.lock$/.test(n));
	} catch {
		return { alive: false, uptimeSec: null, launch: null };
	}
	for (const n of names) {
		const lock = readLock(join(dir, n));
		if (lock && pidAlive(lock.pid)) return { alive: true, uptimeSec: Math.max(0, Math.round((now - lock.startedAt) / 1000)), launch: lock.launch };
	}
	return { alive: false, uptimeSec: null, launch: null };
}

/** Restarts the service manager's log shows in the last 24 hours (the supervisor writes one `exited (…)` line per death), and the last failure line. */
export function logHistory(logPath: string, now = Date.now()): { crashes24h: number | null; lastError: string | null } {
	let text: string;
	try {
		text = readFileSync(logPath, "utf-8").slice(-200_000);
	} catch {
		return { crashes24h: null, lastError: null };
	}
	let crashes = 0;
	let last: string | null = null;
	for (const line of text.split(/\r?\n/)) {
		const m = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] supervisor: (.*)$/.exec(line);
		if (!m) continue;
		const at = Date.parse(m[1]);
		if (!Number.isFinite(at) || now - at > 86_400_000) continue;
		// Exit code 75 is an asked-for restart (an update), not a crash.
		if (/pags up exited \(/.test(m[2]) && !/exited \(75\)/.test(m[2])) {
			crashes++;
			last = m[2];
		} else if (/could not start/.test(m[2])) last = m[2];
	}
	return { crashes24h: crashes, lastError: last ? scrubText(last, 200) : null };
}

export function tailOf(logPath: string): string {
	try {
		const lines = readFileSync(logPath, "utf-8").slice(-20_000).split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL_LINES);
		// Scrub the whole tail first, then keep the NEWEST characters: the end of a log is what explains a crash.
		const clean = scrubText(lines.map((l) => l.slice(0, 200)).join("\n"), Number.MAX_SAFE_INTEGER);
		return (clean.length > LOG_TAIL_CHARS ? `…${clean.slice(-(LOG_TAIL_CHARS - 1))}` : clean) || "(the log is empty)";
	} catch {
		return "(no runner log on this machine)";
	}
}

function serviceInstalled(ctx: ServiceContext): boolean {
	const plan = servicePlan(ctx);
	return plan.files.slice(1).some((f) => existsSync(f.path));
}

export function realWatchdogDeps(log: (line: string) => void, ctx: ServiceContext = serviceContext(), version = ""): WatchdogDeps {
	const logPath = serviceLogPath(ctx);
	const kind = (): ReturnType<WatchdogDeps["service"]> => (serviceInstalled(ctx) ? (servicePlan(ctx).kind as ReturnType<WatchdogDeps["service"]>) : "unmanaged");
	return {
		now: () => Date.now(),
		startedAt: Date.now(),
		version,
		nodeVersion: process.versions.node,
		payloads: () => payloadFacts(),
		runner: () => {
			const r = runnerFromLocks();
			return { alive: r.alive, uptimeSec: r.uptimeSec };
		},
		history: () => logHistory(logPath),
		machine: () => {
			let disk: { used: number | null; free: number | null } = { used: null, free: null };
			try {
				const s = statfsSync(configDir());
				const total = s.blocks * s.bsize;
				disk = { used: total ? Math.round(((total - s.bavail * s.bsize) / total) * 100) : null, free: Math.round((s.bavail * s.bsize) / 2 ** 30) };
			} catch {
				// unknown
			}
			const total = os.totalmem();
			const avail = sampleMemAvailable() ?? os.freemem();
			return {
				cpuLoad1: process.platform === "win32" ? null : Math.round(os.loadavg()[0] * 10) / 10,
				memUsedPct: total ? Math.round(((total - avail) / total) * 100) : null,
				diskUsedPct: disk.used,
				diskFreeGb: disk.free,
			};
		},
		service: kind,
		restartRunner: async () => {
			const r = runnerFromLocks();
			if (!serviceInstalled(ctx)) {
				throw new Error(r.alive ? "the runner is running but was not started by a service (launch: " + (r.launch ?? "unknown") + "), so stopping it would not bring it back; restart it by hand or run `pags up --install-service`" : "no service manager is installed for the runner, so there is nothing to start it with; run `pags up --install-service` on the machine");
			}
			const c = runnerServiceRestart(ctx);
			try {
				await run(c.file, c.args, { timeout: 60_000 });
			} catch (e) {
				throw new Error(`${c.why} failed: ${scrubText(String((e as { stderr?: unknown }).stderr ?? "") || (e instanceof Error ? e.message : String(e)), 200)}`);
			}
			return `${c.why}: ok`;
		},
		latestRelease: async () => {
			const r = await latestPublishedRelease();
			return "version" in r ? { version: r.version } : { error: String((r as { error?: unknown }).error ?? "npm did not answer") };
		},
		install: async (version, previous) => {
			await installVersion(version, previous);
			if (process.env[BOOTSTRAP_ENV]) activatePayload(payloadRoot(), version);
		},
		markBad: (v, reason, to) => markBad(payloadRoot(), v, reason, to),
		logTail: () => tailOf(logPath),
		serviceDescription: () => `${kind()}${serviceInstalled(ctx) ? " (runner service installed)" : " (no runner service installed)"}`,
		log,
	};
}
