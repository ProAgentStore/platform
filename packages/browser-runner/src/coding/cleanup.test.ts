import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CleanupManager,
	DEFAULT_CLEANUP_POLICY,
	descendantsOf,
	GENTLE_BEHAVIOURS,
	HARSH_BEHAVIOURS,
	killSession,
	listWorktrees,
	loadMismatch,
	parseCleanupPolicy,
	parseProcessTable,
	planOrphanSweep,
	planSessionKill,
	type ProcRow,
	pruneCaches,
	removeNewWorktrees,
	removeSessionTmp,
	sessionTmpDir,
	type SweepContext,
	sweepOldSessionTmp,
	type CleanupPolicy,
	type Git,
	type SystemOps,
} from "./cleanup.js";
import { isPlaywrightTempProfile } from "../reaper.js";

/**
 * #1265 — what each cleanup mode may and may not touch.
 *
 * The decisions are pure functions over a process table, so every case here NAMES the process a mode must
 * kill and the one it must leave alone. The acceptance criteria read as these tests: gentle never kills a
 * process that is not provably a session's; harsh kills the whole group; temp folders go in both modes.
 */

const GENTLE: CleanupPolicy = { mode: "gentle", behaviours: GENTLE_BEHAVIOURS };
const HARSH: CleanupPolicy = { mode: "harsh", behaviours: HARSH_BEHAVIOURS };

const row = (pid: number, ppid: number, pgid: number, command: string, ageSec = 600): ProcRow => ({ pid, ppid, pgid, ageSec, command });

