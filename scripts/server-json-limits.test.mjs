// #1227 — the server.json registry-limit guard (scripts/check-server-json.mjs).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { REGISTRY_LIMITS, serverJsonProblems } from "./check-server-json.mjs";

describe("server.json fits the MCP registry's schema limits (#1227)", () => {
	it("the repo's manifest fits", () => {
		expect(serverJsonProblems(JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8")))).toEqual([]);
	});

	it("names each field over its limit, with its length and the limit — counted in characters, not bytes", () => {
		const long = "é".repeat(REGISTRY_LIMITS.description + 1);
		expect(serverJsonProblems({ description: long, title: "ok" })).toEqual([{ field: "description", length: 101, limit: 100 }]);
		expect(serverJsonProblems({ description: "é".repeat(100), title: "t".repeat(101) })).toEqual([{ field: "title", length: 101, limit: 100 }]);
	});

	it("a missing field is not a problem", () => {
		expect(serverJsonProblems({})).toEqual([]);
	});
});
