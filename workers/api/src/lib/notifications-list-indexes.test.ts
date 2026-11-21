/**
 * The notifications list (#1684) must return its page straight off an index, never sorting the user's whole history.
 * Plan assertions are version-independent: a SEARCH, no bare SCAN, no TEMP B-TREE, whichever index the planner picks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RealSchemaD1, realSchemaD1 } from "./d1-sqlite.js";

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("PRAGMA foreign_keys = OFF");
});
afterEach(() => d1.close());

const insert = (id: string, read: number, at: string) =>
	d1.exec(`INSERT INTO notifications (id, user_id, type, title, read, created_at) VALUES ('${id}', 'u1', 't', 'T', ${read}, '${at}')`);

const listSql = (unread: boolean) =>
	`SELECT * FROM notifications WHERE user_id = ?1${unread ? " AND read = 0" : ""} ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3`;

describe("notifications list (#1684)", () => {
	for (const unread of [false, true]) {
		it(`${unread ? "unread" : "full"} list is served in order by an index`, () => {
			const plan = (d1.sqlite.prepare(`EXPLAIN QUERY PLAN ${listSql(unread)}`).all("u1", 51, 0) as Array<{ detail: string }>).map((p) => p.detail);
			expect(plan.some((d) => d.startsWith("SEARCH notifications USING")), plan.join(" | ")).toBe(true);
			expect(plan.some((d) => d.includes("TEMP B-TREE")), plan.join(" | ")).toBe(false);
			expect(plan.some((d) => d.startsWith("SCAN notifications")), plan.join(" | ")).toBe(false);
		});
	}

	it("keeps the page order, id tiebreak and offset", () => {
		insert("a", 0, "10"); insert("b", 1, "10"); insert("c", 0, "20"); insert("d", 1, "05");
		const ids = (unread: boolean, limit: number, offset: number) =>
			(d1.sqlite.prepare(listSql(unread)).all("u1", limit, offset) as Array<{ id: string }>).map((r) => r.id);
		expect(ids(false, 4, 0)).toEqual(["c", "b", "a", "d"]);
		expect(ids(false, 2, 1)).toEqual(["b", "a"]);
		expect(ids(true, 5, 0)).toEqual(["c", "a"]);
	});
});
