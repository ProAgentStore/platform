/**
 * Unit tests for the guard scanner (#306).
 *
 * These matter more than they look. `security-invariants.test.ts` reports "no offenders",
 * and the ONLY thing standing between that green tick and a scanner that quietly matches
 * nothing is this file. A lexer bug does not produce a false alarm someone investigates —
 * it produces silence, which is exactly what a passing guard looks like.
 */
import { describe, expect, it } from "vitest";
import { findCalls, findIdentifier, findTableWrites, matchLines, readsAsMutating, stripCommentsAndLiterals } from "./source-guard.js";

const strip = stripCommentsAndLiterals;

describe("stripCommentsAndLiterals", () => {
	it("blanks line and block comments", () => {
		expect(strip("a; // fetch(x)\nb;").includes("fetch")).toBe(false);
		expect(strip("a; /* fetch(x)\n more fetch( */ b;").includes("fetch")).toBe(false);
	});

	it("preserves line numbers so an offender's line is still findable", () => {
		// A multi-line block comment collapsing to one line would make every reported line
		// number after it wrong, which is how a guard stops being actionable.
		const src = "one;\n/* two\n three\n */\nfive;";
		expect(strip(src).split("\n")).toHaveLength(5);
		expect(strip(src).split("\n")[4]).toBe("five;");
	});

	it("blanks string literals but not the code around them", () => {
		const out = strip(`const u = "https://x/fetch(1)"; go();`);
		expect(out).not.toContain("fetch(");
		expect(out).toContain("go()");
	});

	it("keeps template interpolations as live code", () => {
		// `${await fetch(url)}` is a call. Blanking the whole template hides it.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder IS the fixture
		const out = strip("const s = `a${fetch(url)}b`;");
		expect(out).toContain("fetch(url)");
		expect(out).not.toContain("a$"); // the literal text around it is gone
	});

	it("does not treat a URL inside a string as a line comment", () => {
		// The bug this prevents: `"https://x"` contains `//`, and a naive stripper eats the
		// rest of the line — including any real call after it.
		const out = strip(`f("https://example.com"); fetch(u);`);
		expect(out).toContain("fetch(u)");
	});

	it("does not treat a slash inside a regex literal as a line comment", () => {
		// `lib/import-graph.ts` and `lib/ssrf.ts` both contain regexes with escaped slashes.
		const out = strip(`const RE = /https:\\/\\//; fetch(u);`);
		expect(out).toContain("fetch(u)");
	});

	it("blanks the contents of a regex literal", () => {
		expect(strip("const RE = /fetch\\(/;")).not.toContain("fetch");
	});

	it("treats a slash after an identifier as division, not a regex", () => {
		// `a / b; // c` — if the first `/` opened a "regex", everything to the next `/` would
		// be swallowed and the real comment would survive instead.
		const out = strip("const r = total / count; keep(r);");
		expect(out).toContain("total");
		expect(out).toContain("keep(r)");
	});

	it("survives an unterminated block comment without eating the file twice", () => {
		expect(strip("a;\n/* never closed")).toContain("a;");
	});
});

describe("findCalls", () => {
	it("finds a bare call", () => {
		expect(findCalls(strip("await fetch(url);"), "fetch")).toHaveLength(1);
	});

	it("ignores a method call on an object", () => {
		// `stub.fetch(...)` is every Durable Object request in this Worker. A guard that
		// reported those would be turned off the same day.
		expect(findCalls(strip("await stub.fetch(req);"), "fetch")).toEqual([]);
	});

	it("ignores a longer identifier that ends with the name", () => {
		expect(findCalls(strip("await safeFetch(url);"), "fetch")).toEqual([]);
		expect(findCalls(strip("await authedFetch(url);"), "fetch")).toEqual([]);
	});

	it("reports the 1-based line and the source line", () => {
		const [hit] = findCalls(strip("a;\nb;\n  fetch(u);"), "fetch");
		expect(hit.line).toBe(3);
		expect(hit.excerpt).toBe("fetch(u);");
	});
});

describe("findIdentifier", () => {
	it("matches a property read as well as a bare name", () => {
		expect(findIdentifier(strip("if (t.destructiveHint) {}"), "destructiveHint")).toHaveLength(1);
	});
	it("does not match a longer word containing it", () => {
		expect(findIdentifier(strip("const notDestructiveHintish = 1;"), "destructiveHint")).toEqual([]);
	});
});

describe("findTableWrites", () => {
	it("finds every write verb", () => {
		for (const sql of [
			`db.prepare("INSERT INTO user_api_keys (a) VALUES (1)")`,
			`db.prepare("INSERT OR REPLACE INTO user_api_keys (a) VALUES (1)")`,
			`db.prepare("REPLACE INTO user_api_keys (a) VALUES (1)")`,
			`db.prepare("UPDATE user_api_keys SET a = 1")`,
			`db.prepare("DELETE FROM user_api_keys WHERE a = 1")`,
		]) {
			// The SQL lives in a string literal, so these run on the RAW source by design —
			// the table guard scans code, where the statement is built, not prose.
			expect(findTableWrites(sql, "user_api_keys"), sql).toHaveLength(1);
		}
	});

	it("does not fire on a read", () => {
		expect(findTableWrites(`SELECT x FROM user_api_keys`, "user_api_keys")).toEqual([]);
	});

	it('kind:"store" excludes DELETE', () => {
		// Revoking a key is a write, but it stores nothing, so it needs no key material.
		expect(findTableWrites(`DELETE FROM user_api_keys WHERE a = 1`, "user_api_keys", "store")).toEqual([]);
		expect(findTableWrites(`UPDATE user_api_keys SET a = 1`, "user_api_keys", "store")).toHaveLength(1);
	});

	it("does not fire on a table whose name merely starts the same", () => {
		expect(findTableWrites(`INSERT INTO user_api_keys_audit (a) VALUES (1)`, "user_api_keys")).toEqual([]);
	});
});

describe("readsAsMutating", () => {
	it("reads the verb through a connector prefix", () => {
		for (const n of ["github_create_issue", "sheets_append", "mcp_call_tool", "tmux_kill_session", "browser_navigate", "delegate_goal", "terminal_run_command"]) {
			expect(readsAsMutating(n), n).toBe(true);
		}
	});

	it("leaves genuinely read-only tools alone", () => {
		for (const n of ["github_list_issues", "sheets_read", "mcp_list_tools", "tmux_capture_pane", "repo_tree", "web_search", "subordinate_status", "browser_snapshot"]) {
			expect(readsAsMutating(n), n).toBe(false);
		}
	});

	it("matches on the verb position, not as a substring", () => {
		// `list_subordinates` contains "sub"; `undelete_status` contains "delete". A substring
		// test makes ordinary tools unreachable, which buys no safety and gets the guard muted.
		expect(readsAsMutating("list_subordinates")).toBe(false);
		expect(readsAsMutating("github_reset_summary")).toBe(true); // verb IS in position 2
	});
});

describe("matchLines", () => {
	it("returns one hit per occurrence, with its own line", () => {
		expect(matchLines("x\nfoo\nbar\nfoo", /foo/).map((h) => h.line)).toEqual([2, 4]);
	});
});
