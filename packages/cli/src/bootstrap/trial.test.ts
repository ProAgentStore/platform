/**
 * #1141 — an auto-update never leaves a machine without a running `pags up`.
 *
 * On 2026-10-17 two machines moved onto 0.4.149, never heartbeated, and stayed dark. These run the
 * real stub over real cache folders and a real `import()` of each payload's entry; only npm, the
 * clock, the watchdog's timer and the process exit are simulated. The issue's three cases: a failed
 * install, a new version that crashes on start, and rollback when it never registers.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOOTSTRAP_ENV, cachedPayloads, installPayload, payloadAt } from "./payload.js";
import { runStub, STUB_RESTART_EXIT_CODE, type StubDeps } from "./stub.js";
import { writeInstalled, writePackage } from "./test-payload.js";
import { accrueTrial, activatePayload, badVersions, beginTrial, MAX_TRIAL_STARTS, markPayloadHealthy, readTrial, takeRollbackNotice, TRIAL_MAX_WALL_MS, TRIAL_MS, TRIAL_SLEEP_GAP_MS, TRIAL_TICK_MS, trialExpiry } from "./trial.js";

declare global {
	var __pagsRan: string[] | undefined;
}

let dir: string;
let root: string;
let clock: number;
let timers: Array<{ fn: () => void; ms: number }>;
let exits: number[];
let lines: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-trial-"));
	root = join(dir, "cache");
	clock = Date.parse("2026-10-17T22:37:00Z");
	timers = [];
	exits = [];
	lines = [];
	globalThis.__pagsRan = undefined;
	delete process.env[BOOTSTRAP_ENV];
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env[BOOTSTRAP_ENV];
});

/** The machine is awake and running: `n` watchdog ticks, each a normal TRIAL_TICK_MS apart. Stops early if the trial ended. */
function runAwake(n: number): void {
	for (let i = 0; i < n; i++) {
		const t = timers.shift();
		if (!t) return;
		clock += TRIAL_TICK_MS;
		t.fn();
	}
}
/** The machine sleeps for `ms` wall-clock milliseconds, then wakes and the next watchdog tick runs. */
function sleepFor(ms: number): void {
	const t = timers.shift();
	if (!t) throw new Error("no watchdog timer armed");
	clock += ms;
	t.fn();
}
const AWAKE_TICKS = TRIAL_MS / TRIAL_TICK_MS;

/** npm, simulated: lays `version` out under the prefix — or a payload whose entry throws when imported. */
const npm = (crashing: string[] = []) => async (prefix: string, version: string) => {
	const entry = writeInstalled(prefix, version);
	if (crashing.includes(version)) writeFileSync(entry, `throw new Error("SyntaxError in ${version}");\n`);
};

/** The stub published with 0.4.148, under a service (`PAGS_SERVICE=1`) unless `env` says otherwise. */
function stub(args: string[], over: Partial<StubDeps> = {}): StubDeps {
	writePackage(join(dir, "bundled"), "0.4.148");
	return {
		bundled: payloadAt(join(dir, "bundled")),
		args,
		self: "/usr/local/lib/node_modules/@proagentstore/cli/dist/bootstrap.js",
		fromSource: false,
		root,
		cached: () => cachedPayloads(root),
		latest: async () => null,
		install: (v) => installPayload(v, root, npm()),
		log: (l) => lines.push(l),
		now: () => clock,
		env: { PAGS_SERVICE: "1" },
		setTimer: (fn, ms) => {
			timers.push({ fn, ms });
			return {};
		},
		exit: (code) => exits.push(code),
		...over,
	};
}

describe("a failed install leaves the running version in place (#1141)", () => {
	it("npm fails: `pags up` starts on what it has, nothing goes on trial, the failure is said", async () => {
		const ran = await runStub(stub(["up"], { latest: async () => "0.4.149", install: async () => { throw new Error("ETARGET No matching version"); } }));
		expect(ran.version).toBe("0.4.148");
		expect(globalThis.__pagsRan).toEqual(["0.4.148"]);
		expect(readTrial(root)).toBeNull();
		expect(lines).toEqual([]);
	});
});

