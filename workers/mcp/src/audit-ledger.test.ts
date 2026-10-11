import { describe, expect, it, vi } from "vitest";
import { AUDIT_TTL_SECONDS, auditGlobalKey, auditIndexKey } from "./audit-ledger.js";
import { audit, type SafetyContext } from "./safety.js";

/**
 * The ledger key layout (#1016). The API Worker keeps a copy in `lib/mcp-audit-ledger.ts` and its
 * `routes/mcp-audit.test.ts` asserts these SAME strings — the two Workers cannot import each other,
 * so a fixed vector on both sides is what keeps the writer and the reader on one layout.
 */
describe("ledger keys", () => {
	it("inverts the time so lexicographic order is newest first", () => {
		const ms = Date.parse("2026-10-11T00:00:00.000Z");
		expect(auditIndexKey("u1", ms, "e1")).toBe("audit_idx:u1:8208323199999:e1");
		expect(auditGlobalKey("u1", ms, "e1")).toBe("audit_all:8208323199999:u1:e1");
		expect(auditIndexKey("u1", ms + 1, "e1") < auditIndexKey("u1", ms, "e1")).toBe(true);
	});
});

describe("writeAudit", () => {
	it("writes one value under both ledger keys, with the TTL and filterable metadata", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-10-11T00:00:00.000Z"));
			const puts: Array<{ key: string; value: string; opts: Record<string, unknown> }> = [];
			const kv = { put: async (key: string, value: string, opts: Record<string, unknown>) => void puts.push({ key, value, opts }) } as unknown as KVNamespace;
			const ctx: SafetyContext = { env: { OAUTH_KV: kv }, subject: "u1", scopes: ["write"] };

			// A payload carrying its own identity fields must not overwrite the recorded ones.
			await audit(ctx, { tool: "create_agent", action: "completed", id: "forged", subject: "someone-else", time: "1999-01-01" });

			expect(puts.map((p) => p.key.replace(/[0-9a-f-]{36}$/, "<id>"))).toEqual([
				"audit_idx:u1:8208323199999:<id>",
				"audit_all:8208323199999:u1:<id>",
			]);
			expect(puts[0]?.value).toBe(puts[1]?.value);
			const event = JSON.parse(puts[0]?.value ?? "{}");
			expect(event).toMatchObject({ subject: "u1", time: "2026-10-11T00:00:00.000Z", tool: "create_agent" });
			expect(puts[0]?.key.endsWith(`:${event.id}`)).toBe(true);
			expect(puts[0]?.opts).toEqual({ expirationTtl: AUDIT_TTL_SECONDS, metadata: { tool: "create_agent", action: "completed" } });
		} finally {
			vi.useRealTimers();
		}
	});
});
