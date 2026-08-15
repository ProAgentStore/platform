/**
 * Unit tests for the status-domain scanner (#590).
 *
 * These matter more than they look, for the reason `source-guard.test.ts` states about its own
 * lexer: a scanner bug does not produce a false alarm someone investigates, it produces silence —
 * and silence is exactly what a passing guard looks like. Every fixture below is a shape that was
 * actually wrong in the first draft of this scanner, measured against the real tree.
 */
import { describe, expect, it } from "vitest";
import {
	aliasesFor,
	callArguments,
	enclosingFunction,
	findDecisions,
	literalsIn,
	parseDeclaredColumns,
	parseDefault,
	queriesTable,
	type Source,
	sqlStatements,
	stripComments,
	tablesIn,
	writableValues,
	writeStatements,
} from "./status-domain-guard.js";

const src = (rel: string, code: string): Source => ({ rel, code: stripComments(code) });

describe("stripComments keeps the literals, which is the whole difference from source-guard", () => {
	it("blanks comments but preserves string contents", () => {
		const out = stripComments(`// status = 'active'\nconst q = "SET status = 'active'";`);
		expect(out).not.toContain("// status");
		expect(out).toContain("'active'");
	});

	it("preserves line numbers through a block comment", () => {
		expect(stripComments("a;\n/* x\n y\n */\ne;").split("\n")).toHaveLength(5);
	});

	it("does not eat the rest of a line because a string contained //", () => {
		const out = stripComments(`f("https://x"); const s = 'ready';`);
		expect(out).toContain("'ready'");
	});
});

describe("literalsIn reads BOTH nesting levels", () => {
	it("finds a SQL literal inside a TypeScript string", () => {
		// The bug that made the first run report "no application writer" for nine values that are
		// written in plain sight: an alternation consumed the outer `"…"` and never looked inside.
		expect(literalsIn(`"UPDATE users SET subscription_status = 'active' WHERE id = ?1"`)).toContain("active");
	});

	it("finds a plain TypeScript argument literal", () => {
		expect(literalsIn(`updateRuntimeStatus(env, id, uid, "offline", node)`)).toContain("offline");
	});

	it("finds a SQL literal inside a template literal", () => {
		expect(literalsIn("`INSERT INTO agents (status) VALUES ('inactive')`")).toContain("inactive");
	});
});

describe("parseDeclaredColumns reads the schema's own convention", () => {
	const files = [
		{
			name: "0001_init.sql",
			sql: `CREATE TABLE agents (\n  id TEXT,\n  status TEXT NOT NULL DEFAULT 'inactive',  -- inactive, active, error\n);`,
		},
		{
			name: "0052.sql",
			sql: `CREATE TABLE IF NOT EXISTS pipeline_runs (\n  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed'\n);`,
		},
		{
			name: "0011.sql",
			sql: `CREATE TABLE t (\n  capabilities TEXT NOT NULL DEFAULT '[]',        -- JSON array\n  status TEXT NOT NULL DEFAULT 'registered',     -- registered, online, offline\n);`,
		},
	];

	it("reads comma and pipe lists, quoted or bare", () => {
		const got = parseDeclaredColumns(files);
		expect(got.find((d) => d.table === "agents")?.values).toEqual(["inactive", "active", "error"]);
		expect(got.find((d) => d.table === "pipeline_runs")?.values).toEqual(["running", "completed", "failed"]);
		expect(got.find((d) => d.table === "t")?.values).toEqual(["registered", "online", "offline"]);
	});

	it("does not turn a prose comment into a domain", () => {
		// `-- JSON array` is two words, not two values. Treating prose as a declaration is how a
		// guard acquires nonsense entries and then an allowlist to silence them.
		expect(parseDeclaredColumns(files).some((d) => d.column === "capabilities")).toBe(false);
	});

	it("reads the column DEFAULT", () => {
		expect(parseDefault(files, "agents", "status")).toBe("inactive");
	});
});

