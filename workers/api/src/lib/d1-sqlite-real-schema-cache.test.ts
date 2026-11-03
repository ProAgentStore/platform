/**
 * #1449 — `realSchemaD1()` used to replay all ~300 migrations from scratch on every call
 * (several hundred ms to multiple seconds each), which is most of what made
 * `application-runner-routes.test.ts` / `scope-evidence.test.ts` / `workflow-run.test.ts`
 * so slow. It now clones a cached, file-based template built once per (process,
 * migration-content hash) instead of re-running every `CREATE TABLE`.
 *
 * This file is about THAT layer only — the cache, the clone, and the isolation between
 * clones. The migration chain itself is already exercised directly through
 * `migrationSchemaDb()` by `sql-schema.test.ts`, `seed-workflow-runtime.test.ts`,
 * `agent-cascade.invariant.test.ts` and `sql-time.test.ts`; this file does not duplicate
 * that coverage.
 */
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SCHEMA_CACHE_DIR, realSchemaD1, seedTenant } from "./d1-sqlite.js";

function cloneFileCount(): number {
	if (!existsSync(SCHEMA_CACHE_DIR)) return 0;
	return readdirSync(SCHEMA_CACHE_DIR).filter((f) => f.startsWith("clone-")).length;
}

describe("realSchemaD1() real-schema cache (#1449)", () => {
	it("still returns a database with every migration applied", () => {
		const d1 = realSchemaD1();
		try {
			seedTenant(d1, { userId: "cache-u1", instanceIds: ["cache-i1"] });
			const row = d1.sqlite.prepare("SELECT github_login FROM users WHERE id = ?").get("cache-u1");
			expect(row).toEqual({ github_login: "cache-u1" });
		} finally {
			d1.close();
		}
	});

	it("gives two calls their own file and connection — a write to one is invisible to the other", () => {
		const a = realSchemaD1();
		const b = realSchemaD1();
		try {
			seedTenant(a, { userId: "only-in-a", instanceIds: [] });
			const seenFromA = a.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get("only-in-a") as { n: number };
			const seenFromB = b.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get("only-in-a") as { n: number };
			expect(seenFromA.n).toBe(1);
			expect(seenFromB.n).toBe(0);
		} finally {
			a.close();
			b.close();
		}
	});

	it("amortizes the migration replay: once the template is warm, repeated calls are fast", () => {
		// Warm the per-process template cache (a no-op if an earlier test already did).
		realSchemaD1().close();

		const start = process.hrtime.bigint();
		const dbs = Array.from({ length: 20 }, () => realSchemaD1());
		const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
		for (const d1 of dbs) d1.close();

		// Replaying ~300 migrations fresh measured several seconds EACH locally; twenty
		// warm clones measured well under a second combined. The bound here is generous —
		// it is a regression trip-wire for "someone reintroduced a fresh migration replay
		// per call", not a tight perf assertion that would flake on a loaded CI box.
		expect(elapsedMs).toBeLessThan(5000);
	});

	it("close() removes its own clone file and leaves no growth behind", () => {
		const before = cloneFileCount();
		const d1 = realSchemaD1();
		expect(cloneFileCount()).toBe(before + 1);
		d1.close();
		expect(cloneFileCount()).toBe(before);
	});
});
