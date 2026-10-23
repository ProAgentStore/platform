/**
 * The bounded Playwright browser install (#1047). No process is started and no real time passes:
 * the child is a fake, and the timers are vitest's fake timers injected into the wrapper.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS, INSTALL_COMMAND, installBrowsers, runDiagnostics } from "./install-playwright-browsers.mjs";

const TIMEOUT = 480_000;
const BEAT = 30_000;

/** A fake install: `script(child)` decides what it prints and when it exits. */
function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.killed = false;
	return child;
}

function harness(scripts) {
	const logs = [];
	const summaries = [];
	const killed = [];
	let heals = 0;
	let started = 0;
	const deps = {
		start: () => {
			const child = fakeChild();
			const script = scripts[started++];
			queueMicrotask(() => script?.(child));
			return child;
		},
		killTree: (child) => {
			killed.push(child);
			child.killed = true;
			queueMicrotask(() => child.emit("close", null));
		},
		write: () => {},
		log: (line) => logs.push(line),
		summary: (md) => summaries.push(md),
		diagnose: async () => runDiagnostics(async (cmd) => `ran: ${cmd.slice(0, 40)}`),
		heal: async () => {
			heals++;
		},
		now: () => Date.now(),
		timers: { setTimeout, clearTimeout, setInterval, clearInterval },
		timeoutMs: TIMEOUT,
		heartbeatMs: BEAT,
	};
	return { deps, logs, summaries, killed, heals: () => heals, started: () => started };
}

const succeedsAfter = (ms) => (child) => {
	child.stdout.emit("data", "Downloading Chromium 140.0\n");
	setTimeout(() => child.emit("close", 0), ms);
};
const hangs = (child) => child.stdout.emit("data", "Get:60 http://azure.archive.ubuntu.com/ubuntu noble/main amd64 libwoff1\n");
const failsFast = (child) => {
	child.stderr.emit("data", "E: Unable to locate package libfoo\n");
	setTimeout(() => child.emit("close", 100), 1_000);
};

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

