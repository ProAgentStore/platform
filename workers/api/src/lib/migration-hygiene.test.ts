/**
 * The guard over `workers/api/migrations/` (#369), driven end-to-end.
 *
 * `scripts/check-migrations.mjs` asserts two things nobody can see in review: that no two
 * migrations claim the same number, and that a migration's DDL has not been edited since the
 * commit it shipped in. Both arms have a recorded exception — the 0092 pair, which may not be
 * renamed, and four seeds whose text was changed after they shipped — and an exception is
 * exactly where a guard quietly stops firing. So this drives the real script over throwaway
 * git repositories and asserts each arm goes RED for the mistake it is about.
 *
 * A child process rather than an import, on purpose: the exit code IS the contract (CI reads
 * nothing else), and the script's own top-level walk runs as it will run in CI.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = new URL("../../../../scripts/check-migrations.mjs", import.meta.url).pathname;
const REPO = new URL("../../../../", import.meta.url).pathname;

const temps: string[] = [];
afterAll(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** Runs the guard and reports the two things a caller cares about. */
function check(dir: string): { ok: boolean; out: string } {
	try {
		execFileSync("node", [SCRIPT, dir, "--require-history"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, out: "" };
	} catch (e) {
		const err = e as { stderr?: string; stdout?: string };
		return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

/**
 * A one-commit git repository holding `files` as migrations, so the guard sees the same shape
 * it sees in this repo: tracked files with a commit that introduced them.
 */
function fixture(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "pags-migrations-"));
	temps.push(root);
	const dir = join(root, "migrations");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	execFileSync("mkdir", ["-p", dir]);
	git("init", "-q", "-b", "main");
	git("config", "user.email", "guard@example.test");
	git("config", "user.name", "Guard Fixture");
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	git("add", "-A");
	git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed");
	return dir;
}

/** Adds files to an existing fixture and commits them as a second commit. */
function commit(dir: string, files: Record<string, string>): void {
	const root = join(dir, "..");
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "edit"], { cwd: root, stdio: "ignore" });
}

const CLEAN = {
	"0001_users.sql": "-- the first one\nCREATE TABLE users (id TEXT PRIMARY KEY);\n",
	"0002_index.sql": "CREATE INDEX idx_users_id ON users(id);\n",
};

describe("migration numbering (#369)", () => {
	it("passes on a directory where every number is unique", () => {
		expect(check(fixture(CLEAN)).ok).toBe(true);
	});

	it("fails when two migrations share a number", () => {
		const { ok, out } = check(fixture({ ...CLEAN, "0002_other.sql": "CREATE TABLE other (id TEXT);\n" }));
		expect(ok).toBe(false);
		expect(out).toContain("share the number 0002");
	});

	it("fails on a filename whose number is not four digits", () => {
		// `100_x.sql` sorts before `0099_x.sql`, so wrangler would run it in a place the number
		// does not describe — the same failure the duplicate causes, by a different route.
		const { ok, out } = check(fixture({ ...CLEAN, "100_late.sql": "CREATE TABLE late (id TEXT);\n" }));
		expect(ok).toBe(false);
		expect(out).toContain("not a migration filename");
	});

	// ── the recorded 0092 collision ────────────────────────────────────────────────────────
	//
	// It is exempt because neither file can be renamed: both are applied in production, and
	// wrangler keys applied migrations by filename, so a rename re-runs a migration whose
	// `ALTER TABLE … ADD COLUMN` cannot survive a second run. The exemption is therefore
	// exactly two named files, and these three cases pin all three of its edges.

	it("accepts the historical 0092 pair without asking for a rename", () => {
		expect(check(fixture({ ...CLEAN, "0092_ai_usage_payer.sql": "ALTER TABLE ai_usage ADD COLUMN payer TEXT;\n", "0092_coder_repo_engine_copy.sql": "UPDATE agents SET config = config;\n" })).ok).toBe(true);
	});

	it("fails when a THIRD file joins the exempt number", () => {
		const { ok, out } = check(
			fixture({
				...CLEAN,
				"0092_ai_usage_payer.sql": "ALTER TABLE ai_usage ADD COLUMN payer TEXT;\n",
				"0092_coder_repo_engine_copy.sql": "UPDATE agents SET config = config;\n",
				"0092_something_new.sql": "CREATE TABLE something (id TEXT);\n",
			}),
		);
		expect(ok).toBe(false);
		expect(out).toContain("joined the recorded 0092 collision");
	});

	it("does not apply the exemption to a directory that has neither of its files", () => {
		// The lists describe workers/api/migrations. Pointed at some other tree — which is all
		// this test file ever does — an absent entry is out of scope, not dead config.
		expect(check(fixture(CLEAN)).ok).toBe(true);
	});
});

