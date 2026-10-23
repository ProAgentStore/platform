/** #1320 — an update that cannot finish is refused before anything is fetched, and the machine is left as it was. */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPayload } from "./payload.js";
import { MIN_FREE_BYTES, MIN_NODE_MAJOR, type PreflightDeps, preflightInstall, realPreflightDeps } from "./preflight.js";
import { writeInstalled } from "./test-payload.js";

const ok = (over: Partial<PreflightDeps> = {}): PreflightDeps => ({ freeBytes: () => 50 * 2 ** 30, writable: () => true, nodeVersion: "22.4.0", ...over });

describe("preflightInstall", () => {
	it("passes a machine with room, write access and a current Node", () => {
		expect(preflightInstall("/x", ok())).toEqual({ ok: true });
	});
	it("refuses a nearly full disk, saying how much is free and how much is needed", () => {
		const r = preflightInstall("/x", ok({ freeBytes: () => 120 * 1024 * 1024 }));
		expect(r).toEqual({ ok: false, reason: expect.stringMatching(/only 120 MB free .* needs 400 MB/) });
	});
	it("treats an unreadable free-space figure as unknown, not as full: the install is not blocked on a number it could not get", () => {
		expect(preflightInstall("/x", ok({ freeBytes: () => null })).ok).toBe(true);
	});
	it("refuses a folder the user cannot write", () => {
		expect(preflightInstall("/x", ok({ writable: () => false }))).toEqual({ ok: false, reason: expect.stringMatching(/not writable by this user \(\/x\)/) });
	});
	it("refuses a Node too old to run the CLI, and an unreadable version", () => {
		expect(preflightInstall("/x", ok({ nodeVersion: "16.20.0" }))).toEqual({ ok: false, reason: expect.stringContaining(`needs ${MIN_NODE_MAJOR} or later`) });
		expect(preflightInstall("/x", ok({ nodeVersion: "weird" })).ok).toBe(false);
	});
	it("checks the free space exactly at the line: the minimum itself passes, one byte under does not", () => {
		expect(preflightInstall("/x", ok({ freeBytes: () => MIN_FREE_BYTES })).ok).toBe(true);
		expect(preflightInstall("/x", ok({ freeBytes: () => MIN_FREE_BYTES - 1 })).ok).toBe(false);
	});
});

describe("the real checks", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pags-preflight-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("proves a folder writable by writing in it, leaves no probe behind, and finds free space on the volume", () => {
		const d = realPreflightDeps();
		expect(d.writable(join(root, "cache"))).toBe(true);
		expect(readdirSync(join(root, "cache"))).toEqual([]);
		expect(d.freeBytes(join(root, "not", "yet", "created"))).toBeGreaterThan(0); // walks up to the nearest existing parent
	});
	it("a path it cannot create is not writable", () => {
		// Under a regular FILE: creating a folder there fails at once (ENOTDIR) on every platform. (A path under /proc was used first;
		// a recursive mkdir there can spin forever on Linux, which froze CI.)
		const file = join(root, "a-file");
		writeFileSync(file, "x");
		expect(realPreflightDeps().writable(join(file, "sub"))).toBe(false);
	});
});

describe("installPayload refuses before it fetches (#1320)", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pags-preflight-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("a full disk: npm is never run, no scratch folder is created, and the failure is said", async () => {
		const install = vi.fn(async () => undefined);
		await expect(installPayload("9.9.9", root, install, ok({ freeBytes: () => 1024 }))).rejects.toThrow(/update pre-flight failed: only 0 MB free/);
		expect(install).not.toHaveBeenCalled();
		expect(readdirSync(root)).toEqual([]);
	});
	it("a passing machine installs exactly as before", async () => {
		const install = vi.fn(async (dir: string, version: string) => { writeInstalled(dir, version); });
		const p = await installPayload("9.9.9", root, install, ok());
		expect(p.version).toBe("9.9.9");
		expect(existsSync(join(root, "9.9.9"))).toBe(true);
	});
	it("an already-installed version needs no pre-flight at all (offline and full is still a working machine)", async () => {
		const install = vi.fn(async (dir: string, version: string) => { writeInstalled(dir, version); });
		await installPayload("9.9.9", root, install, ok());
		await expect(installPayload("9.9.9", root, install, ok({ writable: () => false, freeBytes: () => 0 }))).resolves.toMatchObject({ version: "9.9.9" });
		expect(install).toHaveBeenCalledTimes(1);
	});
});