/** A realistic table: the runner (100) supervising one live session whose engine (200) leads group 200. */
const REPOS = "/Users/x/.config/proagentstore/repos";
const TABLE: ProcRow[] = [
	row(1, 0, 1, "/sbin/launchd"),
	row(100, 1, 100, "node /usr/local/lib/node_modules/@proagentstore/cli/dist/index.js runner connect"),
	row(200, 100, 200, "claude --dangerously-skip-permissions"),
	row(201, 200, 200, "/bin/zsh -c pnpm test"),
	row(202, 201, 200, `node ${REPOS}/shop/node_modules/.bin/vitest run`),
	// Leftovers of an ENDED session (group 300, whose leader is gone): reparented to launchd.
	row(301, 1, 300, `node ${REPOS}/shop/node_modules/.bin/vite --port 5173`),
	row(302, 1, 300, "/bin/sleep 3600"),
	// A node dev server nobody can attribute, running out of a runner checkout.
	row(401, 1, 401, `node ${REPOS}/blog/node_modules/.bin/next dev`),
	// Things that are NOT ours.
	row(500, 1, 500, "node /Users/x/personal/api/server.js"), // the owner's own project, outside the runner's directories
	row(501, 1, 501, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/Library/Application Support/Google/Chrome"),
	row(502, 1, 502, `node ${REPOS}/blog/node_modules/.bin/esbuild --service`), // another orphaned runner-workdir tool
];

const ctx = (over: Partial<SweepContext> = {}): SweepContext => ({
	mode: "gentle",
	liveRoots: [200],
	liveSessionIds: new Set(["live-1"]),
	endedGroups: new Map([[300, "ended-1"]]),
	markers: new Map(),
	workdirs: [REPOS],
	self: 100,
	...over,
});

describe("the policy off the wire", () => {
	it("defaults to gentle, and a malformed or missing policy is gentle, never harsher", () => {
		expect(DEFAULT_CLEANUP_POLICY.mode).toBe("gentle");
		for (const raw of [undefined, null, "harsh", 7, [], {}, { mode: "nuclear" }, { mode: "HARSH" }]) expect(parseCleanupPolicy(raw).mode).toBe("gentle");
		expect(parseCleanupPolicy({ mode: "nuclear", behaviours: { cachePruning: true } }).behaviours.cachePruning).toBe(true); // an explicit switch is honoured…
		expect(parseCleanupPolicy({ mode: "nuclear" }).behaviours.cachePruning).toBe(false); // …but the mode did not become harsh
	});

	it("harsh turns on cache pruning; gentle leaves it off; every other behaviour is on in both", () => {
		expect(parseCleanupPolicy({ mode: "gentle" }).behaviours).toEqual(GENTLE_BEHAVIOURS);
		expect(parseCleanupPolicy({ mode: "harsh" }).behaviours).toEqual(HARSH_BEHAVIOURS);
		expect(GENTLE_BEHAVIOURS.cachePruning).toBe(false);
		expect(HARSH_BEHAVIOURS.cachePruning).toBe(true);
	});

	it("a per-behaviour override beats the mode's default, either way", () => {
		const p = parseCleanupPolicy({ mode: "harsh", behaviours: { cachePruning: false, browserCleanup: false } });
		expect(p.behaviours).toMatchObject({ cachePruning: false, browserCleanup: false, processGroupKill: true });
		expect(parseCleanupPolicy({ mode: "gentle", behaviours: { cachePruning: true } }).behaviours.cachePruning).toBe(true);
	});

	it("ignores non-boolean switch values", () => {
		expect(parseCleanupPolicy({ mode: "gentle", behaviours: { processGroupKill: "no", tempCleanup: 0 } }).behaviours).toEqual(GENTLE_BEHAVIOURS);
	});
});

describe("the process table", () => {
	it("parses ps output including commands with spaces, and skips lines it cannot read", () => {
		const rows = parseProcessTable("  1     0     1  47-03:12:01 /sbin/launchd\n garbage line\n  200  100  200     05:10 claude --flag value with spaces\n");
		expect(rows).toEqual([
			{ pid: 1, ppid: 0, pgid: 1, ageSec: 47 * 86400 + 3 * 3600 + 12 * 60 + 1, command: "/sbin/launchd" },
			{ pid: 200, ppid: 100, pgid: 200, ageSec: 310, command: "claude --flag value with spaces" },
		]);
	});

	it("walks descendants by parent link, root included, cycle-safe", () => {
		expect(descendantsOf(TABLE, 200).map((r) => r.pid).sort()).toEqual([200, 201, 202]);
		expect(descendantsOf([row(1, 2, 1, "a"), row(2, 1, 2, "b")], 1).map((r) => r.pid).sort()).toEqual([1, 2]);
		expect(descendantsOf(TABLE, 99999)).toEqual([]);
	});
});

describe("1. killing a session — gentle kills only what descends from it; harsh kills the group", () => {
	it("gentle signals the engine, its descendants and what its own group still holds — and no group as a whole", () => {
		const plan = planSessionKill(TABLE, { pid: 200 }, GENTLE, 100);
		expect(plan.groups).toEqual([]);
		expect(plan.pids.sort()).toEqual([200, 201, 202]);
	});

	it("harsh signals the whole process group as well", () => {
		const plan = planSessionKill(TABLE, { pid: 200 }, HARSH, 100);
		expect(plan.groups).toEqual([200]);
		expect(plan.pids.sort()).toEqual([200, 201, 202]);
	});

	it("a member reparented to launchd but still in the session's group is the session's, in both modes", () => {
		const table = [...TABLE, row(203, 1, 200, "node watcher.js")];
		expect(planSessionKill(table, { pid: 200 }, GENTLE, 100).pids).toContain(203);
		expect(planSessionKill(table, { pid: 200 }, HARSH, 100).pids).toContain(203);
	});

	it("never includes a process outside the tree and group — not the runner, not another session, not the owner's work", () => {
		for (const policy of [GENTLE, HARSH]) {
			const pids = planSessionKill(TABLE, { pid: 200 }, policy, 100).pids;
			for (const other of [1, 100, 301, 302, 401, 500, 501, 502]) expect(pids, `${policy.mode} must not signal ${other}`).not.toContain(other);
		}
	});

	it("never signals pid 1 or the runner itself, whatever the table says", () => {
		const table = [row(100, 200, 200, "node runner"), row(200, 1, 200, "engine"), row(1, 200, 200, "init")];
		for (const policy of [GENTLE, HARSH]) expect(planSessionKill(table, { pid: 200 }, policy, 100).pids.sort()).toEqual([200]);
		expect(planSessionKill(TABLE, { pid: 1 }, HARSH, 100).groups).toEqual([]);
	});

	it("with the behaviour switched off, only the engine is signalled — the pre-#1265 behaviour", () => {
		const off: CleanupPolicy = { mode: "harsh", behaviours: { ...HARSH_BEHAVIOURS, processGroupKill: false } };
		expect(planSessionKill(TABLE, { pid: 200 }, off, 100)).toEqual({ groups: [], pids: [200] });
	});

	it("does not treat a group it did not create as its own", () => {
		// The engine's pgid is the runner's (100): it was not detached, so signalling "its group" would hit the runner.
		const table = [row(100, 1, 100, "runner"), row(200, 100, 100, "engine"), row(201, 200, 100, "child")];
		const plan = planSessionKill(table, { pid: 200 }, HARSH, 300);
		expect(plan.groups).toEqual([]);
		expect(plan.pids.sort()).toEqual([200, 201]);
		expect(plan.pids).not.toContain(100);
	});
});

describe("killSession — SIGTERM now, SIGKILL for survivors after the grace period", () => {
	function fakeOps(survivors: Set<number>) {
		const sent: Array<[number, string]> = [];
		const ops: SystemOps = {
			table: () => TABLE,
			signal: (t, sig) => {
				sent.push([t, sig]);
				if (sig === "SIGKILL" && t > 0) survivors.delete(t);
			},
			alive: (pid) => survivors.has(pid),
			sleep: async () => undefined,
		};
		return { ops, sent };
	}

	it("harsh: SIGTERMs the group and each pid, then SIGKILLs the group and whatever survived", async () => {
		const { ops, sent } = fakeOps(new Set([202])); // 202 ignores SIGTERM
		await killSession(200, HARSH, ops, 0);
		expect(sent.filter(([, s]) => s === "SIGTERM").map(([t]) => t).sort((a, b) => a - b)).toEqual([-200, 200, 201, 202]);
		expect(sent.filter(([, s]) => s === "SIGKILL").map(([t]) => t).sort((a, b) => a - b)).toEqual([-200, 202]);
	});

	it("gentle: never sends to a group, and escalates only the survivors", async () => {
		const { ops, sent } = fakeOps(new Set([201]));
		await killSession(200, GENTLE, ops, 0);
		expect(sent.every(([t]) => t > 0)).toBe(true);
		expect(sent.filter(([, s]) => s === "SIGKILL")).toEqual([[201, "SIGKILL"]]);
	});

	it("does not escalate when everything exited on SIGTERM", async () => {
		const { ops, sent } = fakeOps(new Set());
		await killSession(200, GENTLE, ops, 50);
		expect(sent.some(([, s]) => s === "SIGKILL")).toBe(false);
	});

	it("ignores a root pid it cannot trust", async () => {
		const { ops, sent } = fakeOps(new Set());
		expect(await killSession(0, HARSH, ops, 0)).toEqual([]);
		expect(await killSession(1, HARSH, ops, 0)).toEqual([]);
		expect(sent).toEqual([]);
	});
});

describe("2. the leftover sweep", () => {
	it("GENTLE never kills a process that is not marked as a session's — it only reports it", () => {
		const { kill, report } = planOrphanSweep(TABLE, ctx({ mode: "gentle" }));
		expect(kill).toEqual([]); // nothing carries the marker
		expect(report.map((o) => o.pid).sort()).toEqual([301, 302, 401, 502]);
		expect(report.map((o) => o.pid)).not.toContain(500); // the owner's own project is not even reported
		expect(report.map((o) => o.pid)).not.toContain(501); // nor their browser
	});

	it("GENTLE kills a leftover that carries a marker for a session that has ended", () => {
		const { kill } = planOrphanSweep(TABLE, ctx({ mode: "gentle", markers: new Map([[302, "ended-1"]]) }));
		expect(kill.map((o) => [o.pid, o.reason])).toEqual([[302, "marker"]]);
	});

	it("a marker for a session that is still LIVE is never swept, in either mode", () => {
		for (const mode of ["gentle", "harsh"] as const) {
			const { kill, report } = planOrphanSweep(TABLE, ctx({ mode, markers: new Map([[302, "live-1"]]) }));
			expect(kill.map((o) => o.pid)).not.toContain(302);
			expect(report.find((o) => o.pid === 302)?.reason).not.toBe("marker");
		}
	});

	it("HARSH also kills the ended session's group leftovers and orphaned tooling running out of a runner workdir", () => {
		const { kill } = planOrphanSweep(TABLE, ctx({ mode: "harsh" }));
		expect(kill.map((o) => [o.pid, o.reason]).sort((a, b) => (a[0] as number) - (b[0] as number))).toEqual([
			[301, "ledger-group"],
			[302, "ledger-group"],
			[401, "workdir-orphan"],
			[502, "workdir-orphan"],
		]);
	});

	it("HARSH still leaves the owner's own node project, their Chrome and everything under a live session alone", () => {
		const pids = planOrphanSweep(TABLE, ctx({ mode: "harsh" })).kill.map((o) => o.pid);
		for (const spared of [1, 100, 200, 201, 202, 500, 501]) expect(pids, `must spare ${spared}`).not.toContain(spared);
	});

	it("never selects a browser of any kind (Playwright's are the reaper's, a person's are nobody's)", () => {
		const chrome = [row(1, 0, 1, "init"), row(900, 1, 900, `${REPOS}/shop/node_modules/playwright-core/.local-browsers/chromium/chrome --headless`), row(901, 1, 901, "/usr/bin/google-chrome --user-data-dir=/home/x/.config/google-chrome")];
		for (const mode of ["gentle", "harsh"] as const) expect(planOrphanSweep(chrome, ctx({ mode, workdirs: [REPOS] })).kill).toEqual([]);
	});

	it("never selects the runner, its supervisors, or the sweeping process's own ancestry", () => {
		const table = [
			row(1, 0, 1, "init"),
			row(10, 1, 10, "node /usr/local/bin/pags up"),
			row(11, 1, 11, "node /opt/proagentstore/cli/dist/index.js runner connect"),
			row(20, 1, 20, `node ${REPOS}/x/server.js`),
			row(30, 20, 20, "node runner-child"),
		];
		const pids = planOrphanSweep(table, ctx({ mode: "harsh", self: 30, liveRoots: [] })).kill.map((o) => o.pid);
		expect(pids).not.toContain(10);
		expect(pids).not.toContain(11);
		expect(pids).not.toContain(20); // the sweeper's own ancestor
		expect(pids).not.toContain(30);
	});

	it("only an ORPHAN (parent 1) is a candidate: a tool with a living parent is somebody's job", () => {
		const table = [row(1, 0, 1, "init"), row(50, 777, 50, `node ${REPOS}/x/node_modules/.bin/vite`), row(777, 1, 777, "some-shell")];
		expect(planOrphanSweep(table, ctx({ mode: "harsh", liveRoots: [] })).report).toEqual([]);
	});

	it("a tool outside every runner workdir is not swept by heuristic", () => {
		const table = [row(1, 0, 1, "init"), row(60, 1, 60, "node /Users/x/other/node_modules/.bin/vite")];
		expect(planOrphanSweep(table, ctx({ mode: "harsh", liveRoots: [] })).report).toEqual([]);
	});
});

describe("5. load the sessions do not explain", () => {
	it("warns when load is far above what the sessions account for — the Mac mini and pink-laptop cases", () => {
		expect(loadMismatch({ load1: 283, cpus: 12, sessionsCpuPct: 450 })).toMatchObject({ mismatch: true });
		expect(loadMismatch({ load1: 82, cpus: 4, sessionsCpuPct: 80 })).toMatchObject({ mismatch: true });
	});
	it("does not warn when the sessions explain the load, when load is modest, or when it could not be measured", () => {
		expect(loadMismatch({ load1: 11, cpus: 12, sessionsCpuPct: 1000 }).mismatch).toBe(false);
		expect(loadMismatch({ load1: 6, cpus: 12, sessionsCpuPct: 10 }).mismatch).toBe(false);
		expect(loadMismatch({ load1: 90, cpus: 4, sessionsCpuPct: null }).mismatch).toBe(false);
	});
});

describe("a person's own Chrome is never a Playwright profile", () => {
	it("recognises Playwright's throwaway profile and nothing a person keeps", () => {
		expect(isPlaywrightTempProfile("/tmp/playwright_chromiumdev_profile-AbC123", ["/tmp"])).toBe(true);
		expect(isPlaywrightTempProfile("/Users/x/Library/Application Support/Google/Chrome", ["/tmp"])).toBe(false);
		expect(isPlaywrightTempProfile("/Users/x/.config/google-chrome", ["/tmp"])).toBe(false);
	});
});

describe("4. per-run temp folders and worktrees", () => {
	let base: string;
	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "pags-cleanup-"));
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("a run's temp folder is made under <base>/tmp/<session> and removed when it ends", () => {
		const m = new CleanupManager({ baseDir: base, reposBaseDir: join(base, "repos"), ops: noOps(), git: gitNone, log: () => undefined, registerExitHook: false });
		const { tmpDir } = m.startSession("s1", join(base, "repos", "x"));
		expect(tmpDir).toBe(sessionTmpDir(base, "s1"));
		writeFileSync(join(tmpDir as string, "scratch.bin"), "x");
		expect(existsSync(tmpDir as string)).toBe(true);
		expect(removeSessionTmp(base, "s1")).toBe(true);
		expect(existsSync(tmpDir as string)).toBe(false);
	});

	it("the id cannot escape the tmp directory", () => {
		const dir = sessionTmpDir(base, "../../etc");
		expect(dir.startsWith(join(base, "tmp"))).toBe(true);
		mkdirSync(join(base, "keepme"), { recursive: true });
		removeSessionTmp(base, "../keepme");
		expect(existsSync(join(base, "keepme"))).toBe(true);
	});

	it("temp folders are removed in BOTH modes when the session ends", async () => {
		for (const policy of [GENTLE, HARSH]) {
			const m = new CleanupManager({ baseDir: base, reposBaseDir: join(base, "repos"), ops: noOps(), git: gitNone, log: () => undefined, registerExitHook: false });
			m.setPolicy(policy);
			const { tmpDir } = m.startSession(`s-${policy.mode}`, join(base, "repos", "x"));
			expect(existsSync(tmpDir as string)).toBe(true);
			const report = await m.endSession(`s-${policy.mode}`, new Set(), []);
			expect(existsSync(tmpDir as string), policy.mode).toBe(false);
			expect(report.tempFoldersRemoved).toBe(1);
			m.stopTimers();
		}
	});

	it("with the behaviour off, no temp folder is made or removed", async () => {
		const m = new CleanupManager({ baseDir: base, reposBaseDir: join(base, "repos"), ops: noOps(), git: gitNone, log: () => undefined, registerExitHook: false });
		m.setPolicy({ mode: "gentle", behaviours: { ...GENTLE_BEHAVIOURS, tempCleanup: false } });
		expect(m.startSession("s1", base).tmpDir).toBeNull();
	});

	it("harsh sweeps runner temp folders older than 24h and leaves live and young ones", () => {
		const root = join(base, "tmp");
		for (const name of ["old", "young", "live"]) mkdirSync(join(root, name), { recursive: true });
		const old = (Date.now() - 30 * 3600_000) / 1000;
		utimesSync(join(root, "old"), old, old);
		utimesSync(join(root, "live"), old, old);
		const removed = sweepOldSessionTmp(base, 24 * 3600_000, new Set(["live"]));
		expect(removed).toEqual([join(root, "old")]);
		expect(existsSync(join(root, "young"))).toBe(true);
		expect(existsSync(join(root, "live"))).toBe(true);
	});

	it("removes the worktrees a run created and keeps one with uncommitted changes", () => {
		const calls: string[][] = [];
		const git: Git = (_cwd, args) => {
			calls.push(args);
			if (args[0] === "worktree" && args[1] === "list") return { ok: true, out: "worktree /w/main\nHEAD abc\n\nworktree /w/pre\n\nworktree /w/new-clean\n\nworktree /w/new-dirty\n" };
			if (args[0] === "worktree" && args[1] === "remove") return { ok: args[2] !== "/w/new-dirty", out: "" }; // git refuses a dirty one without --force
			return { ok: true, out: "" };
		};
		const out = removeNewWorktrees("/w/main", ["/w/main", "/w/pre"], git);
		expect(out).toEqual({ removed: ["/w/new-clean"], kept: ["/w/new-dirty"] });
		expect(calls.some((a) => a.includes("--force"))).toBe(false); // uncommitted work is never forced away
		expect(listWorktrees("/w/main", git)).toContain("/w/pre");
	});
});

