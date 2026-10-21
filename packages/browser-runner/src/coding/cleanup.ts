/**
 * Runner post-run cleanup, with a per-machine mode (#1265).
 *
 * After a coding run the runner used to kill only the engine's OWN process. Builds, test runners, dev
 * servers, watchers and Playwright browsers the engine started survived, untracked, and a machine that
 * runs agents all day drifted to load 283 on 12 cores and a disk that never came back down. This module
 * is the runner's answer, and the setting that decides how hard it presses is `mode`:
 *
 *   gentle — the default, for a machine somebody also USES. It touches only what it can PROVE it started:
 *            descendants of this session's engine, processes carrying this runner's session marker,
 *            Playwright's own throwaway browser profiles, and this run's own temp folder and worktrees.
 *            Everything else is REPORTED, never killed. It never touches a browser a person is using.
 *   harsh  — for a dedicated runner. The same, plus: it kills the whole process group, sweeps ORPHANED
 *            (ppid 1) build/dev tooling started from a runner workdir, reaps stale temp and browser
 *            profiles on a timer, and prunes package caches and build outputs when the disk is nearly full.
 *
 * Both modes keep the same three promises: the runner never touches a process or file outside what it
 * owns, never kills a live session, and never deletes uncommitted work in a checkout.
 *
 * The platform resolves the mode and the per-behaviour checkboxes into `CleanupPolicy` and sends it on
 * the heartbeat answer, so there is ONE resolver (workers/api/src/lib/runner-cleanup-policy.ts) and this
 * side only obeys. With no policy yet — an old platform, a first start — the runner is gentle.
 *
 * Everything that touches the system (`ps`, signals, the filesystem, git) is injected, so the decisions
 * above are pure functions with tests that name the process each mode must and must not kill.
 */
import { execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { listPlaywrightBrowsers, reapOrphanedPlaywrightBrowsers, sweepStalePlaywrightProfiles } from "../reaper.js";
import { createSessionTmp, DISK_PRUNE_THRESHOLD, diskUsedFraction, freeBytes, type Git, listWorktrees, pruneCaches, realGit, removeNewWorktrees, removeSessionTmp, sweepOldSessionTmp } from "./cleanup-fs.js";

// ── Policy ──────────────────────────────────────────────────────────────────────────────────

export type CleanupMode = "gentle" | "harsh";

/** The six switches the console shows per machine. The mode sets their defaults; each can be overridden. */
export interface CleanupBehaviours {
	/** 1. Kill the session's process tree (and, in harsh, its whole group) on end, timeout and abort. */
	processGroupKill: boolean;
	/** 2. After a session, look for its leftovers (report in gentle; kill orphans in harsh). */
	leftoverSweep: boolean;
	/** 3. Reap Playwright's own abandoned browsers and stale profiles after every run. */
	browserCleanup: boolean;
	/** 4. Delete the per-run temp folder and the worktrees the run created. */
	tempCleanup: boolean;
	/** 5. Warn when load is far above what the sessions account for (harsh also sweeps). */
	loadWarning: boolean;
	/** +  Prune package caches and build outputs when the disk is over 90%. */
	cachePruning: boolean;
}

export interface CleanupPolicy {
	mode: CleanupMode;
	behaviours: CleanupBehaviours;
}

export const GENTLE_BEHAVIOURS: CleanupBehaviours = { processGroupKill: true, leftoverSweep: true, browserCleanup: true, tempCleanup: true, loadWarning: true, cachePruning: false };
export const HARSH_BEHAVIOURS: CleanupBehaviours = { ...GENTLE_BEHAVIOURS, cachePruning: true };
export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = { mode: "gentle", behaviours: GENTLE_BEHAVIOURS };

/** A policy off the wire. Anything malformed is the GENTLE default — never a harsher guess. */
export function parseCleanupPolicy(raw: unknown): CleanupPolicy {
	if (!raw || typeof raw !== "object") return DEFAULT_CLEANUP_POLICY;
	const v = raw as { mode?: unknown; behaviours?: unknown };
	const mode: CleanupMode = v.mode === "harsh" ? "harsh" : "gentle";
	const base = mode === "harsh" ? HARSH_BEHAVIOURS : GENTLE_BEHAVIOURS;
	const b = (v.behaviours && typeof v.behaviours === "object" ? v.behaviours : {}) as Record<string, unknown>;
	const pick = (k: keyof CleanupBehaviours) => (typeof b[k] === "boolean" ? (b[k] as boolean) : base[k]);
	return { mode, behaviours: { processGroupKill: pick("processGroupKill"), leftoverSweep: pick("leftoverSweep"), browserCleanup: pick("browserCleanup"), tempCleanup: pick("tempCleanup"), loadWarning: pick("loadWarning"), cachePruning: pick("cachePruning") } };
}

// ── The process table ───────────────────────────────────────────────────────────────────────

export interface ProcRow {
	pid: number;
	ppid: number;
	pgid: number;
	ageSec: number;
	command: string;
}

function etimeSeconds(etime: string): number {
	const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
	if (!m) return 0;
	const [, d = "0", h = "0", mm = "0", s = "0"] = m;
	return Number(d) * 86400 + Number(h) * 3600 + Number(mm) * 60 + Number(s);
}

/** `ps -wwA -o pid=,ppid=,pgid=,etime=,command=` → rows. A line that does not parse is skipped. */
export function parseProcessTable(text: string): ProcRow[] {
	const rows: ProcRow[] = [];
	for (const line of text.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
		if (!m) continue;
		rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), ageSec: etimeSeconds(m[4]), command: m[5] });
	}
	return rows;
}

