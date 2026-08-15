import { describe, expect, it } from "vitest";
import { diffLock, parseSurfaceLock } from "./surface-lock.mjs";

/**
 * The shapes that matter to #576 are ones the repo must never contain: a rewritten entry, a
 * dropped entry, an export the parser can no longer find. So they are fed in as strings —
 * the same reason doc-claims.mjs and wire-surface.mjs take strings.
 *
 * The load-bearing distinction throughout is `null` vs an empty Map. "The lock records
 * nothing" and "this parser can no longer read the lock" are different answers, and a guard
 * that collapses them retires itself silently (ADR 0002 G3).
 */

const LOCK = `export const SURFACE_LOCK: Record<string, string> = {
	// prose about 0.1.1
	"0.1.1": "sha256:aaa",
	// prose about 0.1.2, which mentions a "quoted phrase" and a { brace }
	"0.1.2": "sha256:bbb",
};`;

describe("parseSurfaceLock", () => {
	it("reads every entry, ignoring the per-entry prose", () => {
		expect([...parseSurfaceLock(LOCK)]).toEqual([
			["0.1.1", "sha256:aaa"],
			["0.1.2", "sha256:bbb"],
		]);
	});

	it("returns null — not an empty map — when the export is gone or renamed", () => {
		// The silent-retirement case. An empty map would flow into diffLock as "nothing was
		// ever recorded", and every past entry would read as REMOVED or, worse, as nothing
		// to check at all.
		expect(parseSurfaceLock("export const SOMETHING_ELSE = { \"0.1.1\": \"sha256:aaa\" };")).toBeNull();
		expect(parseSurfaceLock("// the lock moved somewhere else")).toBeNull();
	});

	it("returns an empty map, not null, when the export is present and genuinely empty", () => {
		const empty = parseSurfaceLock("export const SURFACE_LOCK: Record<string, string> = {};");
		expect(empty).not.toBeNull();
		expect(empty.size).toBe(0);
	});

	it("brace-matches, so a nested object cannot truncate the map into a false deletion", () => {
		const nested = `export const SURFACE_LOCK: Record<string, unknown> = {
	"0.1.1": { "hash": "sha256:aaa" },
	"0.1.2": "sha256:bbb",
};`;
		// A lazy match to the first `}` would stop inside the nested object and report 0.1.2
		// as gone — which this guard would then call a REMOVED entry and fail the build on.
		expect(parseSurfaceLock(nested).get("0.1.2")).toBe("sha256:bbb");
	});

	it("survives the type annotation being dropped or changed", () => {
		expect(parseSurfaceLock('export const SURFACE_LOCK = {\n\t"0.1.1": "sha256:aaa",\n};').get("0.1.1")).toBe(
			"sha256:aaa",
		);
	});
});

describe("diffLock", () => {
	const before = new Map([
		["0.1.1", "sha256:aaa"],
		["0.1.2", "sha256:bbb"],
	]);

	it("permits an addition — the normal act, and the one the lock exists for", () => {
		const after = new Map([...before, ["0.1.3", "sha256:ccc"]]);
		expect(diffLock(before, after)).toEqual({ rewritten: [], removed: [], added: ["0.1.3"] });
	});

	it("catches an entry rewritten in place — #576's whole subject", () => {
		const after = new Map([...before]);
		after.set("0.1.2", "sha256:zzz");
		expect(diffLock(before, after)).toEqual({
			rewritten: [{ version: "0.1.2", was: "sha256:bbb", now: "sha256:zzz" }],
			removed: [],
			added: [],
		});
	});

	it("catches an entry deleted, which is the same claim made by omission", () => {
		const after = new Map([["0.1.1", "sha256:aaa"]]);
		expect(diffLock(before, after)).toEqual({ rewritten: [], removed: ["0.1.2"], added: [] });
	});

	it("is silent when nothing moved", () => {
		expect(diffLock(before, new Map(before))).toEqual({ rewritten: [], removed: [], added: [] });
	});

	it("reports a rewrite AND an addition in the same revision, rather than letting one mask the other", () => {
		// The realistic disguise: bump the version, add its entry, and quietly correct the
		// old one in the same commit. The addition is legitimate; the rewrite is not, and
		// the diff has to say both.
		const after = new Map([
			["0.1.1", "sha256:TAMPERED"],
			["0.1.2", "sha256:bbb"],
			["0.1.3", "sha256:ccc"],
		]);
		const d = diffLock(before, after);
		expect(d.rewritten).toEqual([{ version: "0.1.1", was: "sha256:aaa", now: "sha256:TAMPERED" }]);
		expect(d.added).toEqual(["0.1.3"]);
	});
});
