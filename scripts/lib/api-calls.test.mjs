/**
 * The API-call reader, proven on the shapes that produced FALSE GAPS (#610).
 *
 * Every case below was measured on the real tree before it was written here. The first prototype
 * of `check-mcp-parity.mjs` reported 103 gaps; 22 of them were wrong, and all 22 came from three
 * parsing shapes — a nested template, a path held in a variable, and a prefix read off a lookup
 * table. A false gap is the output that gets a guard deleted, because it sends someone to build a
 * tool that already exists.
 */

import { describe, expect, it } from "vitest";
import { expandTablePrefix, extractCalls, normalisePath, readLiteral } from "./api-calls.mjs";

describe("readLiteral", () => {
	it("reads a plain template and collapses its interpolations", () => {
		const src = "authedCall(`/v1/instances/${id}/board`, t)";
		const lit = readLiteral(src, src.indexOf("`"));
		expect(lit?.text).toBe("/v1/instances/{}/board");
		expect(lit?.parts).toEqual(["id"]);
	});

	it("survives a template nested INSIDE an interpolation — the agent_trace shape", () => {
		// The exact defect: a regex that ends the string at the first inner backtick reported
		// `agent_trace` as having no MCP route. It has one, and this is what it looks like.
		const src = 'const p = `/v1/instances/${encodeURIComponent(id)}/trace${qs ? `?${qs}` : ""}`;';
		const lit = readLiteral(src, src.indexOf("`"));
		expect(lit?.text).toBe("/v1/instances/{}/trace{}");
		expect(src.slice(lit.end)).toBe(";");
	});

	it("returns null for something that is not a literal, rather than an empty string", () => {
		// G1/G3 one level down: "not a literal" and "an empty literal" must not be the same answer.
		expect(readLiteral("foo(path)", 4)).toBeNull();
		expect(readLiteral('foo("")', 4)?.text).toBe("");
	});

	it("does not stop on an escaped quote", () => {
		expect(readLiteral('"/v1/a\\"b"', 0)?.text).toBe('/v1/a"b');
	});
});

describe("normalisePath", () => {
	it("collapses every spelling of a parameter to the same key", () => {
		expect(normalisePath("/v1/instances/{}/files/{}")).toBe("/v1/instances/{}/files/{}");
		expect(normalisePath("/v1/instances/:instanceId/files/:fileId")).toBe("/v1/instances/{}/files/{}");
	});

	it("drops the query string, because a filter is not a different capability", () => {
		expect(normalisePath("/v1/instances/{}/trace?trace_id={}&limit=50")).toBe("/v1/instances/{}/trace");
	});

	it("drops an interpolation GLUED to a segment — that is a query string, not a segment", () => {
		// `/v1/agents/${id}/activity${qs}` must equal `/v1/agents/{}/activity`, or the console and
		// MCP disagree about a route they both call.
		expect(normalisePath("/v1/agents/{}/activity{}")).toBe("/v1/agents/{}/activity");
		expect(normalisePath("/v1/instances/{}/trace{}")).toBe("/v1/instances/{}/trace");
	});
});

describe("extractCalls", () => {
	it("reads the method out of the options object, defaulting to GET", () => {
		const src = `
			await api(\`/v1/instances/\${id}/board\`);
			await api(\`/v1/instances/\${id}/tasks/clear-finished\`, { method: "POST" });
		`;
		expect(extractCalls(src, ["api"]).calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"GET /v1/instances/{}/board",
			"POST /v1/instances/{}/tasks/clear-finished",
		]);
	});

	it("follows a path held in a variable, including a ternary of two paths", () => {
		// `instance_runtime_status` — one tool, two routes, chosen by argument. Unresolved, it
		// reported `GET /v1/instances/{}/runtime/status` as missing when it is right there.
		const src = `
			const path = node ? \`/v1/instances/\${id}/runtime/status\` : \`/v1/instances/\${id}/runtime\`;
			const data = await authedCall(path, sessionToken, {}, env);
		`;
		const keys = extractCalls(src, ["authedCall"]).calls.map((c) => `${c.method} ${c.path}`);
		expect(keys).toContain("GET /v1/instances/{}/runtime/status");
		expect(keys).toContain("GET /v1/instances/{}/runtime");
	});

	it("expands a prefix read off a lookup table — the Drive/WorkDrive shape", () => {
		// Six false gaps came from this one call site: two connectors served by one registration.
		const src = `
			const PROVIDERS = { google_drive: { base: "/v1/drive" }, zoho_workdrive: { base: "/v1/workdrive" } };
			const data = await authedCall(\`\${PROVIDERS[p].base}/instances/\${id}/grants\`, t, { method: "POST" }, env);
		`;
		expect(extractCalls(src, ["authedCall"]).calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
			"POST /v1/drive/instances/{}/grants",
			"POST /v1/workdrive/instances/{}/grants",
		]);
	});

	it("reports a path it cannot resolve instead of dropping it", () => {
		// The honest half: `api(entry.flow.start)` is a capability read off a data table, and a
		// coverage figure computed over a tree with silently skipped calls is not a coverage figure.
		const { calls, unresolved } = extractCalls("await api(entry.flow.start);", ["api"]);
		expect(calls).toEqual([]);
		expect(unresolved).toEqual(["entry.flow.start"]);
	});

	it("ignores a call to a DIFFERENT function that ends in the same letters", () => {
		// `useApi(` must not be read as `api(`, and `thing.api(` is a method on something else.
		const src = 'await other.api(`/v1/nope`); await myapi(`/v1/also-nope`);';
		expect(extractCalls(src, ["api"]).calls).toEqual([]);
	});

	it("ignores a string that is not an API path", () => {
		expect(extractCalls('api("/docs/mcp/")', ["api"]).calls).toEqual([]);
	});
});

describe("expandTablePrefix", () => {
	it("returns nothing when the interpolation reads no field, rather than guessing", () => {
		expect(expandTablePrefix("{}/instances", "someVar", 'const base = "/v1/x";')).toEqual([]);
	});

	it("returns nothing when the suffix is not a path", () => {
		expect(expandTablePrefix("{}x", "P[i].base", 'base: "/v1/drive"')).toEqual([]);
	});
});
