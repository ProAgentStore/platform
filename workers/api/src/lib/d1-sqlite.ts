/**
 * A D1 that actually runs the SQL, on the schema the migrations actually build (#438).
 *
 * ── The blind spot this exists to close
 *
 * Every D1 test in this Worker — 59 files of them — mocks the database by MATCHING the SQL
 * string: `if (sql.includes("FROM error_log")) return { results: [...] }`. The statement is
 * compared, never parsed and never executed. A suite of that shape cannot detect a syntax error,
 * a column that does not exist, or a platform limit, and three defects shipped green through it
 * in one week:
 *
 *   • #423 — a candidate read with six `SELECT`s joined by `UNION`. D1 caps a compound SELECT at
 *     FIVE terms, and it is a PARSE failure, so the statement never executed once, anywhere. It
 *     threw on every cron tick for 29.6 hours and wrote 1780 identical rows — 97% of the entire
 *     error log. `stats-rollup.test.ts` covered the pure helpers around it and passed throughout.
 *   • #434 — the same ceiling in `instance-work.ts`, where the union is built one branch per
 *     subordinate at runtime. `instance-work.test.ts` asserted the broken shape AS THE DESIGN
 *     ("issues EXACTLY ONE statement for 12 subordinates") against a stub that recorded SQL
 *     strings, so the suite actively defended the bug.
 *   • `external-usage.ts` selected `users.email`, a column no migration has ever created. It
 *     threw inside a `catch {}` and read as "nobody is an admin" for as long as it shipped. Found
 *     by pointing this harness at the tree for the first time.
 *
 * ── What it does
 *
 * Applies every migration in `workers/api/migrations` to an in-memory SQLite (`node:sqlite`, the
 * same engine D1 is), then answers the `D1Database` surface for real. A statement that does not
 * parse throws where the test can see it; so does one naming a table or column the schema has no
 * record of.
 *
 * ── What it CANNOT see, stated so nobody reads its silence as coverage
 *
 *   • **Whether a query that parses returns the right rows.** #451 shipped `WHERE agent_id = ?1`
 *     against a column that is NULL for every row in production: valid SQL, zero results, forever,
 *     and it looked correct in every test. Parsing has no opinion on data. Assert on rows.
 *   • **D1's own ceilings, except the one that is enforced here.** Local SQLite's
 *     `SQLITE_MAX_COMPOUND_SELECT` is its compile-time default of 500; D1 sets it to 5, which is
 *     the whole reason #423 was invisible. That one is applied by {@link assertD1Preparable}
 *     because the engine will not. The others — the documented ~100 bound parameters, the
 *     statement-length cap — are NOT modelled: they have not been measured against production the
 *     way {@link D1_MAX_COMPOUND_TERMS} was, and a guard asserting a number nobody checked is how
 *     a false red teaches people to suppress it.
 *   • **D1's argument type checking.** `undefined` is coerced to NULL and a boolean to 0/1 here.
 *     Real D1 is stricter about at least one of those. Not modelled, for the same reason.
 *   • **Anything the DO's own storage does.** This is `env.DB`, not `state.storage`.
 *   • **Query PLANS.** An index that stops being used is a production incident this cannot see.
 *   • **Any module no test drives through it.** 117 modules in this Worker issue SQL. The
 *     statically-resolvable ones are swept wholesale by `sql-schema.test.ts`; the ones that build
 *     their SQL at runtime are covered only where somebody wrote the test.
 *
 * NOT a `.test.ts` so that importing it does not re-register another file's suites, and excluded
 * from `workers/api/tsconfig.json` because it imports `node:sqlite` and `node:fs`, which the
 * Worker's own type environment rightly does not have. That exclusion is also the barrier: a
 * production module that imports this fails `pnpm typecheck` rather than shipping a filesystem
 * read into a Worker.
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { D1_MAX_COMPOUND_TERMS, compoundSelectTerms } from "./sql.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** Every migration file, in the order `check-migrations.mjs` guarantees they apply. */
export function migrationFiles(): string[] {
	return readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();
}

/**
 * A database with every migration applied.
 *
 * The migrations are the ONLY definition of the schema in this repo — there is no checked-in
 * `schema.sql` to drift from them — so building it this way means the guard is asking the same
 * question production is: does this statement work against what the migrations made?
 */
