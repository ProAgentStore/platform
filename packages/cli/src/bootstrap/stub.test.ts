/**
 * The bootstrap stub loads cached releases after the connected runner's policy-gated updater
 * installs them. Actions services take only relay-proven releases.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveActionsPayload, BOOTSTRAP_ENV, cachedPayloads, installPayload, NO_SELF_UPDATE_ENV, payloadAt } from "./payload.js";
import { isActionsSupervisor, runStub, type StubDeps } from "./stub.js";
import { writeInstalled, writePackage } from "./test-payload.js";

declare global {
	var __pagsRan: string[] | undefined;
}

let dir: string;
let root: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-stub-"));
	root = join(dir, "cache");
	globalThis.__pagsRan = undefined;
	delete process.env[BOOTSTRAP_ENV];
	delete process.env[NO_SELF_UPDATE_ENV];
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env[BOOTSTRAP_ENV];
	delete process.env[NO_SELF_UPDATE_ENV];
});

/** The stub as published with `version`: its own CLI beside it, the cache at `root`, npm simulated. */
function stub(version: string, args: string[], over: Partial<StubDeps> = {}): StubDeps {
	writePackage(join(dir, `bundled-${version}`), version);
	return {
		bundled: payloadAt(join(dir, `bundled-${version}`)),
		args,
		self: "/usr/local/lib/node_modules/@proagentstore/cli/dist/bootstrap.js",
		fromSource: false,
		cached: () => cachedPayloads(root),
		// The trial records (#1141) live beside the payloads: never the real home cache.
		root,
		latest: async () => null,
		install: (v) => installPayload(v, root, async (prefix, ver) => void writeInstalled(prefix, ver)),
		log: () => undefined,
		...over,
	};
}

describe("the policy-gated bootstrap", () => {
	it("a cached release is picked on next start, including its moved entry path", async () => {
		await installPayload("1.7.0", root, async (prefix, ver) => void writeInstalled(prefix, ver, "lib/cli/main.js"));
		const ran = await runStub(stub("0.4.63", ["up"]));
		expect(ran.version).toBe("1.7.0");
		expect(ran.entry).toContain("lib/cli/main.js");
		expect(globalThis.__pagsRan).toEqual(["1.7.0"]);
		expect(process.env[BOOTSTRAP_ENV]).toBe("/usr/local/lib/node_modules/@proagentstore/cli/dist/bootstrap.js");
	});

	it("an Actions service stays on the bundled CLI until a cached payload is relay-proven", async () => {
		await installPayload("1.7.0", root, async (prefix, ver) => void writeInstalled(prefix, ver));
		expect((await runStub(stub("0.4.63", ["actions", "supervise", "--dir", "/runner"]))).version).toBe("0.4.63");
		approveActionsPayload("1.7.0", root);
		expect((await runStub(stub("0.4.63", ["actions", "supervise", "--dir", "/runner"]))).version).toBe("1.7.0");
	});
});

describe("runStub", () => {
	it("runs its own CLI when it is the newest — nothing fetched", async () => {
		const install = vi.fn();
		const ran = await runStub(stub("0.4.63", ["up"], { latest: async () => "0.4.63", install }));
		expect(ran.version).toBe("0.4.63");
		expect(install).not.toHaveBeenCalled();
		expect(globalThis.__pagsRan).toEqual(["0.4.63"]);
	});

	it("never asks npm on boot, even when the local Auto-update policy is off", async () => {
		const latest = vi.fn(async () => "9.9.9");
		const install = vi.fn();
		await runStub(stub("0.4.63", ["up"], { latest, install }));
		await runStub(stub("0.4.63", ["runner", "connect", "--watch-instances"], { latest, install }));
		expect(latest).not.toHaveBeenCalled();
		expect(install).not.toHaveBeenCalled();
	});

	it("runs a payload runner_update put in the cache — the respawn after a remote update (#859)", async () => {
		await installPayload("0.4.70", root, async (prefix, v) => void writeInstalled(prefix, v));
		const ran = await runStub(stub("0.4.63", ["runner", "connect", "inst-1"]));
		expect(ran.version).toBe("0.4.70");
	});

	it("offline: `pags up` starts on what it has", async () => {
		const ran = await runStub(stub("0.4.63", ["up"], { latest: async () => null }));
		expect(ran.version).toBe("0.4.63");
	});


	it("never self-updates a source checkout, or with PAGS_NO_SELF_UPDATE=1", async () => {
		const latest = vi.fn(async () => "9.9.9");
		await runStub(stub("0.4.63", ["up"], { latest, fromSource: true }));
		process.env[NO_SELF_UPDATE_ENV] = "1";
		await runStub(stub("0.4.63", ["up"], { latest }));
		expect(latest).not.toHaveBeenCalled();
	});

	it("with nothing to run at all, says how to recover", async () => {
		await expect(runStub({ ...stub("0.4.63", ["up"]), bundled: null })).rejects.toThrow(/npm i -g @proagentstore\/cli/);
	});
});

describe("isActionsSupervisor", () => {
	it("matches only the supervised Actions command", () => {
		expect(isActionsSupervisor(["actions", "supervise", "--dir", "/runner"])).toBe(true);
		expect(isActionsSupervisor(["actions", "status"])).toBe(false);
		expect(isActionsSupervisor(["up"])).toBe(false);
	});
});
