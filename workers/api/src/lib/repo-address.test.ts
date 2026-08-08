import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A repo's address is written down in ONE place (#411).
 *
 * ── The defect this file exists to keep fixed
 *
 * "Which repo does this agent work on" used to be stored twice:
 *
 *   agent_instances.config.settings.repo   the field the console offered, that an owner could edit
 *   coding_repos.workdir                   the column every tool actually read
 *
 * Reported as "I updated it, but it is still using the old one", and both halves were true.
 * Chess coder's setting read `~/dev/stores/pas/platform/apps/chess-academy` while its repo row
 * read `~/dev/pas/platform/apps/chess-academy`, `updated_at` two days stale.
 *
 * The single wire between them (`attachSettingRepo`, #157/#182) fired on CREATE only, and only for
 * an instance with zero repos — so the first value seeded a row and every correction afterwards
 * went nowhere. Half a wire is worse than none, because it makes the field look connected.
 *
 * ── Why this is asserted structurally rather than behaviourally
 *
 * Two values can only disagree if two places store the same fact. So the invariant is not "keep
 * them in sync" (a sync that can fail is a disagreement waiting to happen — that is what was
 * removed) but "there is nowhere for a second copy to live". Two things make that true, and both
 * are checkable from the source:
 *
 *   1. No agent declares a `repo` SETTING, so no second value can be entered.
 *   2. The settings write path has no route into `coding_repos`, so a settings value cannot become
 *      a repo row even if one appeared.
 *
 * A behavioural test would exercise one of those paths; there is deliberately no longer a path to
 * exercise. #410's tests (routes/coding-repos.test.ts) cover the ONE remaining writer.
 */
const MIGRATIONS = join(import.meta.dirname, "..", "..", "migrations");
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const migration = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");

describe("no agent declares a `repo` setting any more", () => {
	it("0063 is the only migration that ever seeded one", () => {
		// A new seed carrying `{"id":"repo"}` re-creates the second home this ticket removed, and
		// would do it invisibly: the field stores faithfully and reads back, so it looks like it
		// works right up until the value has to mean something.
		const declaring = migrationFiles().filter((f) => /"id"\s*:\s*"repo"/.test(migration(f)));
		expect(declaring).toEqual(["0063_seed_coder2_agents.sql"]);
	});

	it("and a later migration takes it back off the Repo Coder", () => {
		// 0063 is APPLIED and frozen (see scripts/check-migrations.mjs GRANDFATHERED) — editing a
		// shipped seed fixes nothing in production while a fresh DB silently diverges, which is
		// exactly the trap 0063 itself is the repo's worked example of. So the removal is its own
		// migration, and it must sort after the seed.
		const removals = migrationFiles().filter((f) => /'\$\.id'\)\s*(<>|!=)\s*'repo'/.test(migration(f)));
		expect(removals.length, "a migration must remove the repo setting from coder-repo").toBe(1);
		expect(removals[0] > "0063_seed_coder2_agents.sql").toBe(true);

		const sql = migration(removals[0]);
		// Scoped to the one agent that declares it: a creator-authored agent's schema is not this
		// migration's business.
		expect(sql).toContain("slug = 'coder-repo'");
		// Rebuilds the array rather than removing an INDEX — the position is not guaranteed, and
		// `$.settingsSchema[0]` would delete whatever happened to be first.
		expect(sql).toContain("json_group_array");
		// Idempotent: re-running is a no-op, and it is a no-op on a DB without the agent.
		expect(sql).toMatch(/EXISTS\s*\(/);
	});

	it("does NOT adopt the orphaned values into a workdir", () => {
		// Stored `settings.repo` values stay inert on purpose. They were never validated and at
		// least one of them is provably wrong, so copying one into `coding_repos.workdir` would
		// install a broken path as though somebody had chosen it — the false `ready` claim #405
		// spent a whole ticket removing.
		const removals = migrationFiles().filter((f) => /'\$\.id'\)\s*(<>|!=)\s*'repo'/.test(migration(f)));
		expect(migration(removals[0])).not.toMatch(/UPDATE\s+coding_repos|INSERT\s+INTO\s+coding_repos/i);
	});
});

describe("the settings write path cannot create or move a repo row", () => {
	const instances = readFileSync(join(import.meta.dirname, "..", "routes", "instances.ts"), "utf8");
	/** Comments necessarily name what they forbid — the note explaining the removal must not fail
	 *  the test protecting it. */
	const code = instances
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");

	it("does not reach the repo store", () => {
		expect(code).not.toMatch(/\bcreateRepo\b/);
		expect(code).not.toMatch(/\bupdateRepoClone\b/);
	});

	it("does not touch the table directly either", () => {
		// Bypassing the store would satisfy the assertion above and re-create the defect.
		expect(code).not.toMatch(/coding_repos/);
	});

	it("reads no `repo` key out of a settings blob", () => {
		expect(code).not.toMatch(/\.repo\b/);
		expect(code).not.toMatch(/\[["']repo["']\]/);
	});
});