describe("+. cache pruning is limited to caches and ignored build outputs", () => {
	let base: string;
	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "pags-prune-"));
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	function repo(name: string, outputs: string[]) {
		const dir = join(base, "repos", name);
		mkdirSync(join(dir, ".git"), { recursive: true });
		for (const o of outputs) {
			mkdirSync(join(dir, o), { recursive: true });
			writeFileSync(join(dir, o, "file"), "x");
		}
		writeFileSync(join(dir, "src.ts"), "source");
		return dir;
	}

	it("removes git-ignored build outputs only, never source and never a tracked path", () => {
		const a = repo("a", ["dist", ".next"]);
		const git: Git = (cwd, args) => ({ ok: args[0] === "check-ignore" && args[2] !== "dist" || cwd === "never", out: "" }); // dist is tracked in this repo
		const r = pruneCaches({ reposBaseDir: join(base, "repos"), busyDirs: [], home: base, run: () => false, git });
		expect(r.removedOutputs).toEqual([join(a, ".next")]);
		expect(r.skipped).toContain(join(a, "dist"));
		expect(existsSync(join(a, "dist", "file"))).toBe(true);
		expect(existsSync(join(a, "src.ts"))).toBe(true);
	});

	it("leaves a checkout a live session is using untouched", () => {
		const busy = repo("busy", ["dist"]);
		repo("idle", ["dist"]);
		const r = pruneCaches({ reposBaseDir: join(base, "repos"), busyDirs: [busy], home: base, run: () => false, git: () => ({ ok: true, out: "" }) });
		expect(r.removedOutputs.some((p) => p.includes("busy"))).toBe(false);
		expect(existsSync(join(busy, "dist"))).toBe(true);
		expect(r.removedOutputs.some((p) => p.includes("idle"))).toBe(true);
	});

	it("prunes the package caches through their own commands", () => {
		const ran: string[] = [];
		const r = pruneCaches({ reposBaseDir: join(base, "none"), busyDirs: [], home: base, run: (cmd, args) => {
				ran.push(`${cmd} ${args.join(" ")}`);
				return true;
			}, git: gitNone });
		expect(ran).toEqual(["pnpm store prune", "npm cache clean --force"]);
		expect(r.prunedCaches).toEqual(["pnpm store", "npm cache"]);
	});

	it("only a directory that is a git checkout is a candidate", () => {
		const dir = join(base, "repos", "plain");
		mkdirSync(join(dir, "dist"), { recursive: true });
		pruneCaches({ reposBaseDir: join(base, "repos"), busyDirs: [], home: base, run: () => false, git: () => ({ ok: true, out: "" }) });
		expect(existsSync(join(dir, "dist"))).toBe(true);
	});
});

