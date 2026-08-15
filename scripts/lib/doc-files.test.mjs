import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { docFiles, servedHtmlFiles } from "./doc-files.mjs";

/**
 * `docs/` was read by NO gate until #604 — `docFiles()` collected `platform-docs/` and
 * `servedHtmlFiles()` skips any directory called `docs` — so 27 findings across 9 of its 21
 * files sat behind a green `pnpm docs:drift`. These assertions are about the COLLECTOR,
 * because that was the whole bug: every check downstream was working correctly on a
 * population that silently excluded the directory.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const p = (...s) => resolve(ROOT, ...s);
const names = () => docFiles(p).map((f) => f.replace(`${ROOT}/`, ""));

describe("docFiles", () => {
	it("collects docs/, the directory that was in no input set", () => {
		const collected = names();
		const docs = collected.filter((f) => f.startsWith("docs/"));
		// A floor rather than an exact list: docs/ gains and loses files constantly, and a
		// hard-coded set would be a second thing to keep in step with the tree.
		expect(docs.length, "docs/ is not being collected — the #604 defect is back").toBeGreaterThanOrEqual(15);
		expect(collected).toContain("docs/mcp-instance-runtime.md");
	});

	it("recurses into docs/adr/, where the constraints live", () => {
		// The ADRs are the records whose violation looks locally correct, so a non-recursive
		// walk would leave exactly the documents least able to survive being wrong.
		expect(names().some((f) => f.startsWith("docs/adr/"))).toBe(true);
		expect(names()).toContain("docs/adr/0002-a-guard-states-what-it-measured.md");
	});

	it("still collects everything it collected before, so docs/ was an addition and not a swap", () => {
		const collected = names();
		for (const expected of [
			"platform-docs/mcp.md",
			"store/llms.txt",
			"store/llms-full.txt",
			"README.md",
			"AGENTS.md",
			"SECURITY.md",
			"workers/mcp/CLAUDE.md",
			"workers/mcp/AGENTS.md",
		]) {
			expect(collected, `${expected} left the swept set`).toContain(expected);
		}
	});

	it("returns no duplicates, so a file cannot be graded twice", () => {
		const collected = names();
		expect(collected.length).toBe(new Set(collected).size);
	});
});

describe("servedHtmlFiles", () => {
	it("reads the served marketing pages and still skips generated store/docs", () => {
		const html = servedHtmlFiles(p).map((f) => f.replace(`${ROOT}/`, ""));
		expect(html.length).toBeGreaterThanOrEqual(8);
		expect(html).toContain("store/about/index.html");
		// store/docs is BUILD OUTPUT of platform-docs (already swept) and is absent in a fresh
		// checkout, so sweeping it would fail for a reason having nothing to do with drift.
		expect(html.filter((f) => f.startsWith("store/docs/"))).toEqual([]);
	});
});
