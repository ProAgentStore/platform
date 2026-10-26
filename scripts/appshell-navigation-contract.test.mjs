/**
 * #1291 — the AppShell navigation contract keeps its two forms (human + machine-readable) in step, and its examples are real code.
 *
 * Structure-aware, not a text match (docs/testing-standards.md): the markdown is parsed into headings, checklist items and code
 * fences and compared with the JSON; the examples are compiled by the TypeScript compiler. Nothing here asserts a sentence.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const contract = JSON.parse(read("docs/appshell-navigation-contract.json"));
const md = read("docs/appshell-navigation-contract.md");

/** Headings by level, and the lines under each (fences excluded), from the markdown. Pure. */
function parse(text) {
	const headings = [];
	const fences = [];
	const checklist = [];
	let fence = null;
	for (const line of text.split("\n")) {
		const f = /^```(\w*)\s*$/.exec(line);
		if (f) {
			if (fence) {
				fences.push(fence);
				fence = null;
			} else fence = { lang: f[1], body: [] };
			continue;
		}
		if (fence) {
			fence.body.push(line);
			continue;
		}
		const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (h) headings.push({ level: h[1].length, text: h[2] });
		const c = /^- \[ \] (.+)$/.exec(line);
		if (c) checklist.push(c[1]);
	}
	return { headings, fences: fences.map((x) => ({ lang: x.lang, body: x.body.join("\n") })), checklist };
}
const doc = parse(md);

describe("the machine-readable contract", () => {
	it("has exactly the seven rules, numbered 1..7, each with a rule and a reason", () => {
		expect(contract.rules.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		for (const r of contract.rules) {
			expect(r.title.trim().length, `rule ${r.id} title`).toBeGreaterThan(10);
			expect(r.rule.trim().length, `rule ${r.id} rule`).toBeGreaterThan(20);
			expect(r.why.trim().length, `rule ${r.id} why`).toBeGreaterThan(20);
		}
		expect(new Set(contract.rules.map((r) => r.title)).size).toBe(7);
	});

	it("names the concept AppShell and documents ProShell as the SDK export it stands for today", () => {
		expect(contract.component.concept).toBe("AppShell");
		expect(contract.component.sdkExport).toBe("ProShell");
		expect(contract.component.sdkImport).toBe("@proappstore/sdk/shell");
		expect(contract.component.note).toContain("ProShell");
	});

	it("lists what is outside the rule, and says which source it was verified against", () => {
		for (const outside of ["tabs", "breadcrumbs", "admin", "footer"]) expect(contract.outsideTheRule.join(" ")).toContain(outside);
		expect(contract.verifiedAgainst.files.length).toBeGreaterThan(0);
		expect(contract.verifiedAgainst.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("the human-readable contract matches it", () => {
	it("has one numbered heading per rule, with the JSON's title, in order", () => {
		const rules = doc.headings.filter((h) => h.level === 3 && /^\d+\.\s/.test(h.text));
		expect(rules.map((h) => h.text)).toEqual(contract.rules.map((r) => `${r.id}. ${r.title}`));
	});

	it("has the sections the issue asks for, as headings", () => {
		const names = doc.headings.map((h) => h.text);
		for (const section of ["Terminology", "The seven rules", "Starter checklist", "Executable check", "React Router example", "Role-aware and scoped-link example", "Open items"]) {
			expect(names, `missing section: ${section}`).toContain(section);
		}
	});

	it("carries the same starter checklist, item for item", () => {
		expect(doc.checklist).toEqual(contract.checklist);
	});
});

describe("the examples are real code", () => {
	const examples = doc.fences.filter((f) => f.lang === "tsx");

	it("has the React Router example and the role-aware scoped-link example", () => {
		expect(examples.length).toBe(2);
		expect(examples[0].body).toContain("onNavigate");
		expect(examples[1].body).toContain("NavItem");
	});

	it.each([0, 1])("example %i parses as TSX with no syntax errors", (i) => {
		const out = ts.transpileModule(examples[i].body, {
			reportDiagnostics: true,
			compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
			fileName: `example-${i}.tsx`,
		});
		const messages = (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
		expect(messages).toEqual([]);
	});

	it("the scoped-link example keeps scope in the path, never in a query string", () => {
		const sf = ts.createSourceFile("e.tsx", examples[1].body, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
		const hrefs = [];
		const visit = (n) => {
			if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "href") hrefs.push(n.initializer.getText(sf));
			ts.forEachChild(n, visit);
		};
		visit(sf);
		expect(hrefs.length).toBeGreaterThan(2);
		for (const h of hrefs) expect(h, "a query-string href would never be marked current").not.toContain("?");
	});
});

describe("it is reachable and its links resolve", () => {
	it("is linked from AGENTS.md, and every relative link in the contract points at a file that exists", () => {
		expect(read("AGENTS.md")).toContain("docs/appshell-navigation-contract.md");
		const links = [...md.matchAll(/\]\((\.\.?\/[^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
		expect(links.length).toBeGreaterThan(2);
		for (const link of links) expect(existsSync(resolve(root, "docs", link)), `broken link: ${link}`).toBe(true);
	});
});
