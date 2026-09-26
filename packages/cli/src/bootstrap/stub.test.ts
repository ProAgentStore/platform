/**
 * The bootstrap stub (#862): installed once, it moves onto the latest release by itself on `pags up`.
 *
 * The first test is the issue's own acceptance case — a stub from an OLD release, facing a newer
 * published CLI it knows nothing about (a different entry file, even), still fetches it and runs it.
 * It runs for real: real cache folders, a real `import()` of the fetched entry. Only npm is simulated.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_ENV, cachedPayloads, installPayload, NO_SELF_UPDATE_ENV, payloadAt } from "./payload.js";
import { checksForUpdate, runStub, type StubDeps } from "./stub.js";
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
		latest: async () => null,
		install: (v) => installPayload(v, root, async (prefix, ver) => void writeInstalled(prefix, ver)),
		log: () => undefined,
		...over,
	};
}

describe("the #862 acceptance case", () => {
	it("a stub from an old release self-updates to a newer published CLI on `pags up` — and runs it", async () => {
		const install = vi.fn((v: string) =>
			// The newer release moved its entry: the stub must follow the package's `pagsPayload`, not a path it assumed.
			installPayload(v, root, async (prefix, ver) => void writeInstalled(prefix, ver, "lib/cli/main.js")),
		);
		const ran = await runStub(stub("0.4.63", ["up"], { latest: async () => "1.7.0", install }));
		expect(install).toHaveBeenCalledWith("1.7.0");
		expect(ran.version).toBe("1.7.0");
		expect(ran.entry).toBe(join(root, "1.7.0", "node_modules", "@proagentstore", "cli", "lib", "cli", "main.js"));
		expect(globalThis.__pagsRan).toEqual(["1.7.0"]);
		expect(process.env[BOOTSTRAP_ENV]).toBe("/usr/local/lib/node_modules/@proagentstore/cli/dist/bootstrap.js");
	});

	it("…and the NEXT invocation of any command runs the fetched release with no network at all", async () => {
		await runStub(stub("0.4.63", ["up"], { latest: async () => "1.7.0" }));
		const latest = vi.fn(async () => "1.7.0");
		const ran = await runStub(stub("0.4.63", ["runner", "connect", "inst-1"], { latest }));
		expect(ran.version).toBe("1.7.0");
		expect(latest).not.toHaveBeenCalled();
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

	it("only `pags up` asks npm — every other command runs the newest it has", async () => {
		const latest = vi.fn(async () => "9.9.9");
		await runStub(stub("0.4.63", ["login"], { latest }));
		await runStub(stub("0.4.63", ["runner", "connect", "--watch-instances"], { latest }));
		expect(latest).not.toHaveBeenCalled();
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

	it("a failed fetch is said out loud and `pags up` still starts on what it has", async () => {
		const lines: string[] = [];
		const ran = await runStub(
			stub("0.4.63", ["up"], {
				latest: async () => "1.0.0",
				install: async () => {
					throw new Error("EACCES");
				},
				log: (l) => lines.push(l),
			}),
		);
		expect(ran.version).toBe("0.4.63");
		expect(lines.join("\n")).toMatch(/could not fetch 1\.0\.0 \(EACCES\) — starting 0\.4\.63 instead/);
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

describe("checksForUpdate", () => {
	it("is the `up` command, flags or not", () => {
		expect(checksForUpdate(["up"])).toBe(true);
		expect(checksForUpdate(["up", "--force", "--instance", "abc"])).toBe(true);
		expect(checksForUpdate(["runner", "connect"])).toBe(false);
		expect(checksForUpdate(["--version"])).toBe(false);
		expect(checksForUpdate([])).toBe(false);
	});
});
