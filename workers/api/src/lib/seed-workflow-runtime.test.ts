/**
 * No seeded agent may be in the state the new declaration guard refuses (#705).
 *
 * This is a prerequisite for that guard, not a follow-up. `PUT /v1/agents/:id` and
 * `PUT /v1/agents/:id/capabilities` now 400 on a `workflow` whose `runtime` cannot supply its
 * hands, and both routes check the block as it will stand AFTER the patch — so if a first-party
 * seed already carried the mismatch, the next converging capability update on it would fail, and
 * fail on a route the e2e suite never exercises (it does not create or update agents). Migration
 * `0108`'s header records what a converging capability update getting this wrong costs: `0107`
 * dropped `set_direction` because it rewrote a tool list it had not read.
 *
 * Checked two ways, because neither alone covers the migrations:
 *
 *   1. **Executed.** Apply every migration to real SQLite and read the `agents` rows that result.
 *      Exact — it sees the value each agent ENDS with after all the later migrations that rewrite
 *      `$.capabilities` on top of the seed, which is the thing a route would actually be patching.
 *   2. **Parsed.** Several migrations `UPDATE` rows that no migration creates (`0022` sets
 *      capabilities on `job-application-assistant`, which is seeded in production, not here), so
 *      their capability objects never materialise in (1) and are invisible to it. The text scan
 *      reads every `{"runtime": …, "workflow": …}` a migration writes, whether or not a row exists
 *      for it to land on, and refuses to pass if a pair is written in a shape it cannot see.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowRuntimeDenial } from "./agent-workflows.js";
import { migrationFiles, migrationSchemaDb } from "./d1-sqlite.js";

describe("the seeded catalog satisfies the workflow/runtime guard (#705)", () => {
	it("leaves every migrated agent row in a declarable state", () => {
		const db = migrationSchemaDb();
		const rows = db.prepare("SELECT slug, config FROM agents").all() as { slug: string; config: string | null }[];
		// Not vacuous: if the seeds ever stop landing here this must go red, not quietly pass.
		expect(rows.length, "no agents seeded by the migrations — did the harness break?").toBeGreaterThan(5);
		for (const row of rows) {
			let caps: Record<string, unknown> = {};
			try {
				const cfg = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
				caps = (cfg.capabilities ?? {}) as Record<string, unknown>;
			} catch {
				throw new Error(`agent "${row.slug}" has unparseable config`);
			}
			expect(workflowRuntimeDenial(caps.workflow, caps.runtime ?? null), `seeded agent "${row.slug}"`).toBeNull();
		}
	});

	it("writes no unsatisfiable pair in any migration, including onto rows it does not create", () => {
		// `"runtime"` always immediately precedes `"workflow"` in every capability object the
		// migrations write, inline or pretty-printed. That is an observation, not a rule, so the
		// coverage assertion below is what makes it safe: a future migration that writes the pair
		// in some other order fails this test rather than slipping past the scan unread.
		const PAIR = /"runtime"\s*:\s*(null|"[a-z]+")\s*,\s*"workflow"\s*:\s*(null|"[A-Z_]+")/g;
		let pairs = 0;
		let declarations = 0;
		for (const file of migrationFiles()) {
			const sql = readFileSync(join(__dirname, "..", "..", "migrations", file), "utf8");
			// Count the capability WRITES, so the scan's coverage can be checked against them.
			// `github_workflow_runs` (a tool name) and `watch_workflow_id` (a column) are not
			// `"workflow":` keys and do not match.
			declarations += (sql.match(/"workflow"\s*:/g) ?? []).length;
			for (const m of sql.matchAll(PAIR)) {
				pairs++;
				const runtime = m[1] === "null" ? null : JSON.parse(m[1]);
				const workflow = m[2] === "null" ? null : JSON.parse(m[2]);
				expect(workflowRuntimeDenial(workflow, runtime), `${file} declares ${m[0]}`).toBeNull();
			}
		}
		expect(pairs, "no capability pairs found — the scan matched nothing").toBeGreaterThan(5);
		expect(pairs, "a migration writes capabilities.workflow in a shape this scan cannot read").toBe(declarations);
	});
});
