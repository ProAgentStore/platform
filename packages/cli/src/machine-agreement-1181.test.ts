/**
 * #1181 (CLI half): this machine decides which agents are its own by MACHINE ID, the same key the server routes by - local hostname
 * history is a fallback for pins that never had an id. And an unreadable machine.json does not turn the machine into a new one.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DiscoverableInstance, diffMembership, eligibleIds, isEligible, partitionByPin, pinnedAway } from "./commands/runner/membership.js";
import { recoverMachineId } from "./machine.js";

const ME = "mid-ME000001";
const OTHER = "mid-OTHER002";
const inst = (id: string, config: DiscoverableInstance["config"]): DiscoverableInstance => ({ id, status: "active", capabilities: { runtime: "coding" }, config });
// This machine's local history says it has worn "shared-name" - and so has (or now does) another machine.
const known = ["mac-mini", "shared-name", ME];

describe("an id pin decides alone (#1181)", () => {
	it("pinned to ANOTHER machine's id is not eligible here, even when its hostname is one this machine once wore", () => {
		const stale = inst("a", { runnerNode: "shared-name", runnerMachineId: OTHER });
		expect(isEligible(stale, "mac-mini", known, ME)).toBe(false);
		expect(eligibleIds([stale], "mac-mini", known, ME).size).toBe(0);
		expect(partitionByPin([stale], "mac-mini", known, ME)).toEqual({ here: [], elsewhere: [stale] });
		expect(diffMembership([], [stale], "mac-mini", new Set(), known, ME)).toEqual({ attach: [], detach: [] });
	});

	it("pinned to THIS machine's id stays eligible whatever the hostname says", () => {
		expect(isEligible(inst("a", { runnerNode: "something-else", runnerMachineId: ME }), "mac-mini", known, ME)).toBe(true);
	});

	it("a held agent whose pin moved to another machine's id is released, hostname history notwithstanding", () => {
		const moved = inst("a", { runnerNode: "shared-name", runnerMachineId: OTHER });
		expect(pinnedAway(["a"], [moved], "mac-mini", known, ME)).toEqual(["a"]);
		expect(pinnedAway(["a"], [inst("a", { runnerNode: "mac-mini", runnerMachineId: ME })], "mac-mini", known, ME)).toEqual([]);
	});

	it("the name fallback is unchanged for a pin with no id, for an unpinned agent, and for a machine with no id of its own", () => {
		expect(isEligible(inst("a", { runnerNode: "shared-name" }), "mac-mini", known, ME)).toBe(true); // legacy hostname pin, a name it wore
		expect(isEligible(inst("a", { runnerNode: "elsewhere" }), "mac-mini", known, ME)).toBe(false);
		expect(isEligible(inst("a", null), "mac-mini", known, ME)).toBe(true);
		// No id of its own to compare (unwritable home): names stay the only evidence, exactly as before.
		expect(isEligible(inst("a", { runnerNode: "shared-name", runnerMachineId: OTHER }), "mac-mini", ["shared-name"], "")).toBe(true);
	});
});

describe("an unreadable machine.json is not a new machine (#1181)", () => {
	it("recovers a valid id from damaged text, and only a valid one", () => {
		expect(recoverMachineId('{"id": "abcd1234-efgh", "names": ["a", ')).toBe("abcd1234-efgh");
		expect(recoverMachineId('{"id": "short"}')).toBeNull();
		expect(recoverMachineId("not json at all")).toBeNull();
	});

	describe("loadMachineIdentity over a real home", () => {
		let home: string;
		beforeEach(() => {
			home = mkdtempSync(join(tmpdir(), "pags-machine-1181-"));
			vi.resetModules();
			vi.stubEnv("HOME", home);
			vi.stubEnv("USERPROFILE", home);
		});
		afterEach(() => {
			vi.unstubAllEnvs();
			rmSync(home, { recursive: true, force: true });
		});
		const dir = () => join(home, ".config", "proagentstore");

		it("a truncated file keeps its id, and the damaged original is kept beside the new one", async () => {
			mkdirSync(dir(), { recursive: true });
			writeFileSync(join(dir(), "machine.json"), '{\n  "id": "keep-this-id-0001",\n  "names": ["old-host", "oth');
			const { loadMachineIdentity } = await import("./machine.js");
			expect(loadMachineIdentity("new-host")).toMatchObject({ id: "keep-this-id-0001", names: ["new-host"] });
			expect(JSON.parse(readFileSync(join(dir(), "machine.json"), "utf-8")).id).toBe("keep-this-id-0001");
			expect(readdirSync(dir()).filter((f) => f.startsWith("machine.json.corrupt-"))).toHaveLength(1);
		});

		it("a file with no recoverable id mints a new one - but the damaged file is still kept, not destroyed", async () => {
			mkdirSync(dir(), { recursive: true });
			writeFileSync(join(dir(), "machine.json"), "\u0000\u0000garbage");
			const { loadMachineIdentity } = await import("./machine.js");
			const id = loadMachineIdentity("h").id;
			expect(id).toMatch(/^[0-9a-f-]{36}$/);
			expect(readdirSync(dir()).some((f) => f.startsWith("machine.json.corrupt-"))).toBe(true);
		});

		it("a healthy file is read as before and leaves no backup", async () => {
			mkdirSync(dir(), { recursive: true });
			writeFileSync(join(dir(), "machine.json"), JSON.stringify({ id: "healthy-id-0001", names: ["h"], declined: [] }));
			const { loadMachineIdentity } = await import("./machine.js");
			expect(loadMachineIdentity("h").id).toBe("healthy-id-0001");
			expect(readdirSync(dir()).some((f) => f.includes("corrupt"))).toBe(false);
		});
	});
});