export function migrationSchemaDb(): DatabaseSync {
	return buildMigratedDb(":memory:");
}

/** Shared by `migrationSchemaDb` (`:memory:`) and the template builder (a real path). */
function buildMigratedDb(location: string): DatabaseSync {
	const db = new DatabaseSync(location);
	for (const [name, sql] of migrationSources()) {
		try {
			db.exec(sql);
		} catch (e) {
			throw new Error(`migration ${name} does not apply to SQLite: ${(e as Error).message}`);
		}
	}
	return db;
}

/** Read once per process. A `beforeEach` builds a fresh database per test; re-reading 111 files
 *  each time is most of what that costs. */
let sources: [string, string][] | undefined;
function migrationSources(): [string, string][] {
	if (!sources) sources = migrationFiles().map((f) => [f, readFileSync(join(MIGRATIONS_DIR, f), "utf8")]);
	return sources;
}

/** One schema build, shared by every caller in a file — 111 migrations is not free per test. */
let shared: DatabaseSync | undefined;
function sharedSchemaDb(): DatabaseSync {
	if (!shared) shared = migrationSchemaDb();
	return shared;
}

/**
 * Throw unless D1 could prepare `sql` against the real schema.
 *
 * TWO checks, and the order matters. The compound-term ceiling is applied FIRST because local
 * SQLite would happily parse a six-arm union and hand back a statement — the exact reason #423
 * was invisible to every environment anyone could run.
 */
export function assertD1Preparable(sql: string, db: DatabaseSync = sharedSchemaDb()): void {
	const terms = compoundSelectTerms(sql);
	if (terms > D1_MAX_COMPOUND_TERMS) {
		throw new Error(
			`too many terms in compound SELECT: ${terms} > ${D1_MAX_COMPOUND_TERMS} (D1's measured ceiling, #423).\n` +
				"D1 rejects this at PARSE time, so the statement never executes once — no environment can\n" +
				"exercise it. Issue one statement per source and merge in TypeScript, or chunk the union.\n" +
				sql,
		);
	}
	try {
		db.prepare(sql);
	} catch (e) {
		throw new Error(`${(e as Error).message}\n${sql}`);
	}
}

/** A statement the double was asked to run, kept so a test can assert on what was issued. */
export interface IssuedStatement {
	sql: string;
	binds: unknown[];
}

export interface RealSchemaD1 {
	/** Pass as `env.DB`. Shaped like `D1Database`; every call really executes. */
	DB: FakeD1;
	/** The underlying database, for seeding rows and reading them back. */
	sqlite: DatabaseSync;
	/** Every statement issued, in order. */
	issued: IssuedStatement[];
	/** Seed rows without going through the double's bookkeeping. */
	exec(sql: string): void;
	close(): void;
}

/**
 * Where a fully-migrated schema template (and its short-lived clones) lives. A plain
 * directory under the OS temp dir, not `node_modules/.cache`: it must survive being
 * shared across every `vitest` fork for this Worker, and must NOT be mistaken for build
 * output a `pnpm clean` ought to remove.
 */
export const SCHEMA_CACHE_DIR = join(tmpdir(), "pags-real-schema-cache");

/**
 * A content hash of every migration file (name AND body), so a template built from
 * migration set A is never handed to a test expecting migration set B. This is the
 * "invalidate on migration content changes" key the cache is organized around — add,
 * remove, or edit one migration and the next build gets a new filename instead of a
 * stale hit.
 */
function migrationsContentHash(): string {
	const h = createHash("sha256");
	for (const [name, sql] of migrationSources()) h.update(name).update("\0").update(sql);
	return h.digest("hex");
}

/**
 * A file-based database with every migration applied EXACTLY ONCE per (process, hash) —
 * built fresh the first time a given migration set is asked for, then reused by every
 * later call, including from other `vitest` fork processes that land on the same cache
 * directory. Building it costs the same ~300-migration replay `migrationSchemaDb` always
 * did; every clone of it (below) costs a file copy instead.
 *
 * Built as a file rather than `:memory:` because that is the only form a second process
 * — or a second call in this one — can cheaply copy without re-running a single `CREATE
 * TABLE`. Written to a PID-scoped temp path and `renameSync`'d into place so a half-built
 * file is never visible under the final name: two forks racing to build the same hash is
 * wasted work, never a corrupt read, because the content hash in the filename guarantees
 * whichever one lands is schema-equivalent to the other.
 */
