import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * The machine's resource sample, sent on the runner heartbeat (#924).
 *
 * Taken once per 30s heartbeat, no timer of its own, so the platform can say whether a machine was
 * out of CPU, memory or disk when its relay went quiet. The machine reading is in-process (`os`,
 * `statfs`); the per-session split comes from the local runner's one `ps` per beat. The platform
 * validates, stores (two-tier history) and interprets it (`workers/api/src/lib/runner-resources.ts`).
 */
export interface ResourceSample {
	/** null on Windows (#1258): `os.loadavg()` returns [0,0,0] there, which is "no load average", not an idle machine. */
	loadAvg: [number, number, number] | null;
	cpus: number;
	memTotalBytes: number;
	memFreeBytes: number;
	/**
	 * Memory a new process could actually use (#1275). On macOS `memFreeBytes` is only never-used pages — the kernel keeps
	 * inactive, purgeable and speculative pages that it hands over at once — so a healthy Mac reads 95%+ used; this is free +
	 * inactive + purgeable + speculative from `vm_stat`. Absent where it is not measured (the platform then judges `memFreeBytes`).
	 */
	memAvailableBytes?: number;
	platform: string;
	sampledAt: number;
	/** What commands on this machine run against (#405) — read once per beat from `os`/`process`, nothing executed. */
	host?: HostSample;
	/** The volume holding the checkouts (#924) — a full disk or inode table fails clones and writes. */
	disk?: DiskSample;
	/** This runner process: how long it has run and how often it has started lately (#924). */
	runner?: RunnerProcessSample;
	/** Round trip of one relay probe, ms — slow vs stuck. Null when this beat's probe got no echo. */
	relayRttMs?: number | null;
	/** What the local runtime's own `/health` answered this beat (#1167) — the pong and the heartbeat are the CLI's, not the runtime's. */
	runtime?: RuntimeHealthSample;
	/** Per-session CPU and memory, engine plus descendants. Absent when it could not be read. */
	sessions?: Array<{ sessionId: string; engineLabel: string; pid: number; processes: number; rssBytes: number; cpuPct: number }>;
}

/** The machine facts a caller needs before writing a command: CPU architecture, the default shell, the home directory, the Node version. */
export interface HostSample {
	arch: string;
	/** `bash`, `zsh`, `powershell`, `cmd` … — `msys-bash` for a POSIX shell under Windows. null when none can be told. */
	shell: string | null;
	home: string | null;
	node: string;
}

export interface RuntimeHealthSample {
	ok: boolean;
	/** Round trip of the probe, ms; null when it never got an answer. */
	latencyMs: number | null;
	/** Why not, in a few words — a timeout, a refused connection or the HTTP status. */
	error?: string;
	checkedAt: number;
}

/** How long the runtime gets to answer `/health` before it reads as wedged. A healthy one answers in milliseconds. */
export const RUNTIME_HEALTH_TIMEOUT_MS = 4000;

/**
 * Ask the local runtime — the child that executes commands — whether it is alive (#1167). `fetch` and `now` are parameters so the
 * three answers (healthy, a bad status, no answer) are tested without a server. Never throws: failing to answer IS the reading.
 */