describe("a new version that crashes on start is rolled back in the same process (#1141)", () => {
	it("import throws: 0.4.149 is given up on, 0.4.148 runs at once, and the rollback is left for it to report", async () => {
		await installPayload("0.4.149", root, npm(["0.4.149"]));
		beginTrial(root, "0.4.149", "0.4.148", clock);
		activatePayload(root, "0.4.149");
		const ran = await runStub(stub(["up"]));
		expect(ran.version).toBe("0.4.148");
		expect(globalThis.__pagsRan).toEqual(["0.4.148"]);
		expect(badVersions(root)["0.4.149"]).toMatch(/crashed on start: SyntaxError in 0\.4\.149/);
		expect(takeRollbackNotice(root)).toMatchObject({ from: "0.4.149", to: "0.4.148", reason: expect.stringMatching(/crashed on start/) });
		expect(takeRollbackNotice(root)).toBeNull(); // reported once
	});

	it("…and is never fetched or picked again, though it stays published", async () => {
		await installPayload("0.4.149", root, npm(["0.4.149"]));
		beginTrial(root, "0.4.149", "0.4.148", clock);
		activatePayload(root, "0.4.149");
		await runStub(stub(["up"]));
		globalThis.__pagsRan = undefined;
		let installs = 0;
		const ran = await runStub(stub(["up"], { latest: async () => "0.4.149", install: async (v) => { installs++; return installPayload(v, root, npm()); } }));
		expect(ran.version).toBe("0.4.148");
		expect(installs).toBe(0);
		expect(badVersions(root)["0.4.149"]).toBeDefined();
	});

	it("a crash in a version NOT on trial is not swallowed — there is nothing proven to fall back to", async () => {
		await installPayload("0.4.150", root, npm(["0.4.150"]));
		await expect(runStub(stub(["up"]))).rejects.toThrow(/SyntaxError in 0\.4\.150/);
	});
});

describe("a new version that never registers is rolled back (#1141)", () => {
	it("the watchdog gives it up at the end of the window and leaves with the restart code; the next start runs the previous version", async () => {
		await installPayload("0.4.149", root, npm());
		beginTrial(root, "0.4.149", "0.4.148", clock);
		activatePayload(root, "0.4.149");
		const first = await runStub(stub(["up"]));
		expect(first.version).toBe("0.4.149");
		expect(readTrial(root)).toMatchObject({ version: "0.4.149", previous: "0.4.148", starts: 1, startedAt: clock });
		expect(timers).toEqual([{ fn: expect.any(Function), ms: TRIAL_TICK_MS }]);

		runAwake(AWAKE_TICKS);
		expect(badVersions(root)["0.4.149"]).toMatch(/did not register with the platform within 5 minutes of running/);
		expect(exits).toEqual([STUB_RESTART_EXIT_CODE]);

		globalThis.__pagsRan = undefined;
		const next = await runStub(stub(["up"]));
		expect(next.version).toBe("0.4.148");
		expect(globalThis.__pagsRan).toEqual(["0.4.148"]);
		expect(takeRollbackNotice(root)).toMatchObject({ from: "0.4.149", to: "0.4.148" });
	});

	it("registering in time keeps it: the watchdog finds it proven and does nothing", async () => {
		await installPayload("0.4.149", root, npm());
		beginTrial(root, "0.4.149", "0.4.148", clock);
		activatePayload(root, "0.4.149");
		await runStub(stub(["up"]));
		expect(markPayloadHealthy(root, "0.4.149")).toBe(true);
		timers[0].fn();
		expect(exits).toEqual([]);
		expect(badVersions(root)).toEqual({});
		globalThis.__pagsRan = undefined;
		expect((await runStub(stub(["runner", "connect", "i1"]))).version).toBe("0.4.149");
	});

	it("unsupervised it does not exit — it records the verdict, so the next `pags up` runs the previous version", async () => {
		await installPayload("0.4.149", root, npm());
		beginTrial(root, "0.4.149", "0.4.148", clock);
		activatePayload(root, "0.4.149");
		await runStub(stub(["up"], { env: {} }));
		runAwake(AWAKE_TICKS);
		expect(exits).toEqual([]);
		expect(badVersions(root)["0.4.149"]).toBeDefined();
		expect(lines.at(-1)).toMatch(/The next "pags up" runs the previous version/);
	});

	it("a crash loop after start: past its starts it is given up on at the next start", async () => {
		await installPayload("0.4.149", root, npm());
		beginTrial(root, "0.4.149", "0.4.148", clock);
		activatePayload(root, "0.4.149");
		for (let i = 0; i < MAX_TRIAL_STARTS; i++) expect((await runStub(stub(["runner", "connect", "i1"]))).version).toBe("0.4.149");
		expect((await runStub(stub(["runner", "connect", "i1"]))).version).toBe("0.4.148");
		expect(badVersions(root)["0.4.149"]).toMatch(/started 6 times without registering/);
	});

	it("a restart after the window has passed gives it up before it runs again", async () => {
		await installPayload("0.4.149", root, npm());
		beginTrial(root, "0.4.149", "0.4.148", clock);
		activatePayload(root, "0.4.149");
		await runStub(stub(["up"]));
		// It ran, awake, for the whole window without registering; the process then restarted. (A plain gap would be sleep: see #1382 below.)
		runAwake(AWAKE_TICKS - 1);
		clock += TRIAL_TICK_MS;
		expect((await runStub(stub(["up"]))).version).toBe("0.4.148");
		expect(badVersions(root)["0.4.149"]).toMatch(/within 5 minutes of running/);
	});

	it("the clock starts at the first START, not the install: a payload held back by busy work is judged from when it runs", async () => {
		await installPayload("0.4.149", root, npm());
		beginTrial(root, "0.4.149", "0.4.148", clock);
		activatePayload(root, "0.4.149");
		clock += 60 * 60_000; // installed an hour before the restart
		expect((await runStub(stub(["up"]))).version).toBe("0.4.149");
		expect(readTrial(root)?.startedAt).toBe(clock);
	});

	it("short commands are not judged: `pags status` neither counts a start nor arms a watchdog", async () => {
		await installPayload("0.4.149", root, npm());
		beginTrial(root, "0.4.149", "0.4.148", clock);
		activatePayload(root, "0.4.149");
		await runStub(stub(["status"]));
		expect(readTrial(root)?.starts).toBe(0);
		expect(timers).toEqual([]);
	});
});