let templatePath: string | undefined;
let templateHash: string | undefined;
function realSchemaTemplatePath(): string {
	const hash = migrationsContentHash();
	if (templatePath && templateHash === hash) return templatePath;
	mkdirSync(SCHEMA_CACHE_DIR, { recursive: true });
	const finalPath = join(SCHEMA_CACHE_DIR, `schema-${hash}.db`);
	// `existsSync` is safe to race: the file only ever appears at `finalPath` via the
	// `renameSync` below, so a filename collision always means a COMPLETE build —
	// never a half-written one caught mid-write.
	if (!existsSync(finalPath)) {
		const buildPath = join(SCHEMA_CACHE_DIR, `schema-${hash}.building-${process.pid}-${randomBytes(4).toString("hex")}.db`);
		const db = buildMigratedDb(buildPath);
		db.close();
		try {
			renameSync(buildPath, finalPath);
		} catch {
			// Another fork finished first; its file is schema-equivalent (same hash), so
			// ours is redundant, not wrong. Discard it rather than leaving it to rot.
			rmSync(buildPath, { force: true });
		}
	}
	templatePath = finalPath;
	templateHash = hash;
	return finalPath;
}

/**
 * A `D1Database` over a private file-backed SQLite carrying the real schema.
 *
 * Each call gets its OWN file and its OWN connection — nothing here is shared or mutable
 * across callers, so two tests stay exactly as order-independent as before. What changed
 * is HOW that fresh database gets its schema: instead of replaying every migration (the
 * cost `migrationSchemaDb` always pays, and still does for the explicit migration-chain
 * tests that call it directly), this clones a cached template built by that same replay
 * once per (process, migration-content hash) — a file copy instead of ~300 `CREATE
 * TABLE`s. #1449.
 */
export function realSchemaD1(): RealSchemaD1 {
	const template = realSchemaTemplatePath();
	const clonePath = join(SCHEMA_CACHE_DIR, `clone-${process.pid}-${randomBytes(8).toString("hex")}.db`);
	copyFileSync(template, clonePath);
	const sqlite = new DatabaseSync(clonePath);
	const issued: IssuedStatement[] = [];
	pendingClones.add(clonePath);
	return {
		DB: new FakeD1(sqlite, issued),
		sqlite,
		issued,
		exec: (sql: string) => sqlite.exec(sql),
		close: () => {
			sqlite.close();
			pendingClones.delete(clonePath);
			rmSync(clonePath, { force: true });
		},
	};
}

/**
 * Not every one of the ~300 `realSchemaD1()` call sites closes what it opens — harmless
 * for the old `:memory:` database, which GC reclaims with no filesystem trace. A clone
 * file left after the process exits is not: this backstop sweeps anything still
 * outstanding when the process goes down, so a test that forgets to close leaks nothing
 * on disk either.
 */
const pendingClones = new Set<string>();
process.once("exit", () => {
	for (const p of pendingClones) rmSync(p, { force: true });
});

/**
 * The owner, agent and instance rows every other table's foreign keys point at.
 *
 * Foreign keys are left ON. They cost a fixture three extra inserts and they buy the thing a
 * string-matching stub can never give: a write that violates the schema fails in the test rather
 * than in production. A `trigger` row is seeded too, because `agent_trigger_events` — one of the
 * rollup's six activity sources — references one.
 */
export function seedTenant(d1: RealSchemaD1, opts: { userId: string; instanceIds: readonly string[] }): void {
	const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
	d1.exec(`INSERT OR IGNORE INTO users (id, github_login) VALUES (${q(opts.userId)}, ${q(opts.userId)})`);
	d1.exec(
		`INSERT OR IGNORE INTO agents (id, owner_id, slug, name) VALUES ('agent-1', ${q(opts.userId)}, 'seeded', 'Seeded')`,
	);
	for (const id of opts.instanceIds) {
		d1.exec(
			`INSERT OR IGNORE INTO agent_instances (id, agent_id, user_id) VALUES (${q(id)}, 'agent-1', ${q(opts.userId)})`,
		);
		d1.exec(
			`INSERT OR IGNORE INTO agent_triggers (id, user_id, agent_id, instance_id, name, type, action)
			  VALUES (${q(`trig-${id}`)}, ${q(opts.userId)}, 'agent-1', ${q(id)}, 'seeded', 'cron', 'run_pipeline')`,
		);
	}
}

