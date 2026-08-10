/**
 * The DO-side scanner (#438), tested twice over: once on hand-written sources where the answer
 * is obvious, and once against the REAL `agent-do.ts` dispatch table — because a scanner that
 * only ever runs on fixtures is a scanner nobody knows has stopped matching the code.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { armFor, doQueryParams, findHandlerSpan, lex, parseDoRouteTable, queryParamsIn } from "./do-seam.js";

const SRC = new URL("../", import.meta.url).pathname; // workers/api/src
const read = (rel: string) => lex(rel, readFileSync(`${SRC}${rel}`, "utf-8"));

const AGENT_DO = read("agent-do.ts");
const DO_SOURCES = [AGENT_DO, read("agent-do-storage-routes.ts"), read("agent-do-knowledge.ts")];

describe("parsing a dispatch table", () => {
	const fixture = lex(
		"fixture.ts",
		[
			'if (path === "/messages" && request.method === "GET")',
			"\treturn this.handleGetMessages(url);",
			'if (path.match(/^\\/files\\/[^/]+$/) && request.method === "DELETE")',
			"\treturn this.withEngine((e) => storageRoutes.deleteFile(e, path));",
			'// if (path === "/ghost" && request.method === "GET") return this.handleGhost(url);',
			'if (path.startsWith("/memory/") && request.method === "DELETE") {',
			"\treturn this.handleDeleteMemory(path);",
			"}",
		].join("\n"),
	);
	const arms = parseDoRouteTable(fixture);

	it("reads each arm's method, handler and path test", () => {
		expect(arms.map((a) => [a.method, a.handler])).toEqual([
			["GET", "this.handleGetMessages"],
			["DELETE", "storageRoutes.deleteFile"],
			["DELETE", "this.handleDeleteMemory"],
		]);
	});

	it("ignores an arm that is only written about in a comment", () => {
		expect(arms.some((a) => a.handler === "this.handleGhost")).toBe(false);
	});

	it("matches paths the way the DO does — equality, prefix and regex, method included", () => {
		expect(armFor(arms, "GET", "/messages")?.handler).toBe("this.handleGetMessages");
		expect(armFor(arms, "DELETE", "/messages")).toBeNull();
		// `[^/]+` inside the regex literal is where a naive "scan to the next slash" gives up.
		expect(armFor(arms, "DELETE", "/files/abc")?.handler).toBe("storageRoutes.deleteFile");
		expect(armFor(arms, "DELETE", "/files/abc/def")).toBeNull();
		expect(armFor(arms, "DELETE", "/memory/name")?.handler).toBe("this.handleDeleteMemory");
	});

	it("refuses to guess at an arm shape it cannot read", () => {
		const odd = lex("odd.ts", 'if (path.endsWith("/x") && request.method === "GET")\n\treturn this.handleX(url);');
		expect(() => parseDoRouteTable(odd)).toThrow(/unreadable path condition/);
	});
});

describe("reading the parameters a handler takes off the URL", () => {
	const fixture = lex(
		"fixture.ts",
		[
			"export async function listThings(engine: E, url: URL): Promise<Response> {",
			'\tconst limit = Number(url.searchParams.get("limit")) || 50;',
			'\t// Historically this also read url.searchParams.get("cursor") — it does not now.',
			'\tconst who = url.searchParams.get("user_id") || undefined;',
			'\tconst again = url.searchParams.get("limit");',
			"\treturn json({ limit, who, again });",
			"}",
			"export async function other(url: URL) {",
			'\treturn json({ x: url.searchParams.get("elsewhere") });',
			"}",
		].join("\n"),
	);

	it("collects the names one handler reads, in order, without repeats", () => {
		const span = findHandlerSpan(fixture, "listThings");
		expect(span).not.toBeNull();
		expect(queryParamsIn(fixture, span as { from: number; to: number })).toEqual(["limit", "user_id"]);
	});

	it("stops at the handler's closing brace, so a neighbour's reads are not attributed to it", () => {
		const span = findHandlerSpan(fixture, "listThings");
		expect(queryParamsIn(fixture, span as { from: number; to: number })).not.toContain("elsewhere");
	});

	it("does not count a parameter named only in a comment", () => {
		const span = findHandlerSpan(fixture, "listThings");
		expect(queryParamsIn(fixture, span as { from: number; to: number })).not.toContain("cursor");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Against the real object — non-vacuity, and the pin that matters
// ─────────────────────────────────────────────────────────────────────────────

describe("the real AgentDO dispatch table", () => {
	const arms = parseDoRouteTable(AGENT_DO);

	it("parses every arm the object actually has", () => {
		// The chain is a literal `if (path …)` per route; if the parser starts skipping arms it
		// will report "the DO honours nothing here" for the ones it lost, which reads as a pass.
		const written = (AGENT_DO.code.match(/\bif \(path/g) || []).length;
		expect(written).toBeGreaterThan(40);
		expect(arms.length).toBe(written);
	});

	it("resolves handlers for all but the arms that answer inline", () => {
		const unresolved = arms.filter((a) => !a.handler).map((a) => a.condition);
		// `/system-message` builds its response in the arm itself. It takes no query parameters,
		// and an arm with no handler yields an empty parameter set rather than an error.
		expect(unresolved).toEqual(['path === "/system-message" && request.method === "POST"']);
	});

	/**
	 * The pin. `GET /messages` is the #428 site: the DO reads `limit` and — since #428 — `before`.
	 * If a future edit drops `before` from the handler, this fails here, and the seam guard in
	 * `routes/do-seam.contract.test.ts` stops requiring the routes to forward it. Both halves have
	 * to move together, deliberately.
	 */
	it("says GET /messages takes limit and before", () => {
		expect(doQueryParams(DO_SOURCES, AGENT_DO, "GET", "/messages")).toEqual(["limit", "before"]);
	});

	it("reaches handlers in the sibling modules, not just methods on the class", () => {
		expect(doQueryParams(DO_SOURCES, AGENT_DO, "GET", "/collections/jobs/records")).toEqual([
			"where",
			"order_by",
			"order_dir",
			"limit",
			"offset",
		]);
		expect(doQueryParams(DO_SOURCES, AGENT_DO, "GET", "/activity")).toEqual(["limit", "type", "user_id"]);
	});

	it("distinguishes an unrouted path from a routed one that takes nothing", () => {
		expect(() => doQueryParams(DO_SOURCES, AGENT_DO, "GET", "/nope")).toThrow(/no arm for/);
		expect(doQueryParams(DO_SOURCES, AGENT_DO, "GET", "/state")).toEqual([]);
	});
});