describe("the cache keeps what a rollback lands on (#1141)", () => {
	it("installing a newer release after a rollback keeps the last GOOD version, not the one given up on", async () => {
		const install = (v: string) => installPayload(v, root, npm());
		await install("0.4.147");
		await install("0.4.148");
		await install("0.4.149");
		// 0.4.149 was given up on; keeping the newest two would now drop 0.4.148, the version actually running.
		writeFileSync(join(root, ".bad.json"), JSON.stringify({ versions: { "0.4.149": "crashed on start" } }));
		await install("0.4.150");
		expect(cachedPayloads(root).map((p) => p.version).sort()).toEqual(["0.4.148", "0.4.150"]);
	});
});

describe("a machine that sleeps through the trial is not a release that failed to register (#1382)", () => {
	async function onTrial(env: StubDeps["env"] = { PAGS_SERVICE: "1" }): Promise<void> {
		await installPayload("0.4.186", root, npm());
		beginTrial(root, "0.4.186", "0.4.181", clock);
		activatePayload(root, "0.4.186");
		expect((await runStub(stub(["up"], { env }))).version).toBe("0.4.186");
	}

	it("the incident: 8 seconds after the restart the laptop sleeps for 590 s — the wake does NOT roll the release back", async () => {
		await onTrial();
		runAwake(1); // 15 s awake...
		sleepFor(590_000); // ...then maintenance sleep through the old deadline
		expect(exits).toEqual([]);
		expect(badVersions(root)).toEqual({});
		expect(readTrial(root)).toMatchObject({ version: "0.4.186", awakeMs: 2 * TRIAL_TICK_MS });
		expect(readTrial(root)?.sleptMs).toBe(590_000 - TRIAL_TICK_MS);
		expect(lines.some((l) => /machine slept about \d+s while 0\.4\.186 was on trial; its trial clock did not run/.test(l))).toBe(true);
		// It is still being judged — on the time it runs.
		expect(timers).toHaveLength(1);
	});

	it("after waking it still has its full awake window: registering within it keeps the release", async () => {
		await onTrial();
		runAwake(1);
		sleepFor(590_000);
		runAwake(AWAKE_TICKS - 4); // a good part of the window, awake
		expect(exits).toEqual([]);
		expect(markPayloadHealthy(root, "0.4.186")).toBe(true);
		runAwake(1);
		expect(exits).toEqual([]);
		expect(badVersions(root)).toEqual({});
	});

	it("a release that STILL never registers once awake is rolled back — and the receipt says it slept", async () => {
		await onTrial();
		runAwake(1);
		sleepFor(590_000);
		runAwake(AWAKE_TICKS);
		expect(badVersions(root)["0.4.186"]).toMatch(/did not register with the platform within 5 minutes of running \(the machine slept about 10 minutes of that; sleep does not count against it\)/);
		expect(exits).toEqual([STUB_RESTART_EXIT_CODE]);
		expect(takeRollbackNotice(root)).toMatchObject({ from: "0.4.186", to: "0.4.181", reason: expect.stringMatching(/slept about 10 minutes/) });
	});

	it("a truly failed registration, with no sleep at all, is rolled back at the five-minute mark exactly as before", async () => {
		await onTrial();
		runAwake(AWAKE_TICKS - 1);
		expect(exits).toEqual([]);
		runAwake(1);
		expect(badVersions(root)["0.4.186"]).toMatch(/within 5 minutes of running$/);
		expect(exits).toEqual([STUB_RESTART_EXIT_CODE]);
	});

	it("a restart that follows a sleep is judged the same way: the gap is sleep, not a failure", async () => {
		await onTrial();
		runAwake(2);
		clock += 590_000; // the whole machine slept, and `pags up` was started again on wake
		expect((await runStub(stub(["up"]))).version).toBe("0.4.186");
		expect(badVersions(root)).toEqual({});
		expect(readTrial(root)).toMatchObject({ starts: 2 });
		expect(readTrial(root)?.sleptMs).toBeGreaterThan(500_000);
	});

	it("a broken release on a machine that mostly sleeps is still ended — by the wall-clock bound", async () => {
		await onTrial();
		// Repeating 15-minute maintenance sleeps with a few awake seconds between them: never 5 minutes awake.
		for (let i = 0; i < 6 && !exits.length; i++) sleepFor(15 * 60_000);
		expect(exits).toEqual([STUB_RESTART_EXIT_CODE]);
		expect(badVersions(root)["0.4.186"]).toMatch(new RegExp(`still not registered ${TRIAL_MAX_WALL_MS / 60_000} minutes after first starting \\(the wall-clock limit`));
		expect(badVersions(root)["0.4.186"]).toMatch(/the rest asleep/);
	});

	it("unsupervised, a sleep through the deadline neither exits nor records a verdict", async () => {
		await onTrial({});
		runAwake(1);
		sleepFor(590_000);
		expect(exits).toEqual([]);
		expect(badVersions(root)).toEqual({});
	});
});

