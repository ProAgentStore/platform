import { describe, expect, it } from "vitest";
import { appendAuditPage, auditCoverageNote } from "./mcp-audit-paging";

describe("the admin MCP audit sweep pager (#1016)", () => {
	it("pages past the first 200 events: Load older appends the next-older page; null is the end", () => {
		const first = appendAuditPage(null, { events: Array.from({ length: 200 }, (_, i) => `e${399 - i}`), nextCursor: "c1" }, undefined);
		const older = appendAuditPage(first.events, { events: Array.from({ length: 200 }, (_, i) => `e${199 - i}`), nextCursor: null }, first.nextCursor);
		expect(older.events).toHaveLength(400);
		expect(new Set(older.events).size).toBe(400);
		expect(older.events[0]).toBe("e399");
		expect(older.events[399]).toBe("e0");
		expect(older.nextCursor).toBeNull();
	});

	it("a fresh sweep (new filter) replaces what was shown", () => {
		expect(appendAuditPage(["a", "b"], { events: ["c"], nextCursor: null }, undefined).events).toEqual(["c"]);
	});

	it("reports incomplete coverage, and nothing once it is complete", () => {
		expect(auditCoverageNote({ complete: false, detail: "Legacy events are still being indexed." })).toBe("Legacy events are still being indexed.");
		expect(auditCoverageNote({ complete: true, detail: "x" })).toBeNull();
		expect(auditCoverageNote(undefined)).toBeNull();
	});
});
