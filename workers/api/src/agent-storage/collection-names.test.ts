import { describe, expect, it } from "vitest";
import { assertCollectionName } from "./collections.js";

describe("collection names — one choke point, because a colon collides with a key prefix", () => {
	it("rejects a name containing ':' — silent cross-collection data loss", () => {
		// Records live at `col:{name}:{id}` and indexes at `idx:{name}:{field}:…`. With `leads` and
		// `leads:2026` both present, querying `leads` full-scans `col:leads:` and returns the other
		// collection's records — and deleting `leads` deletes `col:leads:`, destroying every record
		// and index of `leads:2026` while its schema survives with a now-false recordCount. The
		// regex previously lived ONLY in the create_collection agent tool, so the DO handler, the
		// HTTP route, the MCP tool (plain z.string()) and recordInsert's auto-create all accepted
		// any string — reachable by an LLM simply putting a colon in a collection name.
		expect(() => assertCollectionName("leads:2026")).toThrow(/Invalid collection name/);
		expect(() => assertCollectionName("leads%2026")).toThrow();
		expect(() => assertCollectionName("col:leads")).toThrow();
	});

	it("rejects the other shapes that break the key scheme", () => {
		expect(() => assertCollectionName("")).toThrow();
		expect(() => assertCollectionName("2026leads")).toThrow(); // must start with a letter
		expect(() => assertCollectionName("Leads")).toThrow(); // keys are lowercase
		expect(() => assertCollectionName("my leads")).toThrow();
		expect(() => assertCollectionName("a".repeat(51))).toThrow();
	});

	it("accepts the ordinary ones", () => {
		for (const name of ["leads", "sites", "job_applications", "a", "a".repeat(50)]) {
			expect(() => assertCollectionName(name)).not.toThrow();
		}
	});
});
