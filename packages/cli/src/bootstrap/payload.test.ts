/**
 * The stub's payload cache (#862): only complete payloads count, an install is all-or-nothing, and
 * the cache keeps the last two versions.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveActionsPayload, approvedActionsPayload, approvedActionsVersion, cachedPayloads, installPayload, newestPayload, payloadAt, pinActionsPayload, pinnedActionsVersions, unpinActionsPayload } from "./payload.js";
import { writeInstalled, writePackage } from "./test-payload.js";
import { markBad } from "./trial.js";

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

	it("keeps an approved Actions payload and a live pinned supervisor across later installs", async () => {
		for (const v of ["0.5.0", "0.5.1"]) await installPayload(v, root, async (dir, ver) => void writeInstalled(dir, ver));
		approveActionsPayload("0.5.0", root);
		pinActionsPayload("0.5.1", process.pid, root);
		await installPayload("0.5.2", root, async (dir, ver) => void writeInstalled(dir, ver));
		await installPayload("0.5.3", root, async (dir, ver) => void writeInstalled(dir, ver));
		expect(cachedPayloads(root).map((p) => p.version).sort()).toEqual(["0.5.0", "0.5.1", "0.5.2", "0.5.3"]);
		expect(pinnedActionsVersions(root, Date.now(), (pid) => pid === process.pid)).toEqual(new Set(["0.5.1"]));
		unpinActionsPayload("0.5.1", process.pid, root);
		expect(pinnedActionsVersions(root)).toEqual(new Set());
	});
});

describe("Actions approval", () => {
	it("exposes only a complete relay-proven cached payload and never downgrades approval", async () => {
		const bundled = payloadAt(join(root, "bundled"));
		await installPayload("0.5.1", root, async (dir, ver) => void writeInstalled(dir, ver));
		expect(approvedActionsPayload(root, bundled)).toBeNull();
		approveActionsPayload("0.5.1", root);
		expect(approvedActionsVersion(root)).toBe("0.5.1");
		expect(approvedActionsPayload(root, null)?.version).toBe("0.5.1");
		approveActionsPayload("0.5.0", root);
		expect(approvedActionsVersion(root)).toBe("0.5.1");
	});

	// #1374 — "rollback of a bad candidate": a release the PAGS startup probe gave up on never reaches an Actions service.
	it("a rolled-back candidate is never approved for Actions, and a candidate approved earlier stops counting once it is marked bad", async () => {
		await installPayload("0.5.1", root, async (dir, ver) => void writeInstalled(dir, ver));
		await installPayload("0.5.2", root, async (dir, ver) => void writeInstalled(dir, ver));
		markBad(root, "0.5.2", "startup probe failed", "0.5.1", Date.now(), { notice: false });
		approveActionsPayload("0.5.2", root);
		expect(approvedActionsVersion(root)).toBeNull();
		expect(approvedActionsPayload(root, null)).toBeNull();
		approveActionsPayload("0.5.1", root);
		expect(approvedActionsVersion(root)).toBe("0.5.1");
		// The probe fails AFTER the approval was written (a later trial): the approval is withdrawn, not left pointing at bad code.
		markBad(root, "0.5.1", "regressed on trial", null, Date.now(), { notice: false });
		expect(approvedActionsVersion(root)).toBeNull();
		expect(approvedActionsPayload(root, null)).toBeNull();
	});

	// #1374 — "reboot during handoff": a supervisor that died without unpinning protects nothing, so the cache can still be pruned.
	it("a pin left by a dead or stale supervisor (a reboot mid-handoff) protects no payload; a live fresh one does", () => {
		pinActionsPayload("0.5.1", 4242, root);
		// A moment after the pins are written (a pin stamped later than `now` is ignored as clock skew, so `now` must not trail them).
		const now = Date.now() + 1000;
		expect(pinnedActionsVersions(root, now, () => true)).toEqual(new Set(["0.5.1"]));
		expect(pinnedActionsVersions(root, now, () => false)).toEqual(new Set());
		expect(pinnedActionsVersions(root, now + 90_000, () => true)).toEqual(new Set());
		// Pins are per process: another supervisor's pin on the same version does not keep this one's alive.
		pinActionsPayload("0.5.1", 5252, root);
		unpinActionsPayload("0.5.1", 4242, root);
		expect(pinnedActionsVersions(root, now, (pid) => pid === 5252)).toEqual(new Set(["0.5.1"]));
		expect(pinnedActionsVersions(root, now, (pid) => pid === 4242)).toEqual(new Set());
	});
});