export async function probeRuntimeHealth(localUrl: string, token: string, doFetch: typeof fetch = fetch, now: () => number = Date.now): Promise<RuntimeHealthSample> {
	const started = now();
	try {
		const res = await doFetch(`${localUrl.replace(/\/$/, "")}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(RUNTIME_HEALTH_TIMEOUT_MS) });
		const latencyMs = now() - started;
		return res.ok ? { ok: true, latencyMs, checkedAt: started } : { ok: false, latencyMs, error: `HTTP ${res.status}`, checkedAt: started };
	} catch (e) {
		const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
		return { ok: false, latencyMs: null, error: timedOut ? `no answer in ${RUNTIME_HEALTH_TIMEOUT_MS / 1000}s` : e instanceof Error ? e.message.split("\n")[0] : "unreachable", checkedAt: started };
	}
}

export interface DiskSample {
	path: string;
	totalBytes: number;
	freeBytes: number;
	inodesTotal: number;
	inodesFree: number;
}

export interface RunnerProcessSample {
	startedAt: number;
	/**
	 * This runner PROCESS's id from the single-instance lock (#896), when it holds one.
	 *
	 * The server cannot otherwise tell two runners on one machine apart: heartbeats, registrations
	 * and relay sockets all carried only (instance, node), so three `pags up` processes looked
	 * exactly like one. With this, a duplicate can be NAMED rather than merely suspected.
	 */
	rsid?: string;
	pid?: number;
	/** `tty` | `tmux` | `service` | `headless` — so the fix can say where the other one is. */
	launch?: string;
	/** What starts the runner again if it dies (#1154): the OS `service`, a `pags up` `launcher`, or `none`. */
	supervisor?: "service" | "launcher" | "none";
	/** When this runner's sign-in expires, ms (#1157) — refreshed while it runs; a date close by means it could not be. */
	sessionExpiresAt?: number;
	uptimeSec: number;
	/** Process starts on this machine in the last 24h, this one included — a crash loop shows here. */
	starts24h: number;
	/** Relay sockets re-opened since this process started. */
	relayReconnects: number;
}

/** Where coding checkouts live — the runner's managed repos dir (`CodingRuntime`'s default). */
export const CHECKOUT_ROOT = join(os.homedir(), ".config", "proagentstore", "repos");

/**
 * `statfs` of the checkout volume, or the home directory before any checkout exists. Null when the
 * platform cannot answer (no `statfs`, or a path it refuses) — reported as absent, never as empty.
 */
export function sampleDisk(path: string = CHECKOUT_ROOT, statfs: typeof statfsSync = statfsSync): DiskSample | null {
	for (const p of [path, os.homedir()]) {
		try {
			const s = statfs(p);
			return { path: p, totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize), inodesTotal: Number(s.files), inodesFree: Number(s.ffree) };
		} catch {
			// The checkout root does not exist yet on a fresh machine; the home volume is the next answer.
		}
	}
	return null;
}

/**
 * Available memory from `vm_stat` output (#1275): the pages a new process can have without the machine swapping —
 * free, inactive, purgeable and speculative — times the page size the header states. Null when the output is not
 * `vm_stat`'s, so a changed format reads as "not measured" rather than as zero.
 */
export function parseVmStat(text: string): number | null {
	const size = /page size of (\d+) bytes/.exec(text);
	const pageSize = size ? Number(size[1]) : 0;
	if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
	const pages = (label: string): number | null => {
		const m = new RegExp(`^Pages ${label}:\\s+(\\d+)`, "m").exec(text);
		return m ? Number(m[1]) : null;
	};
	const free = pages("free");
	const inactive = pages("inactive");
	if (free === null || inactive === null) return null;
	return (free + inactive + (pages("purgeable") ?? 0) + (pages("speculative") ?? 0)) * pageSize;
}

/** Available memory on macOS, or null on any other platform or when `vm_stat` cannot be read. Takes the command as a parameter so it is tested without a Mac. */
export function sampleMemAvailable(platform: string = os.platform(), run: (file: string, args: string[]) => string = (file, args) => execFileSync(file, args, { encoding: "utf-8", timeout: 2000 })): number | null {
	if (platform !== "darwin") return null;
	try {
		const bytes = parseVmStat(run("vm_stat", []));
		return bytes !== null && Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
	} catch {
		return null;
	}
}

/** The file that remembers this machine's recent runner starts. */
export const STARTS_FILE = join(os.homedir(), ".config", "proagentstore", "runner-starts.json");

/**
 * Record this process's start and count the starts in the last 24h (#924). A runner that crash-loops
 * restarts with a fresh uptime every time, so uptime alone would read as "healthy, just started";
 * the count across restarts is what shows the loop. Never throws: an unwritable file costs the count.
 */
export function recordRunnerStart(now: number = Date.now(), file: string = STARTS_FILE): number {
	let starts: number[] = [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
		if (Array.isArray(parsed)) starts = parsed.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
	} catch {
		// No history yet (or unreadable) — this start is the first one we know of.
	}
	starts = [...starts.filter((t) => now - t < 24 * 60 * 60 * 1000), now].slice(-200);
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(starts));
	} catch {
		// Unwritable config dir: the count still covers this process's own start.
	}
	return starts.length;
}

/**
 * The default shell commands on this machine run under (#405), from the environment alone — no process is started.
 * A POSIX shell reported on Windows (Git Bash / MSYS sets `SHELL`) is `msys-<name>`: its paths and PATH separator are
 * POSIX but the machine is not, which is exactly the distinction a caller guessing `which` vs `where` needs.
 */
export function defaultShell(platform: string, env: NodeJS.ProcessEnv = process.env, userShell: () => string | null = () => { try { return os.userInfo().shell; } catch { return null; } }): string | null {
	const name = (path: string | null | undefined): string | null => {
		const b = basename((path ?? "").replace(/\\/g, "/")).replace(/\.exe$/i, "").toLowerCase();
		return b || null;
	};
	if (platform === "win32") {
		const posix = name(env.SHELL);
		if (posix) return `msys-${posix}`;
		return name(env.COMSPEC) ?? "cmd";
	}
	return name(env.SHELL) ?? name(userShell());
}

/** The host block for one beat. Every read is guarded: an unreadable home or shell is absent, never a throw that loses the whole sample. */
export function sampleHost(read: Pick<typeof os, "arch" | "homedir" | "platform"> = os, env: NodeJS.ProcessEnv = process.env, nodeVersion: string = process.version): HostSample {
	let home: string | null = null;
	try {
		home = read.homedir() || null;
	} catch {
		home = null;
	}
	return { arch: read.arch(), shell: defaultShell(read.platform(), env), home, node: nodeVersion };
}

export function sampleResources(
	read: Pick<typeof os, "loadavg" | "cpus" | "totalmem" | "freemem" | "platform"> & Partial<Pick<typeof os, "arch" | "homedir">> = os,
	now: number = Date.now(),
	extra: Pick<ResourceSample, "disk" | "runner" | "relayRttMs" | "sessions" | "memAvailableBytes" | "runtime"> = {},
): ResourceSample {
	const platform = read.platform();
	// Windows has no load average: report that, rather than the [0,0,0] Node returns, which reads as a quiet machine (#1258).
	const [l1 = 0, l5 = 0, l15 = 0] = platform === "win32" ? [] : read.loadavg();
	return {
		...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
		loadAvg: platform === "win32" ? null : [l1, l5, l15],
		// `availableParallelism` would be better, but `cpus()` is what every supported Node has.
		cpus: Math.max(1, read.cpus().length),
		memTotalBytes: read.totalmem(),
		memFreeBytes: read.freemem(),
		platform,
		sampledAt: now,
		// #405: absent when the reader offers no arch/homedir (a test double), so the sample never carries a guess.
		...(read.arch && read.homedir ? { host: sampleHost({ arch: read.arch, homedir: read.homedir, platform: read.platform }) } : {}),
	};
}