describe("trial time accounting (#1382)", () => {
	const base = { version: "0.4.186", previous: "0.4.181", installedAt: 0, starts: 1, startedAt: 1000, seenAt: 1000, awakeMs: 0, sleptMs: 0 };

	it("a normal gap is all awake time; a long one is one tick awake and the rest asleep", () => {
		expect(accrueTrial(base, 1000 + TRIAL_TICK_MS)).toMatchObject({ awakeMs: TRIAL_TICK_MS, sleptMs: 0, sleptNow: 0 });
		expect(accrueTrial(base, 1000 + TRIAL_SLEEP_GAP_MS)).toMatchObject({ awakeMs: TRIAL_SLEEP_GAP_MS, sleptMs: 0 });
		expect(accrueTrial(base, 1000 + TRIAL_SLEEP_GAP_MS + 1)).toMatchObject({ awakeMs: TRIAL_TICK_MS, sleptMs: TRIAL_SLEEP_GAP_MS + 1 - TRIAL_TICK_MS });
	});

	it("accumulates across observations, and never counts a clock that went backwards", () => {
		const a = accrueTrial(base, 1000 + TRIAL_TICK_MS);
		const b = accrueTrial({ ...base, awakeMs: a.awakeMs, seenAt: a.seenAt }, a.seenAt + TRIAL_TICK_MS);
		expect(b.awakeMs).toBe(2 * TRIAL_TICK_MS);
		expect(accrueTrial(base, 1).awakeMs).toBe(0);
	});

	it("a record written before this was kept (no awake time recorded) is not failed by the gap since its start", () => {
		const old = { version: "0.4.186", previous: null, installedAt: 0, starts: 1, startedAt: 1000 };
		expect(trialExpiry(old, 1000 + TRIAL_MS + 1)).toBeNull();
	});

	it("expires on awake time or on the wall-clock bound, and says which", () => {
		expect(trialExpiry({ ...base, awakeMs: TRIAL_MS }, 2000)?.reason).toMatch(/within 5 minutes of running/);
		expect(trialExpiry({ ...base, awakeMs: 1000 }, 1000 + TRIAL_MAX_WALL_MS)?.reason).toMatch(/wall-clock limit/);
		expect(trialExpiry({ ...base, awakeMs: 1000 }, 1000 + TRIAL_MAX_WALL_MS - 1)).toBeNull();
	});
});
