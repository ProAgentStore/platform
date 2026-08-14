import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
// The API worker is a SEPARATE deployable and this worker cannot import from it at
// runtime (workers/mcp/CLAUDE.md). A TEST can, and this is the one place where doing so
// is the point: the whole assertion is "the description agrees with the shape the API
// actually returns", and re-typing that shape here would be the failure the test exists
// to prevent. `tsconfig.json` excludes `src/**/*.test.ts`, so `pnpm --filter
// proagentstore-mcp typecheck` never sees this import; vitest resolves it from source.
import { payerCoverage } from "../../../api/src/lib/usage-coverage.js";
import { isCharged } from "../../../api/src/lib/usage-payer.js";
import { aggregateUsage } from "../../../api/src/lib/usage.js";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerAccountTools } from "./account.js";

// ── Why this file exists ─────────────────────────────────────────────────────
//
// `usage_summary` shipped a description that named `payerCoverage.unattributedBefore` as
// the whole coverage gap and never mentioned `unattributedSince` or `unmetered` (#565).
// The numbers were right; the sentence was wrong, and wrong in the direction that costs
// something — it framed the gap as a WINDOW problem, whose implied remedy is to narrow
// the range, when the field it omitted was 99% of the unattributed value and narrowing
// recovers none of it.
//
// A description is the only documentation an MCP caller ever reads: no model fetches
// `usage-coverage.ts`. So the interesting property is not "the prose is nice", it is
// "the prose covers the response" — and that is checkable, as long as the response's
// shape is DERIVED rather than copied. `docs-drift.mjs` check 6 is the cautionary tale
// (ADR 0002): a green tick over a hand-written list of three paths while the served site
// was 68 tools wrong. A hand-typed key list here would pass forever and catch nothing,
// because the next field added to `/v1/usage` is exactly the field nobody would think to
// add to the list.
//
// Hence: `aggregateUsage([])` supplies its own key set, `payerCoverage([])` supplies its
// own sub-keys, and the two keys the route adds outside the spread are parsed out of the
// route's `c.json({...})` literal. Every step asserts what it collected before asserting
// what the description says, so "found nothing" and "found nothing wrong" cannot print
// the same tick.

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE_ROUTE = resolve(HERE, "../../../api/src/routes/usage.ts");

type Shape = Record<string, z.ZodTypeAny>;

/** The registered description of one account tool, read back off a fake server. */
function descriptionOf(tool: string): string {
	const found = new Map<string, string>();
	const env: McpEnv = { API_BASE: "https://api.test" };
	registerAccountTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, as in contract.test.ts
		{ tool: (name: string, description: string, _s: Shape, _h: unknown) => found.set(name, description) } as any,
		{
			env,
			tokenFor: (t?: string) => t || "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read"] }),
			groups: new Set<string>(),
		},
	);
	const desc = found.get(tool);
	if (!desc) throw new Error(`registerAccountTools did not register "${tool}" (registered: ${[...found.keys()].join(", ")})`);
	return desc;
}

/**
 * Every identifier the description commits to, taken from its backticked spans and split
 * on `.` so `` `totals.chargedCostMicros` `` documents both halves.
 *
 * Backticks rather than a bare substring search, deliberately: `attributed` is a
 * substring of both `unattributedBefore` and `unattributedSince`, so a substring test
 * would report the field as documented in a description that never mentions it.
 */
function documentedIdentifiers(description: string): Set<string> {
	const out = new Set<string>();
	for (const [, span] of description.matchAll(/`([^`]+)`/g)) {
		for (const part of span.split(".")) {
			if (/^[A-Za-z_$][\w$]*$/.test(part)) out.add(part);
		}
	}
	return out;
}

/**
 * The keys `GET /v1/usage` can return, read out of the code that produces them.
 *
 * The route's last line is `return c.json({ range, ...summary, unmetered })`, so the
 * response is the aggregator's own keys plus whatever the route names beside the spread.
 * Both halves are collected from source; neither is typed out here.
 */
function usageResponseKeys(): { keys: string[]; fromSummary: string[]; fromRoute: string[] } {
	// The aggregator, called for real with no rows — every key in its return literal is
	// unconditional, so an empty ledger still yields the full shape.
	const fromSummary = Object.keys(aggregateUsage([]));

	const src = readFileSync(USAGE_ROUTE, "utf8");
	const literal = src.match(/return c\.json\(\{([^}]*)\}\)/);
	if (!literal) {
		throw new Error(
			`Could not find \`return c.json({...})\` in ${USAGE_ROUTE}. This test reads the response ` +
				"shape out of that literal; if the route was restructured, update the parse — do not " +
				"replace it with a hand-written key list, which is the defect #565 is about.",
		);
	}
	const entries = literal[1]
		.split(",")
		.map((e) => e.trim())
		.filter(Boolean);
	const spreads = entries.filter((e) => e.startsWith("..."));
	const fromRoute = entries.filter((e) => !e.startsWith("...")).map((e) => e.split(":")[0].trim());

	// The spread is the aggregator's output. Assert the link rather than assume it: if the
	// route ever spreads something else, `fromSummary` is measuring the wrong function and
	// this test would keep passing while documenting a shape nobody returns.
	expect(spreads, `expected exactly one spread in the route's c.json literal, got ${JSON.stringify(spreads)}`).toEqual(["...summary"]);
	expect(src, "the spread `...summary` must be the result of aggregateUsage()").toMatch(/const summary = aggregateUsage\(/);

	return { keys: [...new Set([...fromRoute, ...fromSummary])], fromSummary, fromRoute };
}