describe("installBrowsers (#1047)", () => {
	it("runs the same command CI ran: both browsers, with their system dependencies", () => {
		expect(INSTALL_COMMAND).toEqual(["pnpm", ["exec", "playwright", "install", "--with-deps", "chromium", "webkit"]]);
	});

	it("happy path: installs on the first attempt, exit 0, no retry or repair", async () => {
		const h = harness([succeedsAfter(36_000)]);
		const done = installBrowsers(h.deps);
		await vi.advanceTimersByTimeAsync(40_000);
		expect(await done).toMatchObject({ status: "installed", exitCode: 0 });
		expect(h.started()).toBe(1);
		expect(h.heals()).toBe(0);
		expect(h.summaries).toEqual([]);
	});

	it("a hang is killed at the bound, diagnosed, the dpkg state repaired, and a retry succeeds", async () => {
		const h = harness([hangs, succeedsAfter(20_000)]);
		const done = installBrowsers(h.deps);
		await vi.advanceTimersByTimeAsync(TIMEOUT + 30_000);
		const result = await done;
		expect(result).toMatchObject({ status: "installed_after_retry", exitCode: 0 });
		expect(result.attempts.map((a) => a.outcome)).toEqual(["timed_out", "ok"]);
		expect(h.killed).toHaveLength(1);
		expect(h.heals()).toBe(1);
		expect(h.logs.join("\n")).toMatch(/killing the install's process tree/);
		expect(h.summaries[0]).toMatch(/attempt 1 timed out.*Get:60/s);
	});

	it("every attempt hangs: bounded at three, red", async () => {
		const h = harness([hangs, hangs, hangs, succeedsAfter(1)]);
		const done = installBrowsers(h.deps);
		await vi.advanceTimersByTimeAsync(3 * TIMEOUT + 10_000);
		const result = await done;
		expect(result).toMatchObject({ status: "failed", exitCode: 1 });
		expect(h.started()).toBe(3);
		expect(h.killed).toHaveLength(3);
		expect(h.heals()).toBe(2);
		expect(h.logs.at(-1)).toMatch(/^::error title=Playwright browser install failed::.*1: timed_out, 2: timed_out, 3: timed_out/);
	});
	it("does not start another apt process when owned-process termination fails", async () => {
		const h = harness([hangs, succeedsAfter(1)]);
		h.deps.killTree = () => { throw new Error("cannot terminate owned sudo child"); };
		const done = installBrowsers(h.deps);
		await vi.advanceTimersByTimeAsync(TIMEOUT + 1000);
		expect(await done).toMatchObject({ status: "failed", exitCode: 1 });
		expect(h.started()).toBe(1);
		expect(h.heals()).toBe(0);
		expect(h.logs.join("\n")).toContain("refusing a competing retry");
	});

	it("a quick non-zero exit is retried, then fails red with its exit code — and is not diagnosed as a hang", async () => {
		const h = harness([failsFast, failsFast, failsFast]);
		const done = installBrowsers(h.deps);
		await vi.advanceTimersByTimeAsync(10_000);
		const result = await done;
		expect(result).toMatchObject({ status: "failed", exitCode: 1 });
		expect(result.attempts.map((a) => a.code)).toEqual([100, 100, 100]);
		expect(h.killed).toEqual([]);
		expect(h.logs.join("\n")).not.toMatch(/diagnostics after attempt/);
		expect(h.logs.at(-1)).toMatch(/see each attempt's output above/);
		expect(h.logs.join("\n")).toMatch(/attempt 1 failed \(exit 100\); last output: E: Unable to locate package/);
	});

	it("a slow but live install beats every 30s with the elapsed time and its latest line", async () => {
		const slow = (child) => {
			let i = 0;
			const t = setInterval(() => child.stdout.emit("data", `Get:${++i} http://mirror pkg-${i}\n`), 20_000);
			setTimeout(() => {
				clearInterval(t);
				child.emit("close", 0);
			}, 125_000);
		};
		const h = harness([slow]);
		const done = installBrowsers(h.deps);
		await vi.advanceTimersByTimeAsync(130_000);
		expect((await done).status).toBe("installed");
		const beats = h.logs.filter((l) => l.startsWith("[install attempt 1]"));
		expect(beats).toHaveLength(4);
		expect(beats[0]).toMatch(/0m30s elapsed; last output 0m10s ago: Get:1 http:\/\/mirror pkg-1/);
		// At 2m00s the beat fires just before the sixth line lands: it reports the fifth, 20s old.
		expect(beats[3]).toMatch(/2m00s elapsed; last output 0m20s ago: Get:5 /);
	});

	it("a hang reads as the same line, growing older", async () => {
		const h = harness([hangs, succeedsAfter(1)]);
		installBrowsers(h.deps);
		await vi.advanceTimersByTimeAsync(95_000);
		const beats = h.logs.filter((l) => l.startsWith("[install attempt 1]"));
		expect(beats.map((b) => b.match(/last output (\S+) ago/)?.[1])).toEqual(["0m30s", "1m00s", "1m30s"]);
		for (const b of beats) expect(b).toContain("Get:60");
	});
});

describe("runDiagnostics (#1047)", () => {
	it("covers the process tree, apt/dpkg locks, dpkg --audit, disk and both connectivity checks", async () => {
		const report = await runDiagnostics(async (cmd) => cmd);
		for (const title of ["process tree", "apt/dpkg lock holders", "dpkg --audit", "disk", "apt mirror connectivity", "Playwright download connectivity"]) expect(report).toContain(`── ${title}`);
		expect(report).toMatch(/ps -eo/);
		expect(report).toMatch(/fuser -v \/var\/lib\/dpkg\/lock-frontend/);
		expect(report).toMatch(/df -h/);
		expect(report).toMatch(/cdn\.playwright\.dev/);
		expect(DIAGNOSTICS).toHaveLength(6);
	});

	it("a diagnostic that cannot run says so instead of failing the step", async () => {
		const report = await runDiagnostics(async (cmd) => {
			if (cmd.startsWith("df")) throw new Error("spawn df ENOENT");
			return "ok";
		});
		expect(report).toMatch(/── disk\n\(could not run: spawn df ENOENT\)/);
		expect(report).toMatch(/── dpkg --audit\nok/);
	});
});