/** The whole process table, or null where it cannot be read (Windows, a failed `ps`). Never zeros. */
export function readProcessTable(): ProcRow[] | null {
	if (process.platform === "win32") return null;
	try {
		return parseProcessTable(execFileSync("ps", ["-wwA", "-o", "pid=,ppid=,pgid=,etime=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024 }));
	} catch {
		return null;
	}
}

/** `rootPid` and every process beneath it, by parent links. */
export function descendantsOf(rows: readonly ProcRow[], rootPid: number): ProcRow[] {
	const children = new Map<number, ProcRow[]>();
	const byPid = new Map<number, ProcRow>();
	for (const r of rows) {
		byPid.set(r.pid, r);
		children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
	}
	const out: ProcRow[] = [];
	const seen = new Set<number>();
	const stack = [byPid.get(rootPid)].filter((r): r is ProcRow => Boolean(r));
	while (stack.length) {
		const r = stack.pop() as ProcRow;
		if (seen.has(r.pid)) continue;
		seen.add(r.pid);
		out.push(r);
		stack.push(...(children.get(r.pid) ?? []));
	}
	return out;
}

// ── 1. Killing a session ────────────────────────────────────────────────────────────────────

export interface KillPlan {
	/** Process GROUPS to signal as a whole (negative pid). Only ever a group this runner created. */
	groups: number[];
	/** Individual processes to signal. */
	pids: number[];
}

/**
 * Who dies when a session's engine is stopped. PURE.
 *
 * The engine is spawned as its own group leader, so its group is made of its own descendants and nothing
 * else — which is what makes signalling it safe. Individual pids are the engine's descendants by parent
 * link plus anything left in its group after being reparented. Gentle signals exactly those processes;
 * harsh also signals the group as a whole, which catches a child forked between the table read and the
 * signal. With the behaviour switched off only the engine itself is signalled — the pre-#1265 behaviour.
 */
export function planSessionKill(rows: readonly ProcRow[], root: { pid: number }, policy: CleanupPolicy, self: number = process.pid): KillPlan {
	if (!policy.behaviours.processGroupKill) return { groups: [], pids: [root.pid] };
	const tree = descendantsOf(rows, root.pid);
	const rootRow = rows.find((r) => r.pid === root.pid);
	const ownsGroup = rootRow ? rootRow.pgid === root.pid : true; // we spawned it detached: its pgid is its pid
	const inGroup = ownsGroup ? rows.filter((r) => r.pgid === root.pid) : [];
	const pids = [...new Set([root.pid, ...tree.map((r) => r.pid), ...inGroup.map((r) => r.pid)])].filter((p) => p > 1 && p !== self);
	return { groups: policy.mode === "harsh" && ownsGroup && root.pid > 1 ? [root.pid] : [], pids };
}

export interface SystemOps {
	table: () => ProcRow[] | null;
	signal: (target: number, sig: NodeJS.Signals) => void;
	alive: (pid: number) => boolean;
	sleep: (ms: number) => Promise<void>;
}

export const realOps: SystemOps = {
	table: readProcessTable,
	signal: (target, sig) => {
		try {
			process.kill(target, sig);
		} catch {
			// already gone, or not ours to signal — nothing to do
		}
	},
	alive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	},
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export const KILL_GRACE_MS = 5000;

/** Send SIGTERM to the plan (groups as a whole, then each pid). */
function termPlan(plan: KillPlan, ops: SystemOps): void {
	for (const g of plan.groups) ops.signal(-g, "SIGTERM");
	for (const p of plan.pids) ops.signal(p, "SIGTERM");
}

/**
 * Stop a session's engine and everything it started: SIGTERM now, SIGKILL after the grace period for
 * whatever is still alive. The SIGTERM goes out SYNCHRONOUSLY (stop() is synchronous); the escalation is
 * returned as a promise the caller may ignore — its timer never keeps the runner alive. On Windows
 * there are no groups: `taskkill /T /F` ends the tree.
 */
export function killSession(rootPid: number, policy: CleanupPolicy, ops: SystemOps = realOps, graceMs: number = KILL_GRACE_MS): Promise<number[]> {
	if (!rootPid || rootPid <= 1) return Promise.resolve([]);
	if (process.platform === "win32" && ops === realOps) {
		try {
			execFileSync("taskkill", ["/pid", String(rootPid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 });
		} catch {
			// already gone
		}
		return Promise.resolve([rootPid]);
	}
	const plan = planSessionKill(ops.table() ?? [], { pid: rootPid }, policy);
	termPlan(plan, ops);
	return (async () => {
		const deadline = Date.now() + graceMs;
		while (Date.now() < deadline && plan.pids.some((p) => ops.alive(p))) await ops.sleep(100);
		const survivors = plan.pids.filter((p) => ops.alive(p));
		for (const g of plan.groups) ops.signal(-g, "SIGKILL");
		for (const p of survivors) ops.signal(p, "SIGKILL");
		return plan.pids;
	})();
}

// ── 2. Sweeping leftovers ───────────────────────────────────────────────────────────────────

export const SESSION_MARKER = "PAGS_SESSION_ID";

export interface Orphan {
	pid: number;
	ppid: number;
	/** Why it is considered a leftover. `marker` and `ledger-group` are proof it was ours; `workdir-orphan` is the harsh heuristic. */
	reason: "marker" | "ledger-group" | "workdir-orphan";
	command: string;
	sessionId?: string;
}

export interface SweepContext {
	mode: CleanupMode;
	/** Engine pids of sessions that are alive now — their trees are never leftovers. */
	liveRoots: readonly number[];
	liveSessionIds: ReadonlySet<string>;
	/** pgid → session id, for groups this runner created that have ended. */
	endedGroups: ReadonlyMap<number, string>;
	/** pid → the PAGS_SESSION_ID the process carries, for the candidates whose environment could be read. */
	markers: ReadonlyMap<number, string>;
	/** The runner's own checkout/work directories. A leftover must be running out of one to be swept by heuristic. */
	workdirs: readonly string[];
	self?: number;
}

const TOOLING = new Set(["node", "vite", "next", "jest", "vitest", "esbuild", "wrangler", "playwright", "webpack", "tsc", "turbo", "nodemon"]);
/** The runner itself and its supervisors are never a leftover, whatever their parent or path. */
const NEVER = /(\bpags(\.m?js)?\s+(up|runner)\b|PAGS_RUNNER_|proagentstore[\\/]cli[\\/])/;

function toolingName(command: string): boolean {
	const [first = "", second = "", third = ""] = command.split(/\s+/); // the launcher, its script, one more — a position, not a cut
	return [first, second, third].some((t) => TOOLING.has(basename(t).replace(/\.(m?js|cjs|ts)$/, "")));
}

/**
 * Which processes are leftovers of ended sessions, and which of them may be killed. PURE.
 *
 * A process is a candidate only when it is NOT beneath a live session and is orphaned (parent 1). Then:
 *   marker        carries a session marker for a session that is no longer live       → proof, kill in both modes
 *   ledger-group  sits in a process group this runner created for an ended session    → proof; kill in harsh, report in gentle
 *   workdir-orphan a build/dev tool (node, vite, jest…) running out of a runner workdir → heuristic; kill in harsh only
 * `report` is every candidate (gentle shows them; the heartbeat carries the count); `kill` is the subset
 * the mode may signal. The runner process, its supervisor and the sweeping process itself are excluded.
 */
export function planOrphanSweep(rows: readonly ProcRow[], ctx: SweepContext): { kill: Orphan[]; report: Orphan[] } {
	const self = ctx.self ?? process.pid;
	const protectedPids = new Set<number>([self, 0, 1]);
	const ancestry = new Map(rows.map((r) => [r.pid, r.ppid] as const));
	for (let p = self, i = 0; p > 1 && i < 64; i++) {
		protectedPids.add(p);
		p = ancestry.get(p) ?? 0;
	}
	for (const root of ctx.liveRoots) for (const r of descendantsOf(rows, root)) protectedPids.add(r.pid);

	const report: Orphan[] = [];
	const kill: Orphan[] = [];
	for (const r of rows) {
		if (protectedPids.has(r.pid) || r.ppid !== 1 || NEVER.test(r.command)) continue;
		const marker = ctx.markers.get(r.pid);
		// A process that says it belongs to a LIVE session is that session's, whatever group or path it sits in.
		if (marker && ctx.liveSessionIds.has(marker)) continue;
		const group = ctx.endedGroups.get(r.pgid);
		let orphan: Orphan | null = null;
		if (marker && !ctx.liveSessionIds.has(marker)) orphan = { pid: r.pid, ppid: r.ppid, reason: "marker", command: r.command, sessionId: marker };
		else if (group && !ctx.liveSessionIds.has(group)) orphan = { pid: r.pid, ppid: r.ppid, reason: "ledger-group", command: r.command, sessionId: group };
		else if (toolingName(r.command) && ctx.workdirs.some((w) => w && r.command.includes(w))) orphan = { pid: r.pid, ppid: r.ppid, reason: "workdir-orphan", command: r.command };
		if (!orphan) continue;
		report.push(orphan);
		const killable = orphan.reason === "marker" || ctx.mode === "harsh";
		if (killable) kill.push(orphan);
	}
	return { kill, report };
}

/** The session marker in each candidate's environment, where the platform lets us read it. Linux: /proc. macOS: `ps -E`. */
export function readMarkers(pids: readonly number[]): Map<number, string> {
	const out = new Map<number, string>();
	const wanted = pids.slice(0, 300);
	if (!wanted.length || process.platform === "win32") return out;
	const re = new RegExp(`${SESSION_MARKER}=([A-Za-z0-9_.-]+)`);
	if (process.platform === "linux") {
		for (const pid of wanted) {
			try {
				const m = readFileSync(`/proc/${pid}/environ`, "utf8").match(new RegExp(`(?:^|\\0)${SESSION_MARKER}=([A-Za-z0-9_.-]+)`));
				if (m) out.set(pid, m[1]);
			} catch {
				// not ours to read, or gone
			}
		}
		return out;
	}
	try {
		const text = execFileSync("ps", ["-wwE", "-p", wanted.join(","), "-o", "pid=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
		for (const line of text.split("\n")) {
			const m = line.trim().match(/^(\d+)\s+/);
			const mk = line.match(re);
			if (m && mk) out.set(Number(m[1]), mk[1]);
		}
	} catch {
		// the environment could not be read: nothing is marked, so nothing is killed on a marker
	}
	return out;
}

// ── 5. Load that the sessions do not explain ────────────────────────────────────────────────

export interface LoadReading {
	load1: number;
	cpus: number;
	/** The sessions' summed CPU, percent of ONE core. Null when it could not be read. */
	sessionsCpuPct: number | null;
}

/** Far above what the sessions account for: the leftover-process signal. PURE. Null readings never warn. */
export function loadMismatch(r: LoadReading): { mismatch: boolean; unexplainedLoad: number } {
	if (r.sessionsCpuPct === null || r.cpus <= 0) return { mismatch: false, unexplainedLoad: 0 };
	const explained = r.sessionsCpuPct / 100;
	const unexplained = Math.max(0, r.load1 - explained);
	return { mismatch: r.load1 > r.cpus * 1.5 && explained < r.load1 * 0.25, unexplainedLoad: Math.round(unexplained * 10) / 10 };
}

export * from "./cleanup-fs.js";

// ── The manager ─────────────────────────────────────────────────────────────────────────────

export interface CleanupReport {
	at: string;
	reason: string;
	killedProcesses: number;
	orphansFound: number;
	browsersReaped: number;
	tempFoldersRemoved: number;
	worktreesRemoved: number;
	cachesPruned: number;
	buildOutputsRemoved: number;
	freedBytes: number | null;
}

export interface CleanupStatus {
	mode: CleanupMode;
	behaviours: CleanupBehaviours;
	/** Leftovers seen by the last sweep that were reported, not killed (gentle), or that survived. */
	orphanedProcesses: number;
	orphans: Array<Pick<Orphan, "pid" | "reason" | "sessionId"> & { command: string }>;
	loadMismatch: boolean;
	unexplainedLoad: number;
	diskUsedPct: number | null;
	warnings: string[];
	lastPass: CleanupReport | null;
}

interface Tracked {
	sessionId: string;
	workDir: string;
	pgids: Set<number>;
	worktreesBefore: string[];
}

export interface CleanupManagerOptions {
	/** `~/.config/proagentstore` — the per-run temp folders and the ledger live under it. */
	baseDir: string;
	reposBaseDir: string;
	ops?: SystemOps;
	git?: Git;
	log?: (line: string) => void;
	now?: () => number;
	/** Tests construct many managers; only the runner's one registers the process-exit hook. */
	registerExitHook?: boolean;
	/** The disk reading — injected so "above 90%" is testable without filling a disk. */
	statfs?: typeof statfsSync;
}

/**
 * Owns the policy and the per-session bookkeeping, and runs the sweeps. One per runner. Everything it
 * does is best-effort: cleanup that fails costs tidiness, never a run.
 */
export class CleanupManager {
	policy: CleanupPolicy = DEFAULT_CLEANUP_POLICY;
	private readonly tracked = new Map<string, Tracked>();
	private readonly endedGroups = new Map<number, string>();
	private lastOrphans: Orphan[] = [];
	private lastPass: CleanupReport | null = null;
	private mismatch = { mismatch: false, unexplainedLoad: 0 };
	private timer: NodeJS.Timeout | null = null;
	private readonly ops: SystemOps;
	private readonly git: Git;
	private readonly log: (line: string) => void;
	private readonly now: () => number;

	constructor(private readonly opts: CleanupManagerOptions) {
		this.ops = opts.ops ?? realOps;
		this.git = opts.git ?? realGit;
		this.log = opts.log ?? ((l) => process.stderr.write(`${l}\n`));
		this.now = opts.now ?? Date.now;
		// Engines run in their own process group, so a terminal's Ctrl-C no longer reaches them. The runner's
		// one exit path (index.ts: shutdown → process.exit) fires this, so ending the runner ends its engines.
		if (opts.registerExitHook !== false) process.once("exit", () => this.killAllSync());
	}

	/** End every live engine's group, synchronously, on the way out. SIGTERM only: the process is exiting. */
	killAllSync(): void {
		for (const t of this.tracked.values()) {
			for (const pgid of t.pgids) {
				this.ops.signal(-pgid, "SIGTERM");
				this.ops.signal(pgid, "SIGTERM");
			}
		}
	}

	setPolicy(policy: CleanupPolicy): void {
		const changed = policy.mode !== this.policy.mode || JSON.stringify(policy.behaviours) !== JSON.stringify(this.policy.behaviours);
		this.policy = policy;
		if (changed) this.log(`[runner] cleanup mode ${policy.mode}${policy.mode === "harsh" ? " (kills process groups, sweeps orphans, prunes caches above 90% disk)" : " (touches only what it started)"}`);
		this.reschedule();
	}

	/** Harsh reaps browsers and stale temp every 15 minutes, not only after a run. */
	private reschedule(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (this.policy.mode !== "harsh") return;
		this.timer = setInterval(() => void this.timedSweep(), 15 * 60_000);
		this.timer.unref();
	}

	stopTimers(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** The directory a session's engine gets as TMPDIR, or null when it could not be made / the behaviour is off. */
	startSession(sessionId: string, workDir: string): { tmpDir: string | null } {
		if (!this.tracked.has(sessionId)) {
			this.tracked.set(sessionId, { sessionId, workDir, pgids: new Set(), worktreesBefore: this.policy.behaviours.tempCleanup ? listWorktrees(workDir, this.git) : [] });
		}
		return { tmpDir: this.policy.behaviours.tempCleanup ? createSessionTmp(this.opts.baseDir, sessionId) : null };
	}

	/**
	 * The env an engine process is spawned with: the base env plus the session marker (so a leftover can be
	 * proven ours) and a per-run TMPDIR (so the run's scratch files are deleted with it).
	 */
	engineEnv(base: NodeJS.ProcessEnv, sessionId: string, workDir: string): NodeJS.ProcessEnv {
		const { tmpDir } = this.startSession(sessionId, workDir);
		return { ...base, PAGS_SESSION_ID: sessionId, ...(tmpDir ? { TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir } : {}) };
	}

	/** Spawn options every engine process shares: its own process group (POSIX), so what it starts can be ended with it. */
	spawnOptions(): { detached: boolean } {
		return { detached: process.platform !== "win32" };
	}

	/** Record the engine's process group, so a leftover in it is provably this session's. */
	noteProcess(sessionId: string, pid: number | undefined): void {
		if (pid && pid > 1) this.tracked.get(sessionId)?.pgids.add(pid);
	}

	/** Stop an engine process and what it started, per the policy. Synchronous SIGTERM; escalation is detached. */
	killProcess(sessionId: string, proc: Pick<ChildProcess, "pid" | "kill">, signal?: NodeJS.Signals): void {
		if (!proc.pid) return;
		this.noteProcess(sessionId, proc.pid);
		if (signal === "SIGINT") {
			proc.kill("SIGINT"); // an interrupt aborts the turn and keeps the process; it is not a stop
			return;
		}
		void killSession(proc.pid, this.policy, this.ops).catch(() => undefined);
	}

	/** A session has ended: its leftovers, browsers, temp folder and worktrees. Never throws. */
	async endSession(sessionId: string, liveSessionIds: ReadonlySet<string>, liveRoots: readonly number[]): Promise<CleanupReport> {
		const t = this.tracked.get(sessionId);
		this.tracked.delete(sessionId);
		if (t) for (const g of t.pgids) this.endedGroups.set(g, sessionId);
		const report = this.blank(`session ended: ${sessionId}`);
		const b = this.policy.behaviours;
		try {
			if (b.leftoverSweep) await this.sweepInto(report, liveSessionIds, liveRoots);
			if (b.browserCleanup) report.browsersReaped += this.browsers();
			if (b.tempCleanup) {
				if (removeSessionTmp(this.opts.baseDir, sessionId)) report.tempFoldersRemoved++;
				if (t) {
					const wt = removeNewWorktrees(t.workDir, t.worktreesBefore, this.git);
					report.worktreesRemoved += wt.removed.length;
					for (const kept of wt.kept) this.log(`[runner] left worktree ${kept}: it has uncommitted changes`);
				}
			}
		} catch (e) {
			this.log(`[runner] cleanup after ${sessionId} skipped: ${e instanceof Error ? e.message : String(e)}`);
		}
		this.lastPass = report;
		return report;
	}

	private blank(reason: string): CleanupReport {
		return { at: new Date(this.now()).toISOString(), reason, killedProcesses: 0, orphansFound: 0, browsersReaped: 0, tempFoldersRemoved: 0, worktreesRemoved: 0, cachesPruned: 0, buildOutputsRemoved: 0, freedBytes: null };
	}

	/** Reap Playwright's own abandoned browsers and stale profiles. Playwright's throwaway profiles only — never a person's browser. */
	private browsers(): number {
		try {
			const { reaped } = reapOrphanedPlaywrightBrowsers({ minAgeMs: 60_000, log: this.log });
			sweepStalePlaywrightProfiles({ minAgeMs: 60_000, log: this.log });
			return reaped.length;
		} catch {
			return 0;
		}
	}

	private async sweepInto(report: CleanupReport, liveSessionIds: ReadonlySet<string>, liveRoots: readonly number[]): Promise<void> {
		const rows = this.ops.table();
		if (!rows) return;
		const candidates = rows.filter((r) => r.ppid === 1).map((r) => r.pid);
		const plan = planOrphanSweep(rows, {
			mode: this.policy.mode,
			liveRoots,
			liveSessionIds,
			endedGroups: this.endedGroups,
			markers: readMarkers(candidates),
			workdirs: [this.opts.reposBaseDir, join(this.opts.baseDir, "tmp")],
		});
		report.orphansFound = plan.report.length;
		for (const o of plan.kill) this.ops.signal(o.pid, "SIGTERM");
		if (plan.kill.length) {
			this.log(`[runner] ${this.policy.mode} sweep: ending ${plan.kill.length} leftover process(es): ${plan.kill.map((o) => `${o.pid} (${o.reason})`).join(", ")}`);
			await this.ops.sleep(2000);
			for (const o of plan.kill) if (this.ops.alive(o.pid)) this.ops.signal(o.pid, "SIGKILL");
			report.killedProcesses += plan.kill.length;
		}
		const killed = new Set(plan.kill.map((o) => o.pid));
		this.lastOrphans = plan.report.filter((o) => !killed.has(o.pid));
		if (this.lastOrphans.length) this.log(`[runner] ${this.lastOrphans.length} leftover process(es) found and NOT touched (${this.policy.mode} mode): ${this.lastOrphans.slice(0, 5).map((o) => o.pid).join(", ")}`);
	}

	/** Harsh's 15-minute tick. */
	private async timedSweep(): Promise<void> {
		const report = this.blank("timer");
		if (this.policy.behaviours.browserCleanup) report.browsersReaped += this.browsers();
		if (this.policy.behaviours.tempCleanup && this.policy.mode === "harsh") report.tempFoldersRemoved += sweepOldSessionTmp(this.opts.baseDir, 24 * 3600_000, new Set(this.tracked.keys()), this.now()).length;
		this.lastPass = report;
	}

	/**
	 * Feed the manager the machine's reading. Records the load mismatch; in harsh it triggers a sweep, and
	 * above 90% disk it prunes — each only when its behaviour is on. Called from the heartbeat tick.
	 */
	async observe(reading: LoadReading & { diskPath: string }, liveSessionIds: ReadonlySet<string>, liveRoots: readonly number[]): Promise<void> {
		this.mismatch = this.policy.behaviours.loadWarning ? loadMismatch(reading) : { mismatch: false, unexplainedLoad: 0 };
		if (this.mismatch.mismatch && this.policy.mode === "harsh" && this.policy.behaviours.leftoverSweep) {
			const report = this.blank("load mismatch");
			await this.sweepInto(report, liveSessionIds, liveRoots);
			this.lastPass = report;
		}
		const used = diskUsedFraction(reading.diskPath, this.opts.statfs);
		if (used !== null && used > DISK_PRUNE_THRESHOLD && this.policy.behaviours.cachePruning) await this.prune("disk over 90%", liveSessionIds);
	}

	/** A cleanup pass on demand: sweep, browsers, stale temp, and (when allowed) the caches. Reports bytes freed. */
	async runPass(reason: string, liveSessionIds: ReadonlySet<string>, liveRoots: readonly number[]): Promise<CleanupReport> {
		const before = freeBytes(this.opts.reposBaseDir, this.opts.statfs) ?? freeBytes(homedir(), this.opts.statfs);
		const report = this.blank(reason);
		const b = this.policy.behaviours;
		if (b.leftoverSweep) await this.sweepInto(report, liveSessionIds, liveRoots);
		if (b.browserCleanup) report.browsersReaped += this.browsers();
		if (b.tempCleanup) report.tempFoldersRemoved += sweepOldSessionTmp(this.opts.baseDir, this.policy.mode === "harsh" ? 24 * 3600_000 : 7 * 24 * 3600_000, liveSessionIds, this.now()).length;
		if (b.cachePruning) await this.prune(reason, liveSessionIds, report);
		const after = freeBytes(this.opts.reposBaseDir, this.opts.statfs) ?? freeBytes(homedir(), this.opts.statfs);
		report.freedBytes = before !== null && after !== null ? Math.max(0, after - before) : null;
		this.lastPass = report;
		return report;
	}

	private async prune(reason: string, liveSessionIds: ReadonlySet<string>, into?: CleanupReport): Promise<void> {
		const busy = [...this.tracked.values()].filter((t) => liveSessionIds.has(t.sessionId)).map((t) => t.workDir);
		const r = pruneCaches({ reposBaseDir: this.opts.reposBaseDir, busyDirs: busy, git: this.git });
		this.log(`[runner] cache prune (${reason}): ${r.prunedCaches.join(", ") || "no package caches"}; ${r.removedOutputs.length} ignored build output(s) removed`);
		if (into) {
			into.cachesPruned += r.prunedCaches.length;
			into.buildOutputsRemoved += r.removedOutputs.length;
		}
	}

	status(diskPath: string = this.opts.reposBaseDir): CleanupStatus {
		const used = diskUsedFraction(diskPath, this.opts.statfs);
		const warnings: string[] = [];
		if (this.mismatch.mismatch) warnings.push(`load is ${this.mismatch.unexplainedLoad} above what the sessions account for — leftover processes are likely`);
		if (used !== null && used > DISK_PRUNE_THRESHOLD && !this.policy.behaviours.cachePruning) warnings.push(`disk is ${Math.round(used * 100)}% full and cache pruning is off on this machine`);
		return {
			mode: this.policy.mode,
			behaviours: this.policy.behaviours,
			orphanedProcesses: this.lastOrphans.length,
			orphans: this.lastOrphans.slice(0, 10).map((o) => ({ pid: o.pid, reason: o.reason, sessionId: o.sessionId, command: o.command.length > 160 ? `${o.command.slice(0, 160)}…` : o.command })),
			loadMismatch: this.mismatch.mismatch,
			unexplainedLoad: this.mismatch.unexplainedLoad,
			diskUsedPct: used === null ? null : Math.round(used * 1000) / 10,
			warnings,
			lastPass: this.lastPass,
		};
	}

	/** Orphaned Playwright-launched browsers right now (the heartbeat's cheap count). */
	playwrightBrowserCount(): number {
		try {
			return listPlaywrightBrowsers().length;
		} catch {
			return 0;
		}
	}
}

/** The runner's per-user config directory, where per-run temp folders and the ledger live. */
export const defaultCleanupBaseDir = (): string => join(homedir(), ".config", "proagentstore");
