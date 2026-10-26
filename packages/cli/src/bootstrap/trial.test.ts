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
import { badVersions, beginTrial, MAX_TRIAL_STARTS, markPayloadHealthy, readTrial, takeRollbackNotice, TRIAL_MS } from "./trial.js";

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
		const first = await runStub(stub(["up"]));
		expect(first.version).toBe("0.4.149");
		expect(readTrial(root)).toMatchObject({ version: "0.4.149", previous: "0.4.148", starts: 1, startedAt: clock });
		expect(timers).toEqual([{ fn: expect.any(Function), ms: TRIAL_MS }]);

		clock += TRIAL_MS;
		timers[0].fn();
		expect(badVersions(root)["0.4.149"]).toMatch(/did not register with the platform within 5 minutes/);
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
		await runStub(stub(["up"], { env: {} }));
		timers[0].fn();
		expect(exits).toEqual([]);
		expect(badVersions(root)["0.4.149"]).toBeDefined();
		expect(lines.at(-1)).toMatch(/The next "pags up" runs the previous version/);
	});

	it("a crash loop after start: past its starts it is given up on at the next start", async () => {
		await installPayload("0.4.149", root, npm());
		beginTrial(root, "0.4.149", "0.4.148", clock);
		for (let i = 0; i < MAX_TRIAL_STARTS; i++) expect((await runStub(stub(["runner", "connect", "i1"]))).version).toBe("0.4.149");
		expect((await runStub(stub(["runner", "connect", "i1"]))).version).toBe("0.4.148");
		expect(badVersions(root)["0.4.149"]).toMatch(/started 6 times without registering/);
	});

	it("a restart after the window has passed gives it up before it runs again", async () => {
		await installPayload("0.4.149", root, npm());
		beginTrial(root, "0.4.149", "0.4.148", clock);
		await runStub(stub(["up"]));
		clock += TRIAL_MS + 1;
		expect((await runStub(stub(["up"]))).version).toBe("0.4.148");
		expect(badVersions(root)["0.4.149"]).toMatch(/within 5 minutes/);
	});

	it("the clock starts at the first START, not the install: a payload held back by busy work is judged from when it runs", async () => {
		await installPayload("0.4.149", root, npm());
		beginTrial(root, "0.4.149", "0.4.148", clock);
		clock += 60 * 60_000; // installed an hour before the restart
		expect((await runStub(stub(["up"]))).version).toBe("0.4.149");
		expect(readTrial(root)?.startedAt).toBe(clock);
	});

	it("short commands are not judged: `pags status` neither counts a start nor arms a watchdog", async () => {
		await installPayload("0.4.149", root, npm());
		beginTrial(root, "0.4.149", "0.4.148", clock);
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
