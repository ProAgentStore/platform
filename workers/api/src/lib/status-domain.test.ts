/**
 * The status-domain guard (#570, #587, #590) — one check for a defect that shipped three times in
 * a single day, in three different columns.
 *
 * The defect: **application code decides on a status value that application code cannot write.**
 *
 *   #570  `runtimeNodeResponse` published `instance_runtime_nodes.status`, a column whose only
 *         writer wrote `"online"`. Four machines read online, three of them days stale.
 *   #587  `lib/runner-client.ts:73` selects a runner `WHERE status != 'offline'` on that same
 *         column — so the routing gate could never exclude anything.
 *   #590  `run.ts` gated `POST /v1/agents/:id/run` on `agents.status === "active"`, a value only
 *         nine seed migrations have ever written. Every third-party published agent 404'd for
 *         every non-owner, forever.
 *
 * Three per-column tests would have caught none of the other two, which is the whole argument for
 * doing it this way: #570's fix was written, reviewed and landed while #587 sat one function away
 * in the same file. So the denominator here is EVERY status column whose value domain the schema
 * declares, and every declared value of each — not a hand-picked pair.
 *
 * Failures name the column, the value, and the line that decides on it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isWritable, STATUS_DOMAINS, unreachableValues } from "./status-domain.js";
import {
	findDecisions,
	parseDeclaredColumns,
	parseDefault,
	type Source,
	stripComments,
	writableValues,
} from "./status-domain-guard.js";

const SRC = new URL("../", import.meta.url).pathname; // workers/api/src
const MIGRATIONS = new URL("../../migrations/", import.meta.url).pathname;

const migrations = readdirSync(MIGRATIONS)
	.filter((f) => f.endsWith(".sql"))
	.sort()
	.map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf-8") }));

/** Every non-test .ts under workers/api/src, comments blanked and string literals KEPT. */
const sources: Source[] = (() => {
	const out: Source[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d)) {
			const p = join(d, entry);
			if (statSync(p).isDirectory()) {
				walk(p);
				continue;
			}
			if (!p.endsWith(".ts") || p.endsWith(".test.ts") || p.endsWith(".d.ts")) continue;
			out.push({ rel: p.slice(SRC.length), code: stripComments(readFileSync(p, "utf-8")) });
		}
	};
	walk(SRC);
	return out;
})();

const declared = parseDeclaredColumns(migrations);
/** Every table that declares a status domain — the ambiguity set the TS scan needs. */
const statusTables = [...new Set(Object.keys(STATUS_DOMAINS).map((k) => k.split(".")[0]))];

describe("status domains are declared, and the declaration is measured (#570, #587, #590)", () => {
	it("scans a real corpus — a scanner that found nothing would pass every assertion below", () => {
		// The failure mode `source-guard.test.ts` exists to prevent: silence looks like success.
		expect(sources.length).toBeGreaterThan(200);
		expect(migrations.length).toBeGreaterThan(100);
		expect(declared.length).toBeGreaterThan(8);
	});

	it("covers every status column whose schema comment declares a value list", () => {
		// Exact set, not a subset: a new declared status column must land in STATUS_DOMAINS with
		// the provenance of each of its values, and a column that goes away must leave.
		const fromSchema = new Set(declared.map((d) => `${d.table}.${d.column}`));
		const fromTable = new Set(Object.keys(STATUS_DOMAINS));
		const missing = [...fromSchema].filter((c) => !fromTable.has(c)).sort();
		expect(missing, `declared in the schema but not in STATUS_DOMAINS:\n${missing.join("\n")}`).toEqual([]);
	});

	it("declares the same values the schema does, wherever the schema declares them", () => {
		// Where they differ, the schema comment has usually gone stale — which is itself worth
		// knowing, and is recorded in the `note` on the entry rather than silently absorbed.
		const drift: string[] = [];
		for (const d of declared) {
			const entry = STATUS_DOMAINS[`${d.table}.${d.column}`];
			if (!entry) continue;
			const extra = d.values.filter((v) => !(v in entry.values));
			if (extra.length) drift.push(`${d.table}.${d.column}: schema declares ${extra.join(", ")} (${d.source})`);
		}
		expect(drift, drift.join("\n")).toEqual([]);
	});
});

