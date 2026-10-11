import { describe, expect, it, vi } from "vitest";
import { AUDIT_MIGRATION_KEY, AUDIT_TTL_SECONDS, auditGlobalKey, auditIndexKey, readAuditCoverage } from "./audit-ledger.js";
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

describe("coverage read from the API's migration record (#1016)", () => {
	const kvWith = (state: unknown) => ({ get: async (k: string) => (k === AUDIT_MIGRATION_KEY ? JSON.stringify(state) : null) }) as unknown as KVNamespace;

	it("is partial, not complete, when the finished migration left unplaceable records", async () => {
		const coverage = await readAuditCoverage(kvWith({ status: "complete", pass: 2, scanned: 10, unplaceable: 2, passUnplaceable: 0 }));
		expect(coverage).toMatchObject({ complete: false, legacyIndex: "complete" });
		expect(coverage.detail).toMatch(/2 unplaceable legacy records could not be indexed/i);
	});

	it("is complete only when the finished migration placed every record", async () => {
		expect(await readAuditCoverage(kvWith({ status: "complete", pass: 2, scanned: 10, unplaceable: 0, passUnplaceable: 0 }))).toMatchObject({ complete: true, legacyIndex: "complete" });
	});

	// The writer before ac253dd9 summed `unplaceable` over passes and never wrote `passUnplaceable`.
	it("never reports an old writer's summed count as a number of records, finished or not", async () => {
		for (const old of [
			{ status: "complete", pass: 2, scanned: 10, unplaceable: 4 },
			{ status: "running", pass: 1, cursor: "c", scanned: 7, unplaceable: 3 },
		]) {
			const coverage = await readAuditCoverage(kvWith(old));
			expect(coverage).toMatchObject({ complete: false, legacyIndex: "in_progress" });
			expect(coverage.detail).toMatch(/being re-established/);
			expect(coverage.detail).not.toMatch(/\d+ unplaceable/);
		}
	});

	it("still reads an old writer's record with nothing unplaceable at face value", async () => {
		expect(await readAuditCoverage(kvWith({ status: "complete", pass: 2, scanned: 10, unplaceable: 0 }))).toMatchObject({ complete: true });
		expect(await readAuditCoverage(kvWith({ status: "running", pass: 1, cursor: "c", scanned: 4, unplaceable: 0 }))).toMatchObject({
			complete: false,
			legacyIndex: "in_progress",
		});
	});
});
