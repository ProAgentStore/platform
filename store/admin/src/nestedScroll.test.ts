import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #1309 — a read-only <pre> in the admin portal must not carry its own vertical scroller. The browser spec
 * (`e2e/admin-nested-scroll.spec.ts`) measures the four pages that can be reached; the Errors page's
 * signature drawer is not reachable from the UI today (its opener is voided), so this source guard is what
 * keeps its context block from growing the cap back, and every other page with it.
 */
const PAGES = join(import.meta.dirname, "pages");

describe("admin <pre> blocks flow in the page (#1309)", () => {
	for (const file of readdirSync(PAGES).filter((f) => f.endsWith(".tsx"))) {
		it(`${file} caps no <pre> with a vertical scroller`, () => {
			const pres = readFileSync(join(PAGES, file), "utf8").match(/<pre\b[^>]*className="[^"]*"/g) ?? [];
			for (const pre of pres) expect(pre, pre).not.toMatch(/\bmax-h-|\boverflow-y-(auto|scroll)\b|\boverflow-(auto|scroll)\b/);
		});
	}
	it("the pages the issue named still render their blocks as <pre> (the guard is not vacuous)", () => {
		for (const f of ["Errors.tsx", "ErrorSignature.tsx", "TraceView.tsx", "Terminals.tsx", "SessionDetail.tsx"]) {
			expect(readFileSync(join(PAGES, f), "utf8")).toMatch(/<pre\b[^>]*whitespace-pre-wrap/);
		}
	});
});
