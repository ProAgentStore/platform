/**
 * The Ops queue asks for statuses the column can hold (#638).
 *
 * The defect this pins, in one sentence: the stuck-session filter named `'failed'`,
 * `'needs_human'` and `'blocked'` — none of them a member of `CodingSessionStatus` — and omitted
 * `'error'`, the one failure status anything writes. So the only rows it could ever return were
 * the "active but idle" ones, and the panel answered "No stuck sessions. 🎉" for exactly the
 * failure mode it exists to surface.
 *
 * It is the #611 shape one table over: an unmatchable member of a `WHERE … IN` list behaves
 * exactly like a matchable one that happens to find nothing, so no behavioural test can tell them
 * apart. Only the type can — which is why the load-bearing assertion here is the `satisfies` on
 * the constant plus the compile-time assignment below, and the runtime checks are about the SQL
 * being BUILT from that constant rather than typed beside it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CodingSessionStatus } from "../lib/coding-types.js";
import { CAP, STUCK_SESSION_STATUSES } from "./admin-ops.js";

/**
 * The guard, as a type. Restoring `'failed'` to the array fails `tsc -p tsconfig.test.json` —
 * the gate #599 added so a type-level assertion in a worker test compiles somewhere and can
 * actually go red.
 */
const _everyStuckStatusIsARealSessionStatus: readonly CodingSessionStatus[] = STUCK_SESSION_STATUSES;

const source = readFileSync(new URL("./admin-ops.ts", import.meta.url).pathname, "utf8");
/** The route body only — the doc comments legitimately quote the old, broken filter. */
const code = source
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.split("\n")
	.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
	.join("\n");

describe("the stuck-session filter", () => {
	it("asks for `error` — the one failure status a session can actually end in", () => {
		// lib/coding-session-open.ts closes a session that can no longer do anything with
		// `endSession(..., "error")`. That row is the whole point of this queue.
		expect([...STUCK_SESSION_STATUSES]).toEqual(["error"]);
		expect(_everyStuckStatusIsARealSessionStatus.length).toBe(1);
	});

	it("names none of the three values nothing can write, in either quoting", () => {
		// Both spellings: the SQL half used `'failed'`, and a re-introduction via the constant
		// would be `"failed"`. Checking one of the two is how half a fix passes a guard.
		for (const dead of ["failed", "needs_human", "blocked"]) {
			expect(code, `'${dead}' is not a CodingSessionStatus and can never match a row`)
				.not.toContain(`'${dead}'`);
			expect(code, `"${dead}" is not a CodingSessionStatus and can never match a row`)
				.not.toContain(`"${dead}"`);
		}
	});

	it("builds its IN list from the constant instead of writing statuses into the SQL", () => {
		// The literal is what drifted from the type last time. A placeholder cannot.
		expect(code).toContain("STUCK_SESSION_STATUSES.map");
		expect(code).toContain("IN ($" + "{stuckPlaceholders})");
		expect(code).toContain(".bind(CAP, ...STUCK_SESSION_STATUSES)");
	});

	it("keeps the derived half — an `active` session nobody has touched for 20 minutes", () => {
		// `active` IS writable, so this branch always worked; it was the only one that did.
		expect(code).toContain("s.status = 'active'");
		expect(code).toContain("minutes'))");
	});
});

describe("the error-log 24h count (#648)", () => {
	// error_log collapses identical signatures into ONE row whose `repeat_count` tracks how many
	// times the error fired. COUNT(*) therefore undercounts by the collapse factor — a 1780-event
	// flood becomes ~24 rows and the "Errors (24h)" tile reads as a small number.
	// Separately, filtering on `created_at` misses a bucket opened 25h ago that is still absorbing
	// errors this minute; `COALESCE(last_seen_at, created_at)` is the recency expression the rest
	// of the error-log already uses (see lib/error-log.ts `ERROR_RECENCY`).
	it("sums occurrences, not rows", () => {
		// SUM(COALESCE(repeat_count, 1)) — the COALESCE covers rows written before migration 0103
		// that have no repeat_count yet; they count as one occurrence.
		expect(code).toContain("SUM(COALESCE(repeat_count, 1))");
		expect(code).not.toMatch(/SELECT COUNT\(\*\) AS n FROM error_log/);
	});

	it("filters on last_seen_at so a live outage is never excluded", () => {
		// A bucket opened 25h ago and still absorbing failures has a recent `last_seen_at`
		// but an old `created_at` — it would be excluded by `created_at >=` and the tile
		// would read zero during an ongoing outage.
		expect(code).toContain("COALESCE(last_seen_at, created_at)");
	});
});

describe("a capped list says it is capped", () => {
	it("publishes the cap it truncated at", () => {
		expect(CAP).toBe(50);
		expect(code).toContain("cap: CAP");
	});

	it("caps every list with the same figure it publishes", () => {
		// Three `LIMIT ?1` binds, all `CAP` — so one published number describes all three.
		expect(code.match(/LIMIT \?1/g)?.length).toBe(3);
		expect(code.match(/\.bind\(CAP[,)]/g)?.length).toBe(3);
	});
});
