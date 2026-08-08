import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newestMtimeUnder, sdkDistVerdict } from "./build-inputs.mjs";

/**
 * The e2e build preconditions, tested WITHOUT running Playwright (#413).
 *
 * That is the point of the file, not a convenience. The predicate this replaces was wrong for
 * two commits — it could not see `agents/coder/web`, so a Coder-UI change bumped no mtime it
 * walked and the suite ran against the previous bundle — and nothing could observe it except a
 * full e2e run, where the symptom is a spec failing for a reason that has nothing to do with
 * the spec.
 */

let dir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-build-inputs-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Write `name` with a fixed mtime, so ordering is asserted rather than raced. */
function fileAt(name, secondsSinceEpoch) {
	const full = join(dir, name);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, "x");
	utimesSync(full, secondsSinceEpoch, secondsSinceEpoch);
	return full;
}

describe("newestMtimeUnder", () => {
	it("returns 0 for a directory that does not exist", () => {
		expect(newestMtimeUnder(join(dir, "nope"))).toBe(0);
	});

	it("returns 0 for an empty directory", () => {
		expect(newestMtimeUnder(dir)).toBe(0);
	});

	it("finds the newest file at the top level", () => {
		fileAt("a.ts", 1000);
		fileAt("b.ts", 3000);
		fileAt("c.ts", 2000);
		expect(newestMtimeUnder(dir)).toBe(3000 * 1000);
	});

	it("descends into subdirectories — the nested file is what a UI change touches", () => {
		fileAt("a.ts", 1000);
		fileAt("deep/deeper/z.tsx", 5000);
		expect(newestMtimeUnder(dir)).toBe(5000 * 1000);
	});

	it("ignores dist, node_modules and dotfiles, which are outputs and not inputs", () => {
		fileAt("a.ts", 1000);
		fileAt("dist/bundle.js", 9000);
		fileAt("node_modules/dep/index.js", 9000);
		fileAt(".cache/blob", 9000);
		fileAt(".tsbuildinfo", 9000);
		// 9000 everywhere that does not count; 1000 is the only real input.
		expect(newestMtimeUnder(dir)).toBe(1000 * 1000);
	});

	it("ignores a NESTED dist too — a workspace package's own build output", () => {
		fileAt("pkg/src/a.ts", 1000);
		fileAt("pkg/dist/a.js", 9000);
		expect(newestMtimeUnder(dir)).toBe(1000 * 1000);
	});
});

describe("sdkDistVerdict", () => {
	it("reports missing when the entry point is not there", () => {
		expect(sdkDistVerdict({ entryExists: false, newestDistMtime: 0, newestSrcMtime: 5 })).toBe("missing");
	});

	it("reports missing even when the mtimes would say ok — absence outranks freshness", () => {
		expect(sdkDistVerdict({ entryExists: false, newestDistMtime: 100, newestSrcMtime: 5 })).toBe("missing");
	});

	it("reports stale when a source file is newer than everything emitted", () => {
		expect(sdkDistVerdict({ entryExists: true, newestDistMtime: 100, newestSrcMtime: 101 })).toBe("stale");
	});

	it("reports ok when the emitted files are newer", () => {
		expect(sdkDistVerdict({ entryExists: true, newestDistMtime: 200, newestSrcMtime: 101 })).toBe("ok");
	});

	it("treats an equal timestamp as ok — tsc can emit inside the same millisecond as the edit", () => {
		expect(sdkDistVerdict({ entryExists: true, newestDistMtime: 100, newestSrcMtime: 100 })).toBe("ok");
	});
});