describe("a migration that has shipped is frozen (#369)", () => {
	it("fails when a committed migration's DDL is changed", () => {
		const dir = fixture(CLEAN);
		commit(dir, { "0001_users.sql": "-- the first one\nCREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);\n" });
		const { ok, out } = check(dir);
		expect(ok).toBe(false);
		expect(out).toContain("0001_users.sql has had its DDL changed");
	});

	it("fails on an edit that has not been committed yet", () => {
		// The moment it is cheapest to fix, and the only reading a pre-commit run can give: the
		// comparison is baseline-vs-DISK, not baseline-vs-HEAD.
		const dir = fixture(CLEAN);
		writeFileSync(join(dir, "0001_users.sql"), "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);\n");
		expect(check(dir).ok).toBe(false);
	});

	it("allows a comment on a shipped migration to be corrected", () => {
		// Not an oversight — the point. `0080_ai_usage_cost_source.sql` had its comment corrected
		// in place because that comment was where a wrong idea had been written down and then
		// believed. A rule that forbade this would be protecting the mistake.
		const dir = fixture(CLEAN);
		commit(dir, { "0001_users.sql": "-- CORRECTED: this table is per ACCOUNT, not per person.\nCREATE TABLE users (id TEXT PRIMARY KEY);\n" });
		expect(check(dir).ok).toBe(true);
	});

	it("does not mistake a `--` inside a seeded string for a comment", () => {
		// These files are full of JSON payloads. If the stripper treated `--` inside a literal as
		// the start of a comment, everything after it on that line would be invisible to the
		// comparison — and seed edits are the drift this arm exists to catch.
		const dir = fixture({ "0001_seed.sql": "INSERT INTO agents (id, note) VALUES ('a', 'read the docs -- carefully');\n" });
		commit(dir, { "0001_seed.sql": "INSERT INTO agents (id, note) VALUES ('a', 'read the docs -- and then ignore them');\n" });
		const { ok, out } = check(dir);
		expect(ok).toBe(false);
		expect(out).toContain("has had its DDL changed");
	});

	it("ignores reformatting, and a migration not yet committed", () => {
		const dir = fixture(CLEAN);
		commit(dir, { "0001_users.sql": "-- the first one\nCREATE TABLE users (\n  id TEXT PRIMARY KEY\n);\n" });
		writeFileSync(join(dir, "0003_uncommitted.sql"), "CREATE TABLE draft (id TEXT);\n");
		expect(check(dir).ok).toBe(true);
	});

	it("refuses to report success from history it could not read", () => {
		// `--require-history` is what stops this arm becoming a no-op the day someone drops
		// `fetch-depth: 0` from the checkout — the classic way a history-dependent CI check dies
		// while still printing a tick.
		const root = mkdtempSync(join(tmpdir(), "pags-migrations-nogit-"));
		temps.push(root);
		const dir = join(root, "migrations");
		execFileSync("mkdir", ["-p", dir]);
		for (const [name, body] of Object.entries(CLEAN)) writeFileSync(join(dir, name), body);
		const { ok, out } = check(dir);
		expect(ok).toBe(false);
		expect(out).toContain("--require-history");
	});
});

describe("the real migrations directory", () => {
	it("passes the guard", () => {
		// The canary. CI runs this script as its own step, but a repo where `pnpm test` is green
		// and the collision is back is not a state worth allowing.
		expect(execFileSync("node", [SCRIPT, "--require-history"], { cwd: REPO, encoding: "utf-8" })).toContain("Migration hygiene OK");
	});
});