describe("writableValues follows the three shapes a status write takes here", () => {
	const declared = ["inactive", "active", "error"];

	it("1. a literal in the write statement", () => {
		const s = [src("a.ts", "await env.DB.prepare(`INSERT INTO agents (id, status) VALUES (?1, 'inactive')`).bind(id).run();")];
		expect([...writableValues(s, "agents", "status", declared, null)]).toEqual(["inactive"]);
	});

	it("2. the column DEFAULT, when an INSERT does not name the column", () => {
		const s = [src("a.ts", "await env.DB.prepare(`INSERT INTO agents (id, name) VALUES (?1, ?2)`).bind(id, n).run();")];
		expect([...writableValues(s, "agents", "status", declared, "inactive")]).toEqual(["inactive"]);
	});

	it("3. a value bound from a parameter, with the literal at the caller", () => {
		// `updateRuntimeStatus` in miniature: the literal is nowhere near the SQL, which is why a
		// statement-local scan reports a column as unwritable when it is written twice a minute.
		const s = [
			src(
				"store.ts",
				`export async function setStatus(env: Env, id: string, status: string) {
					await env.DB.prepare("UPDATE agents SET status = ?1 WHERE id = ?2").bind(status, id).run();
				}`,
			),
			src("caller.ts", `await setStatus(env, id, "active");`),
		];
		expect([...writableValues(s, "agents", "status", declared, null)]).toContain("active");
	});

	it("finds the enclosing function when it is an arrow const, not only `function`", () => {
		// Five columns reported clean for exactly this reason before the arrow form was handled.
		const code = "export const setStatus = async (env: Env) => {\n  x;\n};";
		expect(enclosingFunction(stripComments(code), code.indexOf("x;"))).toBe("setStatus");
	});

	it("does not mistake the declaration for a call site", () => {
		expect(callArguments("function f(env: Env, status: string) {}\nf(env, 'active');", "f")).toEqual(["env, 'active'"]);
	});

	it("reports nothing writable when nothing writes it — the case that must not be silent", () => {
		const s = [src("a.ts", "await env.DB.prepare(`SELECT status FROM agents`).all();")];
		expect([...writableValues(s, "agents", "status", declared, null)]).toEqual([]);
	});
});

describe("findDecisions attributes a comparison to the right table", () => {
	const statusTables = ["agents", "agent_instances", "coding_sessions"];

	it("catches the #590 gate", () => {
		const s = [src("run.ts", `const a = await db.prepare("SELECT status FROM agents WHERE id = ?1").first();\nif (a.visibility === "published" && a.status === "active") ok();`)];
		expect(findDecisions(s, "agents", "status", "active", statusTables)).toHaveLength(1);
	});

	it("catches a SQL routing gate on an unwritable value (#587's shape)", () => {
		const s = [src("c.ts", `db.prepare("SELECT endpoint_url FROM instance_runtime_nodes WHERE instance_id = ?1 AND status != 'offline'")`)];
		expect(findDecisions(s, "instance_runtime_nodes", "status", "offline", statusTables)).toHaveLength(1);
	});

	it("does NOT attribute a subquery's own table to the outer one", () => {
		// `lib/admin.ts`, `routes/dashboard.ts` and `routes/public.ts` all do this, and an
		// alias-only view of the statement reported every one of them as a decision about `agents`.
		const s = [src("d.ts", `db.prepare("SELECT a.id, (SELECT COUNT(*) FROM agent_instances WHERE agent_id = a.id AND status = 'active') AS n FROM agents a")`)];
		expect(findDecisions(s, "agents", "status", "active", statusTables)).toEqual([]);
	});

	it("does NOT attribute an aliased column to the wrong table", () => {
		const s = [src("d.ts", `db.prepare("SELECT a.id FROM agents a JOIN agent_instances i ON i.agent_id = a.id WHERE i.status = 'active'")`)];
		expect(findDecisions(s, "agents", "status", "active", statusTables)).toEqual([]);
	});

	it("stays quiet in a TypeScript file that queries several status tables", () => {
		// A row's table is not knowable from `x.status`. Reporting anyway is how a guard earns a
		// 90%-false-positive allowlist and then gets ignored — see the header of `findDecisions`.
		const s = [src("m.ts", `db.prepare("SELECT * FROM agents"); db.prepare("SELECT * FROM coding_sessions");\nif (s.status === "active") go();`)];
		expect(findDecisions(s, "agents", "status", "active", statusTables)).toEqual([]);
	});

	it("ignores a file that never touches the table", () => {
		expect(findDecisions([src("x.ts", `if (job.status === "active") go();`)], "agents", "status", "active", statusTables)).toEqual([]);
	});
});

describe("SQL statement helpers", () => {
	it("aliasesFor and tablesIn see aliased and un-aliased tables", () => {
		const stmt = "FROM agents a LEFT JOIN users u ON u.id = a.owner_id, (SELECT 1 FROM agent_instances)";
		expect(aliasesFor(stmt, "agents")).toEqual(["a"]);
		expect(tablesIn(stmt).sort()).toEqual(["agent_instances", "agents", "users"]);
	});

	it("queriesTable respects word boundaries", () => {
		expect(queriesTable("FROM agent_instances", "agents")).toBe(false);
		expect(queriesTable("FROM agents a", "agents")).toBe(true);
	});

	it("sqlStatements splits on the prepare() chain", () => {
		expect(sqlStatements("a.prepare(`X`).run(); b.prepare(`Y`).run();")).toHaveLength(2);
	});

	it("writeStatements ignores a read of the same table", () => {
		expect(writeStatements("db.prepare(`SELECT status FROM agents`)", "agents", "status")).toEqual([]);
		expect(writeStatements("db.prepare(`UPDATE agents SET status = ?1`)", "agents", "status")).toHaveLength(1);
	});
});
