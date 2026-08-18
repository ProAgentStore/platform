/**
 * The guard that stops the agent cascade drifting away from the schema again (#646).
 *
 * Three routes hand-wrote their own delete cascade and ended up with three different child lists,
 * none of which covered `agent_instances`, `subscriptions` or `agent_triggers` — every one of
 * which holds a `REFERENCES agents(id)` with no `ON DELETE` clause. The result was that a creator
 * could not delete an agent anyone had ever subscribed to, and that which route you called decided
 * whether the delete worked at all.
 *
 * A test that lists the tables by hand would be a fourth copy of the same list. This one asks the
 * SCHEMA instead: it applies every migration to real SQLite (`d1-sqlite.ts`), walks the foreign-key
 * graph outward from `agents` with `pragma_foreign_key_list`, and fails if the transitive closure
 * contains a table `lib/agent-cascade.ts` does not clear. Add a table with a foreign key onto
 * `agents` or `agent_instances` and this goes red until the cascade knows about it — which is the
 * property that could not be established by testing the three routes separately, because each one
 * passed its own test throughout.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AGENT_CASCADE_TABLES, agentDeleteStatements } from "./agent-cascade.js";
import { assertD1Preparable, migrationSchemaDb } from "./d1-sqlite.js";

interface ForeignKey {
	child: string;
	column: string;
	parent: string;
	onDelete: string;
}

/** Every foreign key in the migrated schema, read from SQLite rather than from the SQL text. */
function foreignKeys(db: DatabaseSync): ForeignKey[] {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		.all() as { name: string }[];
	const out: ForeignKey[] = [];
	for (const { name } of tables) {
		const fks = db.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(name) as {
			table: string;
			from: string;
			on_delete: string;
		}[];
		for (const fk of fks) out.push({ child: name, column: fk.from, parent: fk.table, onDelete: fk.on_delete });
	}
	return out;
}

/**
 * Every table that would block `DELETE FROM agents`, transitively.
 *
 * A key declaring `ON DELETE CASCADE` clears itself, so it cannot block — but its own children
 * still can, which is why the walk continues through it rather than stopping.
 */
function blockingClosure(fks: ForeignKey[], root: string): string[] {
	const seen = new Set<string>([root]);
	const blocking: string[] = [];
	const queue = [root];
	while (queue.length > 0) {
		const parent = queue.shift() as string;
		for (const fk of fks.filter((f) => f.parent === parent)) {
			if (fk.onDelete !== "CASCADE" && !blocking.includes(fk.child)) blocking.push(fk.child);
			if (!seen.has(fk.child)) {
				seen.add(fk.child);
				queue.push(fk.child);
			}
		}
	}
	return blocking;
}

describe("#646 — the agent cascade is derived from the schema, not hand-maintained", () => {
	it("clears every table that could block DELETE FROM agents", () => {
		const db = migrationSchemaDb();
		try {
			const fks = foreignKeys(db);
			const blocking = blockingClosure(fks, "agents");

			// ADR 0002 — the denominator. A guard over an empty set passes for the wrong reason, and
			// this walk crosses two levels (agents → agent_instances → the coding/trigger subtree),
			// so a number well above the six direct children is the evidence it really recursed.
			expect(blocking.length).toBeGreaterThanOrEqual(18);
			expect(blocking).toContain("agent_instances"); // the one whose absence made #646 user-visible
			expect(blocking).toContain("agent_versions"); // the one only batch.ts cleared
			expect(blocking).toContain("coding_timeline"); // reached only via agent_instances

			const cleared = new Set(AGENT_CASCADE_TABLES);
			const missed = blocking.filter((t) => !cleared.has(t));
			expect(missed, `not cleared by lib/agent-cascade.ts: ${missed.join(", ")}`).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("names no table the schema does not have", () => {
		// The other direction: a table renamed or dropped by a later migration would leave a dead
		// entry in the cascade, and every DELETE against it would throw at runtime.
		const db = migrationSchemaDb();
		try {
			const names = new Set(
				(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
					(r) => r.name,
				),
			);
			const unknown = AGENT_CASCADE_TABLES.filter((t) => !names.has(t));
			expect(unknown, `named by lib/agent-cascade.ts but absent from the schema: ${unknown.join(", ")}`).toEqual(
				[],
			);
		} finally {
			db.close();
		}
	});

	it("issues SQL D1 can actually prepare, for every statement it emits", () => {
		// The table names are interpolated into the statements, so a typo is invisible to the
		// compiler and would only surface as a runtime error inside a transaction. Preparing each
		// one against the migrated schema is what turns that into a test failure.
		const db = migrationSchemaDb();
		try {
			const prepared: string[] = [];
			const fake = {
				prepare(sql: string) {
					prepared.push(sql);
					return { bind: () => ({}) };
				},
			} as unknown as D1Database;

			agentDeleteStatements(fake, "a1", { cascadeSubscribers: true });
			expect(prepared.length).toBe(AGENT_CASCADE_TABLES.length + 1); // + the `agents` row itself
			for (const sql of prepared) assertD1Preparable(sql, db);

			// Ordering is load-bearing: a child must be cleared before its parent, or the batch
			// fails on the foreign key the cascade exists to satisfy.
			const at = (t: string) => prepared.findIndex((s) => s.startsWith(`DELETE FROM ${t} `));
			expect(at("agent_trigger_events")).toBeLessThan(at("agent_triggers"));
			expect(at("coding_timeline")).toBeLessThan(at("coding_sessions"));
			expect(at("coding_sessions")).toBeLessThan(at("coding_repos"));
			expect(at("agent_triggers")).toBeLessThan(at("agent_instances"));
			expect(at("agent_instances")).toBeLessThan(prepared.length - 1);
		} finally {
			db.close();
		}
	});

	it("omits the instance subtree when there is nothing subscribed to clear", () => {
		const prepared: string[] = [];
		const fake = {
			prepare(sql: string) {
				prepared.push(sql);
				return { bind: () => ({}) };
			},
		} as unknown as D1Database;
		agentDeleteStatements(fake, "a1", { cascadeSubscribers: false });
		// The six agent-keyed tables plus `agents`. A clean agent's delete stays the size it was.
		expect(prepared).toHaveLength(7);
		expect(prepared.some((s) => s.includes("instance_id IN"))).toBe(false);
		expect(prepared.some((s) => s.startsWith("DELETE FROM agent_versions "))).toBe(true);
	});
});
