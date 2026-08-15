import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aggregateUsage } from "./usage.js";
import { emptyUnmeteredSummary } from "./engine-metering.js";
import type { UsageResponse } from "./usage-shape.js";

const USAGE_ROUTE = fileURLToPath(new URL("../routes/usage.ts", import.meta.url));

/**
 * `UsageResponse` IS what `GET /v1/usage` returns (#608).
 *
 * The console imports that type instead of declaring a parallel one, which is the whole fix — so
 * the type being wrong is now a defect on TWO surfaces rather than one. What follows is the link
 * neither side can supply alone:
 *
 *  - the RUNTIME keys come from the real producers (`aggregateUsage`, `emptyUnmeteredSummary`)
 *    plus what the route names beside the spread, parsed out of the route's source;
 *  - the DECLARED keys come from a `const body: UsageResponse = …` below, so the compiler refuses
 *    the assignment if the type is missing a field or requires one nothing produces.
 *
 * Reading the route's text rather than calling the handler is deliberate and has precedent
 * (`store/console/src/lib/surfaces.test.ts`, `workers/mcp/src/instance-tools/account.test.ts`):
 * invoking it needs a whole D1, and what is being asserted is the SHAPE of the literal, which is
 * a fact about the source. If the route is restructured, fix this parse — do not replace it with
 * a hand-typed key list, which is the parallel declaration this issue removed.
 */
function routeResponseKeys(): { fromRoute: string[]; spreads: string[] } {
	const src = readFileSync(USAGE_ROUTE, "utf8");
	const literal = src.match(/return c\.json\(\{([^}]*)\}\)/);
	if (!literal) throw new Error(`no \`return c.json({...})\` literal in ${USAGE_ROUTE} — update this parse`);
	const entries = literal[1].split(",").map((e) => e.trim()).filter(Boolean);
	return {
		spreads: entries.filter((e) => e.startsWith("...")),
		fromRoute: entries.filter((e) => !e.startsWith("...")).map((e) => e.split(":")[0].trim()),
	};
}

describe("UsageResponse is the shape /v1/usage actually returns (#608)", () => {
	it("declares exactly the keys the route sends, and no others", () => {
		const { fromRoute, spreads } = routeResponseKeys();
		// Assert the link rather than assume it: if the route ever spreads something other than the
		// aggregator's output, the comparison below is measuring the wrong function while passing.
		expect(spreads).toEqual(["...summary"]);

		// Compile-time half. `range` and `unmetered` are named literally because the route names
		// them literally; everything else is produced, not typed out.
		const body: UsageResponse = { range: "30d", ...aggregateUsage([]), unmetered: emptyUnmeteredSummary(14) };

		// Runtime half: what the route would actually send, key for key.
		const sent = [...new Set([...fromRoute, ...Object.keys(aggregateUsage([])), "unmetered"])].sort();
		expect(Object.keys(body).sort()).toEqual(sent);
	});

	it("carries the two cache columns the page reads — the field #608 is about", () => {
		// The specific omission: `aggregateUsage` had summed these since #547 and
		// `UsageSummary["totals"]` did not declare them, so the console read real data through a
		// type of its own that marked them optional.
		const body: UsageResponse = { range: "all", ...aggregateUsage([]), unmetered: emptyUnmeteredSummary(14) };
		expect(Object.keys(body.totals)).toContain("cacheReadTokens");
		expect(Object.keys(body.totals)).toContain("cacheWriteTokens");
	});
});
