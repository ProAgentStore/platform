/**
 * The stub's payload cache (#862): only complete payloads count, an install is all-or-nothing, and
 * the cache keeps the last two versions.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedPayloads, installPayload, newestPayload, payloadAt } from "./payload.js";
import { writeInstalled, writePackage } from "./test-payload.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pags-cache-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("payloadAt", () => {
	it("reads the version and follows the package's own pagsPayload entry", () => {
		const entry = writePackage(join(root, "p"), "1.0.0", "lib/main.js");
		expect(payloadAt(join(root, "p"))).toEqual({ version: "1.0.0", entry });
	});

	it("is null for another package, a missing entry, or no package at all", () => {
		writePackage(join(root, "other"), "1.0.0", "dist/index.js", "left-pad");
		expect(payloadAt(join(root, "other"))).toBeNull();
		writePackage(join(root, "broken"), "1.0.0");
		rmSync(join(root, "broken", "dist"), { recursive: true });
		expect(payloadAt(join(root, "broken"))).toBeNull();
		expect(payloadAt(join(root, "nothing"))).toBeNull();
	});
});

describe("newestPayload", () => {
	it("compares numerically, and the first wins a tie", () => {
		const a = { version: "0.4.63", entry: "bundled" };
		expect(newestPayload([a, { version: "0.4.9", entry: "x" }, { version: "0.4.63", entry: "cached" }])).toBe(a);
		expect(newestPayload([a, { version: "0.4.100", entry: "y" }])?.entry).toBe("y");
		expect(newestPayload([])).toBeNull();
	});
});

describe("installPayload", () => {
	it("installs into a scratch folder and moves it into place — the cache lists it", async () => {
		const p = await installPayload("0.5.0", root, async (dir, v) => void writeInstalled(dir, v));
		expect(p.version).toBe("0.5.0");
		expect(cachedPayloads(root).map((c) => c.version)).toEqual(["0.5.0"]);
		expect(readdirSync(root)).toEqual(["0.5.0"]);
	});

	it("a failed install leaves nothing behind — no half payload for the stub to run", async () => {
		await expect(
			installPayload("0.5.0", root, async (dir) => {
				writeInstalled(dir, "0.5.0");
				throw new Error("ETIMEDOUT");
			}),
		).rejects.toThrow("ETIMEDOUT");
		expect(readdirSync(root)).toEqual([]);
	});

	it("refuses an install that produced no usable package", async () => {
		await expect(installPayload("0.5.0", root, async () => undefined)).rejects.toThrow(/installed no @proagentstore\/cli@0\.5\.0/);
		expect(readdirSync(root)).toEqual([]);
	});

	it("does not reinstall a version it already has", async () => {
		const install = vi.fn(async (dir: string, v: string) => void writeInstalled(dir, v));
		await installPayload("0.5.0", root, install);
		await installPayload("0.5.0", root, install);
		expect(install).toHaveBeenCalledTimes(1);
	});

	it("keeps only the two newest versions", async () => {
		for (const v of ["0.5.0", "0.5.2", "0.5.10"]) await installPayload(v, root, async (dir, ver) => void writeInstalled(dir, ver));
		expect(readdirSync(root).sort()).toEqual(["0.5.10", "0.5.2"]);
		expect(existsSync(join(root, "0.5.0"))).toBe(false);
	});
});