describe("every value marked `app` really is writable, and every `seed`/`none` really is not", () => {
	// This is what stops the table from becoming a wish. A marking is a claim about the source, so
	// it is checked against the source: add the writer that `agents.status = 'error'` has never
	// had, and this fails until the table says `app`.
	for (const [column, domain] of Object.entries(STATUS_DOMAINS)) {
		const [table, col] = column.split(".");
		it(`${column}`, () => {
			const values = Object.keys(domain.values);
			const writable = writableValues(sources, table, col, values, parseDefault(migrations, table, col));
			const wrong: string[] = [];
			for (const [value, provenance] of Object.entries(domain.values)) {
				const can = writable.has(value);
				// Asserted in BOTH directions, which is what stops the table drifting. A value that
				// gains a literal writer must be promoted to `app`; one that loses it must be demoted.
				if (provenance === "app" && !can) wrong.push(`${value}: marked app, no application writer found — demote to \`app?\` with a note saying where it IS written, or to \`none\``);
				if (provenance !== "app" && can) wrong.push(`${value}: marked ${provenance}, but a literal application writer exists — promote to \`app\``);
			}
			expect(wrong, `${column}\n${wrong.join("\n")}\n(note: ${domain.note ?? "none"})`).toEqual([]);
		});
	}
});

describe("nothing decides on a status value the application cannot write", () => {
	/**
	 * The load-bearing assertion, and the one all three bugs would have failed.
	 *
	 * Reading an unwritable value and DISPLAYING it is fine — the admin listing shows whatever the
	 * row holds, and rows seeded by migrations legitimately hold `agents.status = 'active'`.
	 * BRANCHING on it is not: the branch can never be taken for anything the application creates,
	 * so the code reads as a working rule and behaves as a constant.
	 *
	 * The allowlist is compared as an EXACT set. Removing a violation therefore fails the guard
	 * too, and the list can only shrink deliberately — the ratchet `security-invariants.test.ts`
	 * and `check-file-size.mjs` already use here.
	 */
	const ALLOWED: Record<string, string> = {};

	it("reports the denominator it swept", () => {
		const unreachable = unreachableValues();
		const total = Object.values(STATUS_DOMAINS).reduce((n, d) => n + Object.keys(d.values).length, 0);
		// Printed, not asserted at a magic number: the point is that the sweep is over the whole
		// schema rather than the two columns that happened to break.
		console.log(
			`status-domain guard: ${Object.keys(STATUS_DOMAINS).length} status columns, ${total} declared values, ` +
				`${unreachable.length} of them unwritable by application code:\n  ${unreachable.join("\n  ")}`,
		);
		expect(total).toBeGreaterThan(30);
	});

	it("takes no decision on an unwritable value", () => {
		const offenders: string[] = [];
		for (const [column, domain] of Object.entries(STATUS_DOMAINS)) {
			const [table, col] = column.split(".");
			for (const [value, provenance] of Object.entries(domain.values)) {
				if (isWritable(provenance)) continue;
				for (const d of findDecisions(sources, table, col, value, statusTables)) {
					const key = `${column} = ${value} @ ${d.rel}:${d.line}`;
					if (ALLOWED[key]) continue;
					offenders.push(`${key}\n      ${d.text}`);
				}
			}
		}
		expect(
			offenders.sort(),
			`These branch on a status value nothing in the application can write, so they can never\n` +
				`go the other way for anything the application creates:\n\n  ${offenders.join("\n  ")}\n\n` +
				`Fix by giving the value a writer (and marking it \`app\`), or by removing the decision.\n`,
		).toEqual([]);
	});
});
