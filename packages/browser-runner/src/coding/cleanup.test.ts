import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CleanupManager,
	createSocketSafeTmp,
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
	removeSocketSafeTmp,
	sessionTmpDir,
	socketSafeTmpDir,
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

	it("#1470: a failed FIRST ps read still kills the engine's children once a later read succeeds", async () => {
		// Models readProcessTable() timing out/failing once under load: the first table() call returns
		// null, so the initial plan sees no descendants at all — only the root can be signalled. Every
		// call after that succeeds, the way the issue's own evidence showed a retried `ps` recovering
		// in well under a second.
		let calls = 0;
		const survivors = new Set([201]); // 201 ignores SIGTERM; 202 and the root die on it
		const sent: Array<[number, string]> = [];
		const ops: SystemOps = {
			table: () => (calls++ === 0 ? null : TABLE),
			signal: (t, sig) => {
				sent.push([t, sig]);
				if (sig === "SIGKILL" && t > 0) survivors.delete(t);
			},
			alive: (pid) => survivors.has(pid),
			sleep: async () => undefined,
		};
		const result = await killSession(200, GENTLE, ops, 50);
		// The root was signalled immediately despite the degraded first read — the engine still stops.
		expect(sent[0]).toEqual([200, "SIGTERM"]);
		// 201 and 202 are the root's real descendants: the first read missed them entirely, but a later
		// read found them and they were SIGTERM'd too, not left running forever.
		const termed = sent.filter(([, s]) => s === "SIGTERM").map(([t]) => t);
		expect(termed).toContain(201);
		expect(termed).toContain(202);
		// 201 never responded to SIGTERM, so it is escalated to SIGKILL like any other survivor would be.
		expect(sent.filter(([, s]) => s === "SIGKILL")).toEqual([[201, "SIGKILL"]]);
		expect(result.sort((a, b) => a - b)).toEqual([200, 201, 202]);
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

// #1565: tsx's own IPC pipe, bound through a Unix domain socket under `$TMPDIR`, hit a REAL
// `EADDRINUSE` in `pnpm -w test:full` — reproduced directly: `sessionTmpDir` under a realistic long
// `baseDir` already measures at or past macOS's 104-byte `sockaddr_un.sun_path`, so any socket-using
// tool an engine spawns (tsx, esbuild, Vite, …) that appends its own subdirectory and filename on top
// of `TMPDIR` silently collides — `bind()` returns `EADDRINUSE` against the kernel's truncated prefix,
// not `ENAMETOOLONG`, and on the very FIRST bind, no live listener or stale socket required at all.
//
// `/tmp` is shared machine-wide: every socket-safe dir is named from `(uid, baseDir, sessionId)`, not
// the session id alone, and ownership (uid + mode + "not a symlink") is verified on every use — a
// short, predictable name is not by itself proof of who owns the path at that name.
describe("4b. the TMPDIR an engine is given stays short enough for a Unix domain socket", () => {
	// A deliberately long, realistic `baseDir` — same shape as `~/.config/proagentstore/browser-runner`
	// under a long username. On the real machine that hit this, `sessionTmpDir` alone measured 96
	// bytes (not independently at the 104-byte limit) — it was tsx's OWN `tsx-<euid>` subdirectory,
	// stacked on top, that reached exactly 104 before any filename; the synthetic id below is
	// deliberately longer than a real `csess_<uuid>` so `sessionTmpDir` alone clears 100 in this test.
	const LONG_BASE = join("/tmp", "pags-cleanup-repro", "home", "a-fairly-long-real-username", ".config", "proagentstore", "browser-runner");
	const OTHER_BASE = join("/tmp", "pags-cleanup-repro", "home", "a-different-runner-install", ".config", "proagentstore", "browser-runner");
	const LONG_SESSION_ID = `csess_${"a1b2c3d4-".repeat(4)}end`; // well past the real 36-char uuid

	const manager = (baseDir: string) => new CleanupManager({ baseDir, reposBaseDir: join(baseDir, "repos"), ops: noOps(), git: gitNone, log: () => undefined, registerExitHook: false });

	const allocatedDirs: string[] = [];
	afterEach(() => {
		for (const d of allocatedDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("sessionTmpDir alone is long enough to prove this isn't a hypothetical", () => {
		// The exact failure mode measured on a real machine: the content dir by itself at or past the limit.
		expect(Buffer.byteLength(sessionTmpDir(LONG_BASE, LONG_SESSION_ID))).toBeGreaterThan(100);
	});

	it("socketSafeTmpDir stays short regardless of how long baseDir/sessionId are, with real headroom for a nested tool", () => {
		const dir = socketSafeTmpDir(LONG_BASE, LONG_SESSION_ID);
		// Headroom budget: tsx's own nested usage alone is `tsx-<uid>/<pid>.pipe`, ~20-25 bytes; leave room for more.
		expect(Buffer.byteLength(dir)).toBeLessThan(50);
		expect(dir.startsWith("/tmp/")).toBe(true);
	});

	it("different session ids under the SAME base get different socket-safe dirs — no cross-session collision", () => {
		expect(socketSafeTmpDir(LONG_BASE, "s1")).not.toBe(socketSafeTmpDir(LONG_BASE, "s2"));
		expect(socketSafeTmpDir(LONG_BASE, LONG_SESSION_ID)).not.toBe(socketSafeTmpDir(LONG_BASE, `${LONG_SESSION_ID}x`));
	});

	it("the SAME session id under two different runner/base identities gets two different dirs — no cross-runner collision", () => {
		// Two runner installations (or two accounts) could independently mint the exact same session
		// id string; without baseDir folded into the name, they'd compute the same /tmp leaf.
		const a = socketSafeTmpDir(LONG_BASE, LONG_SESSION_ID);
		const b = socketSafeTmpDir(OTHER_BASE, LONG_SESSION_ID);
		expect(a).not.toBe(b);
	});

	it("engineEnv exports the socket-safe dir, not the long content dir, as TMPDIR/TMP/TEMP", () => {
		const m = manager(LONG_BASE);
		const env = m.engineEnv({ PATH: "/usr/bin" }, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		allocatedDirs.push(env.TMPDIR as string);
		expect(env.TMPDIR).toBe(socketSafeTmpDir(LONG_BASE, LONG_SESSION_ID));
		expect(env.TMP).toBe(env.TMPDIR);
		expect(env.TEMP).toBe(env.TMPDIR);
		expect(Buffer.byteLength(env.TMPDIR as string)).toBeLessThan(50);
		expect(existsSync(env.TMPDIR as string)).toBe(true); // created, not just computed — a child can write into it immediately
	});

	it("refuses a pre-existing path at that name owned by someone else, and does NOT fall back to the long unsafe path", () => {
		const dir = socketSafeTmpDir(LONG_BASE, LONG_SESSION_ID);
		mkdirSync(dirname(dir), { recursive: true });
		mkdirSync(dir, { mode: 0o777 }); // "someone else's" stand-in: wide-open mode, as a planted dir would be
		allocatedDirs.push(dir);
		const m = manager(LONG_BASE);
		const env = m.engineEnv({ PATH: "/usr/bin" }, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		// Refused — and critically, NOT silently handed the long content dir as a fallback.
		expect(env.TMPDIR).toBeUndefined();
		expect(env.TMP).toBeUndefined();
		expect(env.TEMP).toBeUndefined();
	});

	it("refuses a pre-existing SYMLINK at that name, and never follows or deletes through it", () => {
		const dir = socketSafeTmpDir(LONG_BASE, LONG_SESSION_ID);
		mkdirSync(dirname(dir), { recursive: true });
		const trapTarget = mkdtempSync(join(tmpdir(), "pags-symlink-trap-"));
		writeFileSync(join(trapTarget, "do-not-delete-me"), "x");
		symlinkSync(trapTarget, dir);
		allocatedDirs.push(dir, trapTarget);
		const m = manager(LONG_BASE);
		const env = m.engineEnv({}, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		expect(env.TMPDIR).toBeUndefined(); // refused, not followed
		// removeSocketSafeTmp must also refuse to recurse through the symlink, even if called directly.
		expect(removeSocketSafeTmp(LONG_BASE, LONG_SESSION_ID)).toBe(false);
		expect(existsSync(join(trapTarget, "do-not-delete-me"))).toBe(true);
	});

	it("a real Unix domain socket binds inside the exported TMPDIR, nested exactly as tsx nests its own IPC pipe — this is what actually failed before the fix", async () => {
		const m = manager(LONG_BASE);
		const env = m.engineEnv({}, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		allocatedDirs.push(env.TMPDIR as string);
		// Mirrors tsx's own `getPipePath`: `${TMPDIR}/tsx-<euid>/<pid>.pipe`.
		const nested = join(env.TMPDIR as string, "tsx-501", "92237.pipe");
		mkdirSync(dirname(nested), { recursive: true });
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.on("error", reject);
			server.listen(nested, resolve);
		});
		expect(Buffer.byteLength(nested)).toBeLessThan(100); // under the real sun_path budget, with margin
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("parallel sessions each get a DISTINCT dir that binds without colliding — fixed filenames, so only directory isolation can prevent the collision", async () => {
		const ids = Array.from({ length: 8 }, (_, i) => `${LONG_SESSION_ID}-parallel-${i}`);
		const m = manager(LONG_BASE);
		const dirs = ids.map((id) => socketSafeTmpDir(LONG_BASE, id));
		expect(new Set(dirs).size).toBe(ids.length); // pairwise distinct, proven directly — not inferred from bind success alone
		let servers: net.Server[] = [];
		try {
			servers = await Promise.all(
				ids.map(async (id) => {
					const env = m.engineEnv({}, id, join(LONG_BASE, "repos", "x"));
					allocatedDirs.push(env.TMPDIR as string);
					// Same fixed filename in every iteration: a random name could mask a directory-isolation bug.
					const nested = join(env.TMPDIR as string, "tsx-501", "92237.pipe");
					mkdirSync(dirname(nested), { recursive: true });
					const server = net.createServer();
					await new Promise<void>((resolve, reject) => {
						server.on("error", reject);
						server.listen(nested, resolve);
					});
					return server;
				}),
			);
			expect(servers).toHaveLength(ids.length);
		} finally {
			await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
		}
	});

	it("removeSocketSafeTmp only ever removes its own leaf under /tmp, and endSession cleans it up", async () => {
		// The leaf is a hash of (uid, baseDir, id), not the raw id, so there is no path-escape vector to
		// defend against the way `removeSessionTmp` does — a weird id just hashes to a different, still-safe leaf.
		expect(removeSocketSafeTmp(LONG_BASE, "../etc")).toBe(true); // nothing exists there yet; rm({force:true}) is a no-op success
		expect(dirname(socketSafeTmpDir(LONG_BASE, "../etc"))).toBe("/tmp");
		const m = manager(LONG_BASE);
		const env = m.engineEnv({}, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		expect(existsSync(env.TMPDIR as string)).toBe(true);
		await m.endSession(LONG_SESSION_ID, new Set(), []);
		expect(existsSync(env.TMPDIR as string)).toBe(false);
	});

	it("a long-lived but still-LIVE session's socket-safe dir survives a harsh sweep regardless of age", async () => {
		const m = manager(LONG_BASE);
		const env = m.engineEnv({}, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		const dir = env.TMPDIR as string;
		allocatedDirs.push(dir);
		const old = (Date.now() - 30 * 3600_000) / 1000;
		utimesSync(dir, old, old); // far older than the 24h harsh threshold
		m.setPolicy(HARSH);
		// The session is still live (named in liveSessionIds) at every call site that matters for a real sweep.
		await m.runPass("test", new Set([LONG_SESSION_ID]), []);
		expect(existsSync(dir)).toBe(true);
	});

	it("a dir this manager never allocated (a different runner's, or planted directly) is never touched by a sweep", async () => {
		const foreign = socketSafeTmpDir(OTHER_BASE, "foreign-session");
		mkdirSync(foreign, { recursive: true, mode: 0o700 });
		allocatedDirs.push(foreign);
		const old = (Date.now() - 30 * 3600_000) / 1000;
		utimesSync(foreign, old, old);
		const m = manager(LONG_BASE); // a DIFFERENT manager — never recorded allocating `foreign`
		m.setPolicy(HARSH);
		await m.runPass("test", new Set(), []);
		// No global /tmp scan: a path this manager never recorded is never a sweep candidate, regardless of age.
		expect(existsSync(foreign)).toBe(true);
	});

	it("an ended (no-longer-live), old socket-safe dir IS swept, since nothing else owns cleaning it up", async () => {
		// SAME manager throughout, deliberately: it genuinely tracked this dir via its own `engineEnv`
		// call, so this exercises the sweep's real path. (An earlier version of this test simulated "a
		// crash that skipped endSession" by manually re-creating the directory and feeding it to a
		// SECOND, unrelated manager instance via `engineEnv` — i.e. relying on that second call silently
		// ADOPTING a pre-existing path. That adoption is exactly what the atomic, non-recursive
		// `createSocketSafeTmp` now refuses, so a fresh manager can no longer rediscover an orphan this
		// way; see the fresh-manager/sentinel test above for proof of that refusal. What "a crash that
		// skipped endSession" actually needs here is simpler: the SAME manager, never told to end the
		// session, but the caller's own liveness answer — `liveSessionIds` — says it is no longer live.)
		const m = manager(LONG_BASE);
		const env = m.engineEnv({}, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		const dir = env.TMPDIR as string;
		allocatedDirs.push(dir);
		const old = (Date.now() - 30 * 3600_000) / 1000;
		utimesSync(dir, old, old);
		m.setPolicy(HARSH);
		await m.runPass("test", new Set(), []); // NOT in liveSessionIds: this session has ended from the caller's point of view
		expect(existsSync(dir)).toBe(false);
	});

	// #1411-adjacent review: four corrections to the fix above, each regressed here against its own failure mode.

	it("a refusal strips an INHERITED unsafe TMPDIR from base, not just omits setting a new one", () => {
		const dir = socketSafeTmpDir(LONG_BASE, LONG_SESSION_ID);
		mkdirSync(dirname(dir), { recursive: true });
		mkdirSync(dir, { mode: 0o777 }); // forces the refusal path, same as the "owned by someone else" test above
		allocatedDirs.push(dir);
		const m = manager(LONG_BASE);
		// `base` stands in for this runner's OWN spawn env, which can itself already carry a
		// session-scoped override inherited from whatever started the runner process — exactly the
		// over-length kind of value this whole fix exists to keep an engine from ever seeing.
		const inherited = sessionTmpDir(LONG_BASE, "some-other-already-running-session");
		const env = m.engineEnv({ TMPDIR: inherited, TMP: inherited, TEMP: inherited, PATH: "/usr/bin" }, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		expect(env.TMPDIR).toBeUndefined();
		expect(env.TMP).toBeUndefined();
		expect(env.TEMP).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin"); // only the three temp vars are stripped, nothing else in base
	});

	it("the hash tuple cannot be forged by a delimiter-boundary collision — two different (baseDir, sessionId) pairs that concatenate identically under a space join still hash differently", () => {
		// Old bug: `${uid} ${baseDir} ${sessionId}` for ("/a b", "c") and ("/a", "b c") both produce
		// the literal string "<uid> /a b c" — a plain delimiter join cannot tell the two apart.
		const a = socketSafeTmpDir("/a b", "c");
		const b = socketSafeTmpDir("/a", "b c");
		expect(a).not.toBe(b);
	});

	it("a literal NUL byte in a session id does not collide with a differently-NUL-placed id — proves the encoding never embeds a raw byte", () => {
		const a = socketSafeTmpDir(LONG_BASE, "left\0right");
		const b = socketSafeTmpDir(LONG_BASE, "lef\0tright");
		expect(a).not.toBe(b);
	});

	describe("on win32, the whole socket-safe redirection is inert — Windows named pipes were never bound by sun_path", () => {
		const realPlatform = process.platform;
		beforeEach(() => Object.defineProperty(process, "platform", { value: "win32", configurable: true }));
		afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform, configurable: true }));

		it("createSocketSafeTmp refuses outright rather than mkdir a meaningless /tmp-joined path", () => {
			expect(createSocketSafeTmp(LONG_BASE, LONG_SESSION_ID)).toBeNull();
		});

		it("engineEnv exports the ORIGINAL long content dir unchanged — pre-fix behaviour, since nothing was ever broken here", () => {
			const m = manager(LONG_BASE);
			const env = m.engineEnv({}, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
			allocatedDirs.push(env.TMPDIR as string);
			expect(env.TMPDIR).toBe(sessionTmpDir(LONG_BASE, LONG_SESSION_ID));
			expect(env.TMP).toBe(env.TMPDIR);
			expect(env.TEMP).toBe(env.TMPDIR);
		});
	});

	it("endSession never removes an arbitrary same-uid pre-existing private directory that happens to sit at the hash path — only a dir THIS manager actually tracked allocating", async () => {
		const neverAllocatedId = `${LONG_SESSION_ID}-never-called-engineEnv`;
		const coincidence = socketSafeTmpDir(LONG_BASE, neverAllocatedId);
		// Stands in for an unrelated private directory of the SAME uid that happens to sit at this
		// hash's path — passes every ownership check `isOwnedSafeDir` runs, but this manager never
		// allocated it via `engineEnv`, so it is not this session's socket-safe dir to remove.
		mkdirSync(coincidence, { recursive: true, mode: 0o700 });
		writeFileSync(join(coincidence, "not-ours"), "x");
		allocatedDirs.push(coincidence);
		const m = manager(LONG_BASE);
		m.startSession(neverAllocatedId, join(LONG_BASE, "repos", "x")); // tracks the session; never calls engineEnv for it
		await m.endSession(neverAllocatedId, new Set(), []);
		expect(existsSync(coincidence)).toBe(true);
		expect(existsSync(join(coincidence, "not-ours"))).toBe(true);
	});

	it("a precreated same-uid 0700 sentinel is refused by engineEnv (not adopted), and survives endSession AND a harsh sweep intact", async () => {
		const sentinelId = `${LONG_SESSION_ID}-sentinel`;
		const sentinel = socketSafeTmpDir(LONG_BASE, sentinelId);
		// Planted BEFORE engineEnv ever runs — same uid, mode 0700, a real directory: exactly the
		// shape that passed `isOwnedSafeDir` under the old `{recursive:true}` mkdir and got silently
		// adopted. The atomic non-recursive mkdir + EEXIST refusal must now reject it on sight.
		mkdirSync(sentinel, { recursive: true, mode: 0o700 });
		writeFileSync(join(sentinel, "sentinel-marker"), "do not touch");
		allocatedDirs.push(sentinel);
		const m = manager(LONG_BASE);
		const env = m.engineEnv({}, sentinelId, join(LONG_BASE, "repos", "x"));
		expect(env.TMPDIR).toBeUndefined(); // refused, not adopted
		expect(existsSync(join(sentinel, "sentinel-marker"))).toBe(true); // untouched by the refusal itself
		await m.endSession(sentinelId, new Set(), []);
		expect(existsSync(join(sentinel, "sentinel-marker"))).toBe(true); // never tracked, so endSession leaves it alone
		m.setPolicy(HARSH);
		await m.runPass("test", new Set(), []);
		expect(existsSync(join(sentinel, "sentinel-marker"))).toBe(true); // never tracked, so the sweep leaves it alone too
	});

	it("preserves repeated legitimate engineEnv calls for the same session — the second call reuses the tracked dir instead of refusing on its own prior allocation", () => {
		const m = manager(LONG_BASE);
		const first = m.engineEnv({}, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		allocatedDirs.push(first.TMPDIR as string);
		expect(first.TMPDIR).toBeDefined();
		const second = m.engineEnv({}, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		expect(second.TMPDIR).toBe(first.TMPDIR); // same dir, not a refusal from colliding with its own prior mkdir
		expect(existsSync(second.TMPDIR as string)).toBe(true);
	});

	// #1411-adjacent review, second pass: the path string alone is not proof of identity — `/tmp` is
	// world-writable, so the tracked path could be removed and replaced by something else between
	// allocation and a later reuse or removal. Both must detect the swap and treat it as "not ours",
	// never silently reuse or delete the replacement.

	it("a REUSE after the tracked path was swapped out from under it detects the swap and refuses, rather than handing the engine someone else's directory", () => {
		const m = manager(LONG_BASE);
		const first = m.engineEnv({}, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		const dir = first.TMPDIR as string;
		allocatedDirs.push(dir);
		// Swap: move the directory this manager created aside and put a DIFFERENT one at the exact same
		// path — same uid, same mode, same name; only the inode differs. Moved aside, not deleted: Linux
		// hands a freed inode number to the next directory created, so delete-and-recreate can reproduce
		// the same dev+ino, which no dev+ino check can tell apart. Only a same-uid process can swap a
		// 0700 dir in sticky /tmp at all, and it could delete the dir outright, so that case is no
		// privilege boundary; a replacement with a different inode is what this check exists to catch.
		renameSync(dir, `${dir}-moved-aside`);
		allocatedDirs.push(`${dir}-moved-aside`);
		mkdirSync(dir, { mode: 0o700 });
		writeFileSync(join(dir, "not-the-original"), "x");
		const second = m.engineEnv({}, LONG_SESSION_ID, join(LONG_BASE, "repos", "x"));
		// Refused, not handed the swapped-in replacement: the identity check fails, falls through to a
		// fresh create attempt, which finds the replacement occupying the path and refuses on EEXIST.
		expect(second.TMPDIR).toBeUndefined();
		expect(existsSync(join(dir, "not-the-original"))).toBe(true); // refusal never touches the replacement
	});

	it("a REMOVAL after the tracked path was swapped out from under it detects the swap and leaves the replacement alone — through both endSession and the sweep", async () => {
		// Distinct session ids per sub-case: each hashes to its own path, so one case's deliberately
		// un-removed swapped leftover can never collide with the other's fresh allocation.
		const swapAndVerify = async (sessionId: string, end: (m: CleanupManager) => Promise<void>) => {
			const m = manager(LONG_BASE);
			const first = m.engineEnv({}, sessionId, join(LONG_BASE, "repos", "x"));
			const dir = first.TMPDIR as string;
			// Moved aside, not deleted — see the REUSE test above for why (Linux inode reuse).
			renameSync(dir, `${dir}-moved-aside`);
			allocatedDirs.push(`${dir}-moved-aside`);
			mkdirSync(dir, { mode: 0o700 });
			writeFileSync(join(dir, "not-the-original"), "x");
			allocatedDirs.push(dir);
			await end(m);
			expect(existsSync(join(dir, "not-the-original"))).toBe(true); // the replacement, never removed
		};
		const endSessionId = `${LONG_SESSION_ID}-swap-endsession`;
		const sweepSessionId = `${LONG_SESSION_ID}-swap-sweep`;
		await swapAndVerify(endSessionId, (m) => m.endSession(endSessionId, new Set(), []));
		await swapAndVerify(sweepSessionId, async (m) => {
			m.setPolicy(HARSH);
			const dir = socketSafeTmpDir(LONG_BASE, sweepSessionId);
			const old = (Date.now() - 30 * 3600_000) / 1000;
			utimesSync(dir, old, old); // artificially old too — proves the identity check, not the age guard, is what saves it
			await m.runPass("test", new Set(), []);
		});
	});

	// #1411-adjacent review, third pass: two narrower gaps in the identity check itself.

	it("the SAME inode, widened to group/other access in place since creation, is rejected exactly like a swapped directory — a dev+ino match alone is not enough", async () => {
		const chmodId = `${LONG_SESSION_ID}-chmod-reuse`;
		const m = manager(LONG_BASE);
		const first = m.engineEnv({}, chmodId, join(LONG_BASE, "repos", "x"));
		const dir = first.TMPDIR as string;
		allocatedDirs.push(dir);
		chmodSync(dir, 0o707); // same inode — dev/ino are untouched by chmod — now world-accessible
		const second = m.engineEnv({}, chmodId, join(LONG_BASE, "repos", "x"));
		expect(second.TMPDIR).toBeUndefined(); // not reused: EEXIST on the fresh attempt refuses it
		expect(existsSync(dir)).toBe(true); // refusal, not a removal — the (now-insecure) directory is left exactly as found
	});

	it("the SAME inode, widened in place, is never removed by endSession either — only dropped from tracking", async () => {
		const chmodId = `${LONG_SESSION_ID}-chmod-remove`;
		const m = manager(LONG_BASE);
		const first = m.engineEnv({}, chmodId, join(LONG_BASE, "repos", "x"));
		const dir = first.TMPDIR as string;
		allocatedDirs.push(dir);
		chmodSync(dir, 0o707);
		await m.endSession(chmodId, new Set(), []);
		expect(existsSync(dir)).toBe(true); // left alone, not deleted, despite having been tracked a moment ago
	});

	it("a directory that vanishes between createSocketSafeTmp's own mkdir and its stat is refused cleanly — never throws into whatever spawns the engine off the result", () => {
		const vanishId = `${LONG_SESSION_ID}-vanish`;
		const dir = socketSafeTmpDir(LONG_BASE, vanishId);
		const lstatThatVanishes: typeof lstatSync = () => {
			rmSync(dir, { recursive: true, force: true }); // simulates something else deleting it in the gap
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		};
		expect(() => createSocketSafeTmp(LONG_BASE, vanishId, { lstat: lstatThatVanishes })).not.toThrow();
		expect(createSocketSafeTmp(LONG_BASE, vanishId, { lstat: lstatThatVanishes })).toBeNull();
	});

	it("engineEnv itself never throws when the directory vanishes right after creation — it clears TMPDIR, same as any other refusal", () => {
		// engineEnv doesn't take an injectable lstat (that is createSocketSafeTmp's own concern,
		// proven directly above) — this proves the OUTER contract: a session whose allocation attempt
		// lands on a path that a concurrent deletion wins the race for still gets a clean env back.
		const vanishId = `${LONG_SESSION_ID}-vanish-outer`;
		const dir = socketSafeTmpDir(LONG_BASE, vanishId);
		rmSync(dir, { recursive: true, force: true }); // nothing there yet; the allocation itself still succeeds fresh
		const m = manager(LONG_BASE);
		expect(() => m.engineEnv({}, vanishId, join(LONG_BASE, "repos", "x"))).not.toThrow();
		const env = m.engineEnv({}, vanishId, join(LONG_BASE, "repos", "x"));
		allocatedDirs.push(env.TMPDIR as string);
		expect(env.TMPDIR).toBeDefined(); // the ordinary case still works — this test is a non-throw smoke check, not a race
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
