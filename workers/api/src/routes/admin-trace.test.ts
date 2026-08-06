import { describe, expect, it } from "vitest";
import { buildTraceQuery } from "./admin-trace.js";

describe("buildTraceQuery", () => {
	it("binds every user-supplied filter instead of interpolating it", () => {
		// This is an admin route reading a cross-tenant audit table. The only things ever
		// interpolated into the SQL are the clamped integer limit and a fixed ASC/DESC keyword;
		// anything a caller typed must arrive as a bind or this is an injection point.
		const { sql, binds } = buildTraceQuery({
			instanceId: "i'1",
			userId: "u1",
			source: "mcp",
			endpoint: "https://example.com/mcp",
			tool: "delete_site",
		});
		expect(sql).not.toContain("i'1");
		expect(sql).not.toContain("delete_site");
		expect(binds).toContain("i'1");
		expect(binds).toContain("delete_site");
	});

	it("filters the endpoint by parsed JSON, not by pattern-matching the blob", () => {
		// A LIKE over the serialized context would also match an endpoint that appears in some
		// unrelated field. In an audit tool an over-matching filter is worse than none, because
		// the operator believes the result set is exhaustive.
		const { sql } = buildTraceQuery({ endpoint: "https://example.com/mcp" });
		expect(sql).toContain("json_extract(context, '$.endpoint')");
		expect(sql).not.toContain("LIKE");
	});

	it("normalizes an endpoint filter to the form the connector actually logs", () => {
		// The trace stores the normalized endpoint. Typing the URL with a trailing slash or a
		// capitalised host is the obvious thing to do from the address bar, and an exact match
		// against the raw string would silently return nothing and read as "no calls happened".
		const { binds } = buildTraceQuery({ endpoint: "https://EXAMPLE.com/mcp/?k=secret" });
		expect(binds).toContain("https://example.com/mcp");
		// And the credential in the query string never reaches the query.
		expect(binds.some((b) => String(b).includes("secret"))).toBe(false);
	});

	it("guards the JSON extract so one malformed row can't fail the whole query", () => {
		const { sql } = buildTraceQuery({ tool: "x" });
		expect(sql).toContain("json_valid(context)");
	});

	it("clamps the limit rather than trusting it", () => {
		expect(buildTraceQuery({ limit: 999999 }).sql).toContain("LIMIT 1000");
		expect(buildTraceQuery({ limit: -5 }).sql).toContain("LIMIT 200");
		expect(buildTraceQuery({ limit: Number.NaN }).sql).toContain("LIMIT 200");
	});

	it("emits no WHERE clause when nothing is filtered", () => {
		// The fleet-wide listing with no filters must still be valid SQL — an empty
		// `WHERE ` would be a syntax error that only shows up on the unfiltered first load.
		const { sql, binds } = buildTraceQuery({});
		expect(sql).not.toContain("WHERE");
		expect(binds).toEqual([]);
	});

	it("orders oldest-first for a timeline and newest-first for the fleet view", () => {
		expect(buildTraceQuery({ order: "asc" }).sql).toContain("ORDER BY ts ASC");
		expect(buildTraceQuery({ order: "desc" }).sql).toContain("ORDER BY ts DESC");
	});
});
