import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Reaps Playwright browsers that outlived the process that launched them (#274).
 *
 * ── Why a reaper exists at all ───────────────────────────────────────────────
 *
 * Playwright kills its browser on `close()`, on an uncaught throw, and on
 * SIGINT/SIGTERM/SIGHUP (it installs its own handlers, and we install ours in
 * `index.ts`). None of that runs when the parent is SIGKILLed — killed outright,
 * OOM-reaped, or torn down by a test-pool timeout. The browser is then reparented
 * to init and keeps running forever: it holds a CPU-hungry renderer, GPU, network
 * and storage helper each, and it does NOT exit when its CDP pipe closes.
 *
 * Measured on the owner's machine: 41 such orphans, 285 chromium processes, load
 * average 253, the oldest abandoned 2h03m. They ignored SIGTERM. `kill -9` on that
 * exact set took the load from 253 to 38. So nothing in-process can fix an
 * already-leaked machine — something has to come along afterwards and reap.
 *
 * ── SAFETY: why this cannot kill the user's real browser ─────────────────────
 *
 * The runner is a LOCAL process on the user's own machine, and killing the wrong
 * Chrome destroys their live browsing session. The orphans in the measurement ran
 * `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` — byte for byte
 * the same executable as the user's everyday browser. So the executable path is
 * NOT a discriminator and is never matched on. Three independent conditions must
 * ALL hold before anything is signalled:
 *
 *  1. `--user-data-dir` is a Playwright throwaway temp profile: the basename
 *     matches `playwright_<browser>dev_profile-<6 random chars>` AND the parent
 *     directory is the system temp dir. Playwright mkdtemps this per
 *     non-persistent `launch()` and deletes it on clean close. A real Chrome's
 *     profile lives under `~/Library/Application Support/Google/Chrome` (or the
 *     platform equivalent) and can never produce this path. The runner's own
 *     profiles live under its data dir and cannot either.
 *  2. PPID is 1. The parent is already gone — a browser whose launcher is alive
 *     has that launcher as its parent, so this alone excludes every live session,
 *     including any this very process is driving.
 *  3. It has been idle for at least `minAgeMs` (default 10 min): the process has
 *     been running that long AND the profile directory has not been written to in
 *     that long. Chrome touches its profile constantly while it is doing anything.
 *
 * Condition 2 has one degenerate case: inside a container where the launcher IS
 * PID 1, its live children also report PPID 1. `reapOrphanedPlaywrightBrowsers`
 * refuses to run when `process.pid === 1` for exactly that reason.
 *
 * The reaper logs every process it kills, with its profile path, so a user can
 * always see what happened. `PAGS_RUNNER_REAP_DRY_RUN=1` logs without killing and
 * `PAGS_RUNNER_REAP=0` turns it off entirely.
 */

/** A browser process as seen by `ps`, reduced to what the predicate needs. */
export interface BrowserProcess {
	pid: number;
	ppid: number;
	/** Seconds since the process started, from `ps -o etime`. */
	ageSeconds: number;
	/** The value of its `--user-data-dir=` flag. */
	userDataDir: string;
}

export interface ReapOptions {
	/** How long a browser must have been idle before it is a candidate. Default 10 min. */
	minAgeMs?: number;
	/** Log what would be killed, kill nothing. */
	dryRun?: boolean;
	/** Where log lines go. Default `console.warn`. */
	log?: (line: string) => void;
	/** Injected for tests. */
	now?: number;
}

export interface ReapResult {
	/** Profile dirs whose browser was reaped (or would have been, under dryRun). */
	reaped: string[];
	/** Candidates skipped because they were too young — reported, never killed. */
	skippedYoung: number;
}

const DEFAULT_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * A throwaway browser-profile directory name, anchored.
 *
 * Two producers, both of which mkdtemp — so the trailing six characters are
 * exactly what `fs.mkdtemp` appends, and pinning that length is what stops a
 * user-chosen directory which merely CONTAINS this text from matching:
 *
 *  - `playwright_<browser>dev_profile-` — Playwright's own, created per
 *    non-persistent `launch()`. These are the orphans measured in #274.
 *  - `pags-mcp-profile-` — ours, from `McpRuntime` (see mcp-runtime.ts). Chrome
 *    can rewrite this directory during its async shutdown, after `stop()` has
 *    already removed it, so it needs a sweeper too.
 *
 * A name matching neither is never touched, whatever it contains.
 */
const TEMP_PROFILE_NAME = /^(?:playwright_[a-z]+dev_profile|pags-mcp-profile)-[A-Za-z0-9]{6}$/;

/** Every path the system might hand out as the temp root, de-duplicated. */
export function tempRoots(): string[] {
	const roots = new Set<string>();
	for (const root of [tmpdir(), process.env.TMPDIR, "/tmp"]) {
		if (!root) continue;
		roots.add(root.replace(/\/+$/, ""));
	}
	return [...roots];
}

/**
 * Is this `--user-data-dir` a Playwright throwaway temp profile?
 *
 * Both halves matter. The basename pattern says "Playwright mkdtemp'd this"; the
 * temp-root check says "and it is under the system temp dir, not somewhere a
 * human keeps a real profile". A directory that satisfies only one is rejected.
 */
export function isPlaywrightTempProfile(userDataDir: string, roots: string[] = tempRoots()): boolean {
	if (!userDataDir) return false;
	const dir = userDataDir.replace(/\/+$/, "");
	if (!TEMP_PROFILE_NAME.test(basename(dir))) return false;
	const parent = dirname(dir).replace(/\/+$/, "");
	return roots.some((root) => parent === root);
}

/** Pull `--user-data-dir=<path>` out of a command line. "" when absent. */
export function userDataDirOf(command: string): string {
	// Deliberately `\S+`: every path this reaper acts on is a mkdtemp name under
	// the temp root, which never contains a space. A path WITH a space therefore
	// fails to parse and is skipped — the safe direction to be wrong in.
	const m = command.match(/--user-data-dir=(\S+)/);
	return m ? m[1] : "";
}

/**
 * Parse `ps -o etime` — `[[DD-]HH:]MM:SS` — into seconds. Returns 0 for anything
 * unparseable, which reads as "brand new" and therefore never reapable.
 */
export function parseEtime(etime: string): number {
	const trimmed = etime.trim();
	const m = trimmed.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
	if (!m) return 0;
	const [, days, hours, minutes, seconds] = m;
	return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Parse `ps -wwAo pid=,ppid=,etime=,command=` output into candidate rows. */
export function parsePsOutput(stdout: string): BrowserProcess[] {
	const out: BrowserProcess[] = [];
	for (const line of stdout.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
		if (!m) continue;
		const userDataDir = userDataDirOf(m[4]);
		if (!userDataDir) continue;
		out.push({ pid: Number(m[1]), ppid: Number(m[2]), ageSeconds: parseEtime(m[3]), userDataDir });
	}
	return out;
}

/**
 * Age of a profile directory's last write, in ms.
 *
 * A MISSING directory returns Infinity, and that is deliberate rather than a
 * fallback: Playwright removes this directory only when the browser closed
 * cleanly. A process still running on a temp profile that no longer exists is
 * unambiguously abandoned.
 */
export function profileIdleMs(dir: string, now: number, stat: (p: string) => number | null = safeMtimeMs): number {
	const mtime = stat(dir);
	return mtime === null ? Number.POSITIVE_INFINITY : now - mtime;
}

function safeMtimeMs(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * The whole safety decision, as one pure function — see the SAFETY block above.
 * All four conditions must hold; any one of them failing spares the process.
 */
export function isReapable(
	proc: BrowserProcess,
	opts: { now: number; minAgeMs: number; roots?: string[]; idleMs?: (dir: string, now: number) => number },
): boolean {
	if (proc.ppid !== 1) return false;
	if (!isPlaywrightTempProfile(proc.userDataDir, opts.roots)) return false;
	if (proc.ageSeconds * 1000 < opts.minAgeMs) return false;
	const idle = (opts.idleMs ?? profileIdleMs)(proc.userDataDir, opts.now);
	return idle >= opts.minAgeMs;
}

function ps(): string {
	try {
		// -ww: never truncate the command line, or the --user-data-dir we match on
		// could be cut off and a real orphan would go unnoticed.
		return execFileSync("ps", ["-wwAo", "pid=,ppid=,etime=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	} catch {
		return "";
	}
}

/** Every Playwright-temp-profile browser process currently alive, orphan or not. */
export function listPlaywrightBrowsers(psOutput: string = ps()): BrowserProcess[] {
	return parsePsOutput(psOutput).filter((p) => isPlaywrightTempProfile(p.userDataDir));
}

function signal(pid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(pid, sig);
	} catch {
		// already gone, or not ours to signal — either way there is nothing to do
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Kill abandoned Playwright browsers and delete their temp profiles.
 *
 * Synchronous on purpose: this runs once at runner startup, before anything else
 * competes for the machine, and the whole point is that the CPU is already gone.
 */
export function reapOrphanedPlaywrightBrowsers(opts: ReapOptions = {}): ReapResult {
	const log = opts.log ?? ((line: string) => console.warn(line));
	const empty: ReapResult = { reaped: [], skippedYoung: 0 };
	if (process.platform === "win32") return empty; // no `ps`; the leak is a POSIX-orphan story
	if (process.pid === 1) {
		// See SAFETY note 2: as PID 1 we cannot tell an orphan from our own live child.
		return empty;
	}
	const now = opts.now ?? Date.now();
	const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
	const all = listPlaywrightBrowsers();
	const orphanParents = all.filter((p) => p.ppid === 1);
	const doomed = orphanParents.filter((p) => isReapable(p, { now, minAgeMs }));
	const skippedYoung = orphanParents.length - doomed.length;
	if (doomed.length === 0) return { reaped: [], skippedYoung };

	const dirs = new Set(doomed.map((p) => p.userDataDir));
	const verb = opts.dryRun ? "would reap" : "reaping";
	log(`[runner] ${verb} ${doomed.length} abandoned Playwright browser(s) (parent gone, idle >${Math.round(minAgeMs / 60000)}m):`);
	for (const p of doomed) log(`[runner]   pid ${p.pid}  profile ${p.userDataDir}`);
	if (opts.dryRun) return { reaped: [...dirs], skippedYoung };

	// Ask first. The measurement says they ignore it, but a browser that CAN exit
	// cleanly should be given the chance to flush and remove its own profile.
	for (const p of doomed) signal(p.pid, "SIGTERM");
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline && doomed.some((p) => alive(p.pid))) {
		// Busy-wait: this is startup, single-purpose, and bounded at 2s. A timer
		// would need the event loop, and callers want a settled machine on return.
		execFileSync("sleep", ["0.1"], { stdio: "ignore" });
	}
	for (const p of doomed) if (alive(p.pid)) signal(p.pid, "SIGKILL");

	// The renderer/GPU/network helpers are children of the parent we just killed and
	// normally follow it down. Sweep any that did not, matched by the SAME profile
	// dirs we already cleared — never by name, never by executable.
	for (const p of listPlaywrightBrowsers()) {
		if (dirs.has(p.userDataDir)) signal(p.pid, "SIGKILL");
	}

	for (const dir of dirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// a leftover directory is untidy, not harmful
		}
	}
	return { reaped: [...dirs], skippedYoung };
}

/**
 * Delete Playwright temp profile directories with no live process behind them.
 *
 * Separate from the process reap because the two leak independently: a browser
 * that IS killed by `kill -9` leaves its directory behind with nobody to remove
 * it. These are a few hundred MB each once they have been used.
 */
export function sweepStalePlaywrightProfiles(opts: ReapOptions = {}): string[] {
	if (process.platform === "win32") return [];
	const now = opts.now ?? Date.now();
	const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
	const inUse = new Set(listPlaywrightBrowsers().map((p) => p.userDataDir));
	const removed: string[] = [];
	for (const root of tempRoots()) {
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!TEMP_PROFILE_NAME.test(name)) continue;
			const dir = join(root, name);
			if (inUse.has(dir)) continue;
			if (profileIdleMs(dir, now) < minAgeMs) continue;
			try {
				rmSync(dir, { recursive: true, force: true });
				removed.push(dir);
			} catch {
				// best effort
			}
		}
	}
	if (removed.length > 0) {
		(opts.log ?? ((l: string) => console.warn(l)))(`[runner] removed ${removed.length} stale Playwright temp profile dir(s)`);
	}
	return removed;
}

/**
 * The startup entry point: recover a machine that has already leaked.
 *
 * On by default. Default-off would mean the users who most need it — the ones
 * whose machine is already at load 253 — never get it, and the discriminator is
 * narrow enough (see SAFETY) that a false positive would require a real browser
 * to be running out of a Playwright mkdtemp directory, orphaned, and idle.
 *   PAGS_RUNNER_REAP=0            disable entirely
 *   PAGS_RUNNER_REAP_DRY_RUN=1    report what it would kill, kill nothing
 *   PAGS_RUNNER_REAP_MIN_AGE_MIN  idle threshold in minutes (default 10)
 */
export function reapOnStartup(log: (line: string) => void = (l) => console.warn(l)): void {
	if (process.env.PAGS_RUNNER_REAP === "0") return;
	const minutes = Number(process.env.PAGS_RUNNER_REAP_MIN_AGE_MIN);
	const minAgeMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_MIN_AGE_MS;
	const dryRun = process.env.PAGS_RUNNER_REAP_DRY_RUN === "1";
	try {
		const { reaped, skippedYoung } = reapOrphanedPlaywrightBrowsers({ minAgeMs, dryRun, log });
		if (skippedYoung > 0) log(`[runner] left ${skippedYoung} orphaned browser(s) alone — not idle long enough yet`);
		if (!dryRun && reaped.length > 0) log(`[runner] reaped ${reaped.length} orphaned browser(s); their CPU is yours again`);
		if (!dryRun) sweepStalePlaywrightProfiles({ minAgeMs, log });
	} catch (err) {
		// Never let cleanup stop the runner from starting.
		log(`[runner] browser reap skipped: ${err instanceof Error ? err.message : String(err)}`);
	}
}
