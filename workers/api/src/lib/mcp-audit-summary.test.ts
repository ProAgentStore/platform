/**
 * #1241 — per-tool counts of the MCP audit ledger from key metadata alone. The keys are built by the
 * real `auditGlobalKey`; the KV stub lists them newest-first in 1,000-key pages, as Cloudflare does,
 * and FAILS the test if anything tries to read a value.
 */
import { describe, expect, it } from "vitest";
import { AUDIT_GLOBAL_PREFIX, auditGlobalKey } from "./mcp-audit-ledger.js";
import { summarizeAuditLedger } from "./mcp-audit-summary.js";

const T0 = Date.parse("2026-10-19T12:00:00Z");
function ledger(events: Array<{ tool?: string; action?: string; ms: number }>) {
	const keys = events.map((e, i) => ({ name: auditGlobalKey("u1", e.ms, `id${i}`), metadata: e.tool ? { tool: e.tool, action: e.action } : undefined })).sort((a, b) => a.name.localeCompare(b.name));
	let lists = 0;
	const kv = {
		get: async () => {
			throw new Error("a summary must not read events");
		},
		list: async ({ prefix, limit = 1000, cursor }: { prefix: string; limit?: number; cursor?: string }) => {
			lists++;
			const all = keys.filter((k) => k.name.startsWith(prefix));
			const start = cursor ? Number(cursor) : 0;
			const page = all.slice(start, start + limit);
			const end = start + page.length;
			return end >= all.length ? { keys: page, list_complete: true, cacheStatus: null } : { keys: page, list_complete: false, cursor: String(end), cacheStatus: null };
		},
	} as unknown as KVNamespace;
	return { kv, lists: () => lists };
}

describe("summarizeAuditLedger (#1241)", () => {
	it("tallies tool × outcome from key metadata, worst failure count first, without reading an event", async () => {
		const at = (min: number) => T0 - min * 60_000;
		const { kv } = ledger([
			{ tool: "coding_loop_start", action: "completed", ms: at(1) },
			{ tool: "coding_loop_start", action: "failed", ms: at(2) },
			{ tool: "coding_loop_start", action: "completed", ms: at(3) },
			{ tool: "rename_instance", action: "invalid_input", ms: at(4) },
			{ tool: "rename_instance", action: "invalid_input", ms: at(5) },
			{ tool: "rename_instance", action: "error", ms: at(6) },
			{ tool: "(unregistered)", action: "invalid_input", ms: at(7) },
			{ ms: at(8) },
		]);
		const s = await summarizeAuditLedger(kv, { prefix: AUDIT_GLOBAL_PREFIX });
		expect(s.tools.map((t) => [t.tool, t.total, t.failures])).toEqual([
			["rename_instance", 3, 3],
			["coding_loop_start", 3, 1],
			["(unregistered)", 1, 1],
			["(no metadata)", 1, 0],
		]);
		expect(s.tools[0].byAction).toEqual({ invalid_input: 2, error: 1 });
		expect(s).toMatchObject({ scanned: 8, complete: true, nextCursor: null, window: { newest: new Date(at(1)).toISOString(), oldest: new Date(at(8)).toISOString() } });
	});

	it("honours since/until and stops at the first key older than since", async () => {
		const { kv, lists } = ledger(Array.from({ length: 2500 }, (_, i) => ({ tool: "t", action: "completed", ms: T0 - i * 1000 })));
		const s = await summarizeAuditLedger(kv, { prefix: AUDIT_GLOBAL_PREFIX, since: T0 - 1499 * 1000, until: T0 - 500 * 1000 });
		expect(s.scanned).toBe(1000);
		expect(s.complete).toBe(true);
		expect(lists()).toBe(2); // it did not list the third page
	});

	it("past its key budget it hands back a cursor, and the next page continues where it stopped", async () => {
		const { kv } = ledger(Array.from({ length: 2500 }, (_, i) => ({ tool: i < 1000 ? "a" : "b", action: "completed", ms: T0 - i * 1000 })));
		const first = await summarizeAuditLedger(kv, { prefix: AUDIT_GLOBAL_PREFIX, maxKeys: 1000 });
		expect(first).toMatchObject({ scanned: 1000, complete: false, nextCursor: "1000" });
		const second = await summarizeAuditLedger(kv, { prefix: AUDIT_GLOBAL_PREFIX, cursor: first.nextCursor as string });
		expect(second).toMatchObject({ scanned: 1500, complete: true });
		expect(second.tools).toEqual([expect.objectContaining({ tool: "b", total: 1500 })]);
	});
});