describe("the manager — mode decides what the disk and load readings trigger", () => {
	let base: string;
	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "pags-mgr-"));
		mkdirSync(join(base, "repos", "r", ".git"), { recursive: true });
		mkdirSync(join(base, "repos", "r", "dist"), { recursive: true });
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	const fullDisk = ((): typeof import("node:fs").statfsSync => (() => ({ blocks: 1000, bsize: 1, bavail: 50 })) as never)(); // 95% used
	const roomyDisk = ((): typeof import("node:fs").statfsSync => (() => ({ blocks: 1000, bsize: 1, bavail: 700 })) as never)(); // 30% used

	const manager = (statfs: typeof import("node:fs").statfsSync, logs: string[] = []) =>
		new CleanupManager({ baseDir: base, reposBaseDir: join(base, "repos"), ops: noOps(), git: () => ({ ok: true, out: "" }), log: (l) => logs.push(l), registerExitHook: false, statfs });

	it("HARSH prunes build outputs when the disk is over 90%", async () => {
		const m = manager(fullDisk);
		m.setPolicy(HARSH);
		await m.observe({ load1: 1, cpus: 4, sessionsCpuPct: 10, diskPath: base }, new Set(), []);
		expect(existsSync(join(base, "repos", "r", "dist"))).toBe(false);
		m.stopTimers();
	});

	it("HARSH does not prune while the disk has room", async () => {
		const m = manager(roomyDisk);
		m.setPolicy(HARSH);
		await m.observe({ load1: 1, cpus: 4, sessionsCpuPct: 10, diskPath: base }, new Set(), []);
		expect(existsSync(join(base, "repos", "r", "dist"))).toBe(true);
		m.stopTimers();
	});

	it("GENTLE never prunes — it warns instead", async () => {
		const m = manager(fullDisk);
		m.setPolicy(GENTLE);
		await m.observe({ load1: 1, cpus: 4, sessionsCpuPct: 10, diskPath: base }, new Set(), []);
		expect(existsSync(join(base, "repos", "r", "dist"))).toBe(true);
		expect(m.status(base).warnings.join(" ")).toMatch(/disk is 95% full and cache pruning is off/);
	});

	it("gentle only WARNS about a load mismatch; harsh also sweeps", async () => {
		const ops = noOps([row(1, 0, 1, "init"), row(77, 1, 77, `node ${join(base, "repos")}/r/node_modules/.bin/vite`)]);
		const g = new CleanupManager({ baseDir: base, reposBaseDir: join(base, "repos"), ops, git: gitNone, log: () => undefined, registerExitHook: false, statfs: roomyDisk });
		g.setPolicy(GENTLE);
		await g.observe({ load1: 80, cpus: 4, sessionsCpuPct: 20, diskPath: base }, new Set(), []);
		expect(g.status(base).loadMismatch).toBe(true);
		expect(g.status(base).warnings.join(" ")).toMatch(/leftover processes are likely/);
		expect(ops.sent.filter(([, s]) => s === "SIGTERM")).toEqual([]); // warned, did not touch

		const h = new CleanupManager({ baseDir: base, reposBaseDir: join(base, "repos"), ops, git: gitNone, log: () => undefined, registerExitHook: false, statfs: roomyDisk });
		h.setPolicy(HARSH);
		await h.observe({ load1: 80, cpus: 4, sessionsCpuPct: 20, diskPath: base }, new Set(), []);
		expect(ops.sent.filter(([, s]) => s === "SIGTERM").map(([t]) => t)).toEqual([77]); // the harsh sweep ended the orphaned vite
		h.stopTimers();
	});

	it("the load warning can be switched off per machine", async () => {
		const m = manager(roomyDisk);
		m.setPolicy({ mode: "gentle", behaviours: { ...GENTLE_BEHAVIOURS, loadWarning: false } });
		await m.observe({ load1: 80, cpus: 4, sessionsCpuPct: 20, diskPath: base }, new Set(), []);
		expect(m.status(base).loadMismatch).toBe(false);
	});

	it("reports the active mode, the switches and the orphans it left alone, for the heartbeat", async () => {
		const ops = noOps([row(1, 0, 1, "init"), row(77, 1, 300, "node /x/y.js")]);
		const m = new CleanupManager({ baseDir: base, reposBaseDir: join(base, "repos"), ops, git: gitNone, log: () => undefined, registerExitHook: false, statfs: roomyDisk });
		m.setPolicy(GENTLE);
		m.startSession("ended-1", base);
		m.noteProcess("ended-1", 300);
		await m.endSession("ended-1", new Set(), []);
		const s = m.status(base);
		expect(s.mode).toBe("gentle");
		expect(s.behaviours).toEqual(GENTLE_BEHAVIOURS);
		expect(s.orphanedProcesses).toBe(1);
		expect(s.orphans[0]).toMatchObject({ pid: 77, reason: "ledger-group", sessionId: "ended-1" });
		expect(ops.sent).toEqual([]); // reported, not killed
	});

	it("a pass on demand reports what it did and the bytes it freed", async () => {
		let free = 100;
		const statfs = (() => ({ blocks: 1000, bsize: 1, bavail: free })) as never;
		const m = new CleanupManager({ baseDir: base, reposBaseDir: join(base, "repos"), ops: noOps(), git: () => ({ ok: true, out: "" }), log: () => undefined, registerExitHook: false, statfs });
		m.setPolicy(HARSH);
		const dist = join(base, "repos", "r", "dist");
		const orig = existsSync(dist);
		expect(orig).toBe(true);
		const pass = m.runPass("test", new Set(), []);
		free = 400; // the prune freed space
		const report = await pass;
		expect(report.buildOutputsRemoved).toBe(1);
		expect(report.reason).toBe("test");
		expect(report.freedBytes === null || report.freedBytes >= 0).toBe(true);
		m.stopTimers();
	});

	it("never throws: a sweep that cannot read the process table costs nothing", async () => {
		const ops = { ...noOps(), table: () => null } as SystemOps;
		const m = new CleanupManager({ baseDir: base, reposBaseDir: join(base, "repos"), ops, git: gitNone, log: () => undefined, registerExitHook: false });
		await expect(m.endSession("nope", new Set(), [])).resolves.toMatchObject({ orphansFound: 0 });
	});
});

// ── helpers ──
const gitNone: Git = () => ({ ok: false, out: "" });
function noOps(table: ProcRow[] = []): SystemOps & { sent: Array<[number, string]> } {
	const sent: Array<[number, string]> = [];
	return { sent, table: () => table, signal: (t, s) => void sent.push([t, s]), alive: () => false, sleep: async () => undefined };
}
void vi;