describe("usage_summary description covers the /v1/usage response", () => {
	// ── The denominator ──────────────────────────────────────────────────────
	// Asserted before anything is compared against the description. A parse that
	// collected two keys and found both documented is indistinguishable from a passing
	// test, and that is precisely how a coverage check goes quietly blind.
	it("derives a plausible key set from the API worker rather than from a list", () => {
		const { keys, fromSummary, fromRoute } = usageResponseKeys();
		expect(fromSummary.length, `aggregateUsage([]) returned ${fromSummary.length} keys (${fromSummary.join(", ")}); expected at least the 8 it has returned since #544`).toBeGreaterThanOrEqual(8);
		expect(fromRoute.length, `the route's c.json literal named ${fromRoute.length} keys outside the spread (${fromRoute.join(", ")}); expected at least 2 (range, unmetered)`).toBeGreaterThanOrEqual(2);
		expect(keys.length, `derived ${keys.length} top-level /v1/usage keys (${keys.join(", ")}); expected at least 10`).toBeGreaterThanOrEqual(10);
	});

	it("names every top-level key the response can contain", () => {
		const { keys } = usageResponseKeys();
		const documented = documentedIdentifiers(descriptionOf("usage_summary"));
		const missing = keys.filter((k) => !documented.has(k));
		expect(missing, `undocumented /v1/usage keys (of ${keys.length} derived): ${missing.join(", ")}`).toEqual([]);
		// Asserted after, not before: an empty `documented` already fails above with the
		// useful message. This one says how many identifiers the check had to work with.
		expect(documented.size, `the description names only ${documented.size} backticked identifiers, against ${keys.length} derived response keys`).toBeGreaterThanOrEqual(keys.length);
	});

	it("names every payerCoverage slice, so the two gaps cannot be collapsed into one", () => {
		// The sub-keys come from the same function the route calls — including
		// `firstAttributedAt`, which is the boundary the two unattributed slices are
		// defined around and therefore not optional prose.
		const sub = Object.keys(payerCoverage([]));
		expect(sub.length, `payerCoverage([]) returned ${sub.length} keys (${sub.join(", ")}); expected at least 4`).toBeGreaterThanOrEqual(4);
		const documented = documentedIdentifiers(descriptionOf("usage_summary"));
		const missing = sub.filter((k) => !documented.has(k));
		expect(missing, `undocumented payerCoverage fields (of ${sub.length}): ${missing.join(", ")}`).toEqual([]);
	});

	it("does not equate `attributed` with the charged figure, because the code does not", () => {
		// The correction this test exists for. Both #565's suggested wording and the first
		// draft of the fix said "`attributed` is what `chargedCostMicros` counts" — which is
		// the one thing `usage-coverage.ts:118-126` says it is not: `attributed` gates on
		// `hasPayer`, the charged figure on `isCharged`, and it calls that difference "the
		// distinction the whole module turns on".
		//
		// So DERIVE the difference instead of asserting the prose. A `subscription` row is
		// counted as attributed and is not money; if that ever stops being true, these two
		// assertions go red and someone re-reads the sentence, rather than the sentence
		// silently becoming wrong again.
		const row = { payer: "subscription", cost_micros: 1000, created_at: "2026-08-01 00:00:00" };
		expect(payerCoverage([row]).attributed.calls, "a subscription row must count as attributed — if it does not, `attributed` and the charged figure no longer differ and the description's wording needs revisiting").toBe(1);
		expect(isCharged(row.payer), "a subscription row must not count as charged — same reason, from the other side").toBe(false);

		// Therefore the description has to name the row where the two diverge. Naming it is
		// what stops a caller reading `attributed` as the charged total and concluding that
		// a subscription-heavy account is being billed for its plan usage.
		const documented = documentedIdentifiers(descriptionOf("usage_summary"));
		expect(documented.has("subscription"), "the description must name `subscription` — the payer that is attributed and charged to nobody, i.e. the reason `attributed` is a superset of `chargedCostMicros` rather than equal to it").toBe(true);
	});

	it("says that narrowing the range does not recover unattributedSince, and names #551", () => {
		const desc = descriptionOf("usage_summary");
		// Scoped to the clause that introduces the field: the claim only helps a reader
		// if it sits where `unattributedSince` is being explained, not anywhere in 1.4KB
		// of prose. The clause runs to the sentence that ends it.
		const start = desc.indexOf("`unattributedSince`");
		expect(start, "the description never mentions `unattributedSince`").toBeGreaterThan(-1);
		const clause = desc.slice(start, desc.indexOf(". ", start) + 1 || undefined);
		expect(clause, "the `unattributedSince` clause must say narrowing the range recovers none of it — the old text implied the opposite by naming the gap as a window problem").toMatch(/narrow\w* the range recovers none/i);
		expect(clause, "and must name #551, the machine-login coding engine that causes it, not hide the cause behind the field name").toContain("#551");
	});
});