/** D1 accepts a narrow set of value types; map the JS ones a test may hand over. */
function bindable(v: unknown): null | number | bigint | string | Uint8Array {
	if (v === undefined || v === null) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
	if (v instanceof Uint8Array) return v;
	if (v instanceof ArrayBuffer) return new Uint8Array(v);
	throw new Error(`cannot bind ${Object.prototype.toString.call(v)} to a D1 statement`);
}

class FakeD1 {
	constructor(
		private readonly db: DatabaseSync,
		private readonly issued: IssuedStatement[],
	) {}

	prepare(sql: string): D1PreparedStatement {
		assertD1Preparable(sql, this.db);
		return new FakeD1Statement(this.db, this.issued, sql, []) as unknown as D1PreparedStatement;
	}

	async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
		const out: D1ResultLike<T>[] = [];
		for (const s of statements) out.push(await (s as unknown as FakeD1Statement).all<T>());
		return out as unknown as D1Result<T>[];
	}

	async exec(sql: string): Promise<D1ExecResult> {
		this.db.exec(sql);
		return { count: 0, duration: 0 } as D1ExecResult;
	}

	/**
	 * Sessions use the same in-memory connection, which gives the test double the
	 * same read-your-writes behavior as a D1 session without pretending to model
	 * replica routing or bookmarks.
	 */
	withSession(_constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
		return {
			prepare: (sql: string) => this.prepare(sql),
			batch: <T = unknown>(statements: D1PreparedStatement[]) => this.batch<T>(statements),
			getBookmark: () => null,
		};
	}

	/** D1's deprecated export API is deliberately unavailable to the fixture. */
	async dump(): Promise<ArrayBuffer> {
		return new ArrayBuffer(0);
	}
}

export interface D1ResultLike<T> {
	results: T[];
	success: true;
	meta: { changes: number; last_row_id: number; duration: number; rows_read: number; rows_written: number };
}

class FakeD1Statement {
	constructor(
		private readonly db: DatabaseSync,
		private readonly issued: IssuedStatement[],
		private readonly sql: string,
		private readonly binds: unknown[],
	) {}

	bind(...values: unknown[]): FakeD1Statement {
		return new FakeD1Statement(this.db, this.issued, this.sql, values);
	}

	private run_(): { stmt: StatementSync; values: (null | number | bigint | string | Uint8Array)[] } {
		this.issued.push({ sql: this.sql, binds: this.binds });
		return { stmt: this.db.prepare(this.sql), values: this.binds.map(bindable) };
	}

	async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
		const { stmt, values } = this.run_();
		// `.all()` on a write is legal in D1 and used here, so fall back to running it.
		let results: T[] = [];
		let changes = 0;
		let lastRowId = 0;
		try {
			results = stmt.all(...values) as T[];
		} catch (e) {
			if (!/does not return data|use run\(\)/i.test((e as Error).message)) throw e;
			const r = stmt.run(...values);
			changes = Number(r.changes);
			lastRowId = Number(r.lastInsertRowid);
		}
		return {
			results,
			success: true,
			meta: { changes, last_row_id: lastRowId, duration: 0, rows_read: results.length, rows_written: changes },
		};
	}

	async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
		const { stmt, values } = this.run_();
		const row = stmt.get(...values) as Record<string, unknown> | undefined;
		if (row === undefined) return null;
		return (column === undefined ? row : (row[column] ?? null)) as T;
	}

	async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
		const { stmt, values } = this.run_();
		const r = stmt.run(...values);
		return {
			results: [],
			success: true,
			meta: {
				changes: Number(r.changes),
				last_row_id: Number(r.lastInsertRowid),
				duration: 0,
				rows_read: 0,
				rows_written: Number(r.changes),
			},
		};
	}

	async raw<T = unknown[]>(): Promise<T[]> {
		const { stmt, values } = this.run_();
		const rows = stmt.all(...values) as Record<string, unknown>[];
		return rows.map((r) => Object.values(r)) as T[];
	}
}
