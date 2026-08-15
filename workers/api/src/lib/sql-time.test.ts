import { describe, expect, it } from "vitest";
import { migrationSchemaDb } from "./d1-sqlite.js";
import { isSqlTime, sqlTime, sqlTimeMs, sqlTimeToIso, toSqlTime } from "./sql-time.js";

const NOW = Date.parse("2026-08-15T22:38:19.437Z");

describe("sqlTime emits exactly what datetime('now') emits", () => {
	it("truncates to the second and uses a space separator", () => {
		expect(sqlTime(NOW)).toBe("2026-08-15 22:38:19");
		expect(sqlTime(new Date(NOW))).toBe("2026-08-15 22:38:19");
		expect(sqlTime()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("agrees with SQLite's own datetime(), byte for byte", () => {
		// The claim this module exists to make. Asserted against the engine rather than against a
		// regex, because the whole defect class is "the two strings look equivalent to a reader".
		const db = migrationSchemaDb();
		const row = db.prepare("SELECT datetime(?1, 'unixepoch') AS t").get(Math.floor(NOW / 1000)) as { t: string };
		expect(sqlTime(NOW)).toBe(row.t);
		db.close();
	});
});

describe("the comparison the two formats get wrong", () => {
	// Executed, not argued: `' '` is 0x20 and `'T'` is 0x54, so an ISO stamp beats a same-date
	// `datetime('now')` stamp regardless of the clock. This is #634's mis-ordering and #657's
	// never-firing TTL in one expression.
	const db = migrationSchemaDb();
	const cmp = (a: string, op: string, b: string): number =>
		(db.prepare(`SELECT (?1 ${op} ?2) AS r`).get(a, b) as { r: number }).r;

	it("ranks midnight-ISO above ten-at-night-SQL on the same date", () => {
		expect(cmp("2026-08-15T00:00:01.000Z", ">", "2026-08-15 22:38:19")).toBe(1);
	});

	it("stops doing that once both sides are normalised", () => {
		expect(cmp(toSqlTime("2026-08-15T00:00:01.000Z"), ">", "2026-08-15 22:38:19")).toBe(0);
	});

	it("never fires an `<= datetime('now')` TTL written as ISO, for the whole UTC day", () => {
		expect(cmp("2026-08-15T10:10:00.000Z", "<=", "2026-08-15 23:59:00")).toBe(0);
		expect(cmp(toSqlTime("2026-08-15T10:10:00.000Z"), "<=", "2026-08-15 23:59:00")).toBe(1);
	});
});

describe("isSqlTime", () => {
	it("accepts the column format and rejects everything that merely resembles it", () => {
		expect(isSqlTime("2026-08-15 22:38:19")).toBe(true);
		// Anchored: an ISO string starts the same way and must NOT pass, or `toSqlTime` would hand
		// the unconverted value straight back and the helper would be decorative.
		expect(isSqlTime("2026-08-15T22:38:19.437Z")).toBe(false);
		expect(isSqlTime("2026-08-15 22:38:19.437")).toBe(false);
		expect(isSqlTime("2026-08-15")).toBe(false);
		expect(isSqlTime(NOW)).toBe(false);
		expect(isSqlTime(null)).toBe(false);
	});
});

describe("toSqlTime — the boundary converter", () => {
	it("converts ISO, keeps an already-converted value, and reads UTC not local", () => {
		expect(toSqlTime("2026-08-15T22:38:19.437Z")).toBe("2026-08-15 22:38:19");
		expect(toSqlTime("2026-08-15 22:38:19")).toBe("2026-08-15 22:38:19");
		// An offset stamp is an instant, not a wall clock: 09:38+11:00 is 22:38 the day before.
		expect(toSqlTime("2026-08-16T09:38:19+11:00")).toBe("2026-08-15 22:38:19");
	});

	it("falls back rather than storing something unsortable", () => {
		// A string the column cannot sort takes the row out of every windowed read, which is worse
		// than a stamp that is a fraction of a second off.
		expect(toSqlTime("not a date", NOW)).toBe("2026-08-15 22:38:19");
		expect(toSqlTime(undefined, NOW)).toBe("2026-08-15 22:38:19");
		expect(toSqlTime("", NOW)).toBe("2026-08-15 22:38:19");
		expect(toSqlTime(1234, NOW)).toBe("2026-08-15 22:38:19");
	});
});

describe("reading a stored stamp back", () => {
	it("sqlTimeMs treats the column format as UTC, which Date.parse does not promise", () => {
		expect(sqlTimeMs("2026-08-15 22:38:19")).toBe(Date.parse("2026-08-15T22:38:19Z"));
		expect(sqlTimeMs("2026-08-15T22:38:19.437Z")).toBe(NOW);
		expect(sqlTimeMs("  2026-08-15 22:38:19  ")).toBe(Date.parse("2026-08-15T22:38:19Z"));
		expect(sqlTimeMs("nonsense")).toBeNaN();
		expect(sqlTimeMs("")).toBeNaN();
	});

	it("sqlTimeToIso republishes the column as the ISO a JSON field promised", () => {
		expect(sqlTimeToIso("2026-08-15 22:38:19")).toBe("2026-08-15T22:38:19.000Z");
		expect(sqlTimeToIso("2026-08-15T22:38:19.437Z")).toBe("2026-08-15T22:38:19.437Z");
		// Not the place to invent one.
		expect(sqlTimeToIso("nonsense")).toBe("nonsense");
	});
});
