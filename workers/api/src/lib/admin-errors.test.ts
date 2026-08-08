import { describe, expect, it } from "vitest";
import { normalizeMessage, signatureKey, summarizeErrors, type RawError } from "./admin-errors.js";

function e(p: Partial<RawError>): RawError {
	return { id: "x", created_at: "2026-08-01 00:00:00", user_id: "u1", source: "auth", status: null, message: "m", context: null, ...p };
}

describe("normalizeMessage", () => {
	it("redacts uuids, long hex, numbers, quoted strings", () => {
		expect(normalizeMessage("GET /v1/instances/12ebf1f0-73a6-4172-bfbb-91518104c8bc/runtime/status → 502"))
			.toBe("get /v{n}/instances/{id}/runtime/status → {n}");
		expect(normalizeMessage('Translation failed for "hello world"')).toBe('translation failed for "{s}"');
	});
	it("collapses two near-identical messages to the same signature", () => {
		const a = signatureKey("client:api", "POST /v1/instances/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/translate → 502");
		const b = signatureKey("client:api", "POST /v1/instances/11111111-2222-3333-4444-555555555555/translate → 500");
		expect(a).toBe(b);
	});
});

describe("summarizeErrors", () => {
	it("groups by signature with count, distinct users, first/last seen", () => {
		const rows = [
			e({ id: "1", created_at: "2026-08-01 10:00:00", user_id: "u1", source: "job-apply", message: "timeout after 25s" }),
			e({ id: "2", created_at: "2026-08-01 09:00:00", user_id: "u2", source: "job-apply", message: "timeout after 30s" }),
			e({ id: "3", created_at: "2026-08-01 08:00:00", user_id: "u1", source: "job-apply", message: "timeout after 12s" }),
			e({ id: "4", created_at: "2026-08-01 07:00:00", user_id: "u9", source: "auth", message: "invalid token" }),
		];
		const sigs = summarizeErrors(rows);
		expect(sigs).toHaveLength(2);
		const top = sigs[0];
		expect(top.source).toBe("job-apply");
		expect(top.count).toBe(3);
		expect(top.users).toBe(2); // u1, u2
		expect(top.lastId).toBe("1"); // newest
		expect(top.firstSeen).toBe("2026-08-01 08:00:00");
		expect(top.lastSeen).toBe("2026-08-01 10:00:00");
	});
	it("sorts by count desc", () => {
		const rows = [
			e({ source: "a", message: "one" }),
			e({ source: "b", message: "two" }),
			e({ source: "b", message: "two" }),
		];
		expect(summarizeErrors(rows)[0].source).toBe("b");
	});

	it("counts OCCURRENCES, not rows — a collapsed row stands for all its repeats (#424)", () => {
		// The write side now folds an identical repeat into a counter. Counting rows would report
		// "2" for the failure that actually happened 1809 times, understating exactly the runaway
		// the counter exists to make visible — and the sort would then bury it.
		const rows = [
			e({ id: "1", source: "unhandled", message: "compound select", repeat_count: 900, created_at: "2026-08-01 11:00:00", last_seen_at: "2026-08-01 12:00:00" }),
			e({ id: "2", source: "unhandled", message: "compound select", repeat_count: 900, created_at: "2026-08-01 05:00:00" }),
			e({ id: "3", source: "voice", message: "stt failed" }),
		];
		const [top] = summarizeErrors(rows);
		expect(top.count).toBe(1800);
		expect(top.rows).toBe(2);
		expect(top.lastSeen).toBe("2026-08-01 12:00:00");
		expect(top.firstSeen).toBe("2026-08-01 05:00:00");
	});

	it("treats a row written before migration 0103 as one occurrence at error level", () => {
		// The columns are nullable and 1800 existing rows predate them. A NaN or a 0 here would
		// silently zero out the historic half of every signature.
		const [sig] = summarizeErrors([e({ repeat_count: null, last_seen_at: null, level: null })]);
		expect(sig.count).toBe(1);
		expect(sig.level).toBe("error");
		expect(sig.lastSeen).toBe("2026-08-01 00:00:00");
	});

	it("a signature that is EVER a real error is not filed under warn", () => {
		// Severity is per row, but the operator reads per signature. Taking the quietest member's
		// level would hide a 500 behind the diagnostic 402s that share its shape.
		const warnOnly = summarizeErrors([e({ level: "warn" }), e({ level: "warn" })]);
		expect(warnOnly[0].level).toBe("warn");
		const mixed = summarizeErrors([e({ level: "warn" }), e({ level: "error" })]);
		expect(mixed[0].level).toBe("error");
	});
});
