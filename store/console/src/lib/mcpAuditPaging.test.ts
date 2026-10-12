import { describe, expect, it } from "vitest";
import { appendMcpAuditPage, mcpAuditCoverageNote } from "./mcpAuditPaging";

describe("the owner's MCP activity pager (#1016)", () => {
	it("the first page replaces the list; following nextCursor appends older events, in order, once each", () => {
		const first = appendMcpAuditPage(null, { events: ["e3", "e2"], nextCursor: "c1" }, undefined);
		expect(first).toEqual({ events: ["e3", "e2"], nextCursor: "c1" });
		const older = appendMcpAuditPage(first.events, { events: ["e1", "e0"], nextCursor: null }, first.nextCursor);
		expect(older).toEqual({ events: ["e3", "e2", "e1", "e0"], nextCursor: null });
	});

	it("a refresh without a cursor starts over instead of duplicating what is shown", () => {
		expect(appendMcpAuditPage(["e3", "e2"], { events: ["e4", "e3"], nextCursor: "c" }, null).events).toEqual(["e4", "e3"]);
	});

	it("an empty filtered page with a cursor still continues", () => {
		expect(appendMcpAuditPage(["e9"], { events: [], nextCursor: "c2" }, "c1")).toEqual({ events: ["e9"], nextCursor: "c2" });
	});

	it("says nothing when coverage is complete, and the server's sentence when it is not", () => {
		expect(mcpAuditCoverageNote(undefined)).toBeNull();
		expect(mcpAuditCoverageNote({ complete: true, detail: "Every event from the last 90 days is indexed." })).toBeNull();
		expect(mcpAuditCoverageNote({ complete: false, detail: "Events recorded before the ledger existed are still being indexed." })).toBe("Events recorded before the ledger existed are still being indexed.");
		expect(mcpAuditCoverageNote({ complete: false, detail: "" })).toMatch(/still being indexed/);
	});
});
