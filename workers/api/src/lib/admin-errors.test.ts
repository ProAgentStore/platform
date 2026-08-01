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
});
