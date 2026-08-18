import { describe, expect, it, vi } from "vitest";
import {
	audit,
	dryRun,
	listAuditEvents,
	parseScopes,
	requireConfirmation,
	requirePermission,
	type SafetyContext,
} from "./safety.js";

/**
 * A KV stub that models the KV that EXISTS, not a convenient one (#704).
 *
 * Two properties matter and both were missing before: Cloudflare KV returns keys in
 * LEXICOGRAPHIC order (this stub `.sort()`s), and it truncates to `limit` AFTER that
 * ordering — so asking for `limit` keys yields the lexicographically FIRST ones, which
 * for an ISO-timestamped key name means the OLDEST. The old stub returned `Map`
 * insertion order and was never given more keys than the limit, so it agreed with a
 * reader that took the first N and called them the newest.
 */
function makeKv(): KVNamespace {
	const data = new Map<string, string>();
	return {
		get: async (key: string) => data.get(key) ?? null,
		put: async (key: string, value: string) => {
			data.set(key, value);
		},
		delete: async (key: string) => {
			data.delete(key);
		},
		list: async ({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) => {
			const all = Array.from(data.keys())
				.filter((name) => name.startsWith(prefix))
				.sort();
			return {
				keys: all.slice(0, limit).map((name) => ({ name })),
				list_complete: all.length <= limit,
				cursor: undefined,
				cacheStatus: null,
			};
		},
	} as unknown as KVNamespace;
}

describe("MCP safety helpers", () => {
	it("parses scopes with safe defaults (no/invalid scope → no destructive)", () => {
		// Default grant excludes `destructive` — delete/overwrite need explicit opt-in.
		expect(parseScopes(null)).toEqual(["read", "write", "runtime"]);
		expect(parseScopes("read runtime unknown")).toEqual(["read", "runtime"]);
		expect(parseScopes("openid email profile")).toEqual(["read", "write", "runtime"]);
		expect(parseScopes("unknown")).toEqual(["read", "write", "runtime"]);
		// …but an explicit destructive request is still honored.
		expect(parseScopes("read destructive")).toEqual(["read", "destructive"]);
	});

	it("blocks writes in read-only mode", async () => {
		const ctx: SafetyContext = {
			env: { MCP_READ_ONLY: "1" },
			scopes: ["read", "write"],
		};

		const result = await requirePermission(ctx, "write", "create_agent", {});

		expect(result?.content[0]?.text).toContain("read-only mode");
	});

	it("blocks missing scopes", async () => {
		const ctx: SafetyContext = {
			env: {},
			scopes: ["read"],
		};

		const result = await requirePermission(ctx, "runtime", "run_instance_task", {});

		expect(result?.content[0]?.text).toContain('scope "runtime"');
	});

	it("requires exact destructive confirmations", async () => {
		const ctx: SafetyContext = { env: {}, scopes: ["destructive"] };

		const result = await requireConfirmation(
			ctx,
			"cancel_instance",
			undefined,
			"cancel_instance",
			{},
		);

		expect(result?.content[0]?.text).toContain('confirm="cancel_instance"');
	});

	it("returns auditable dry-run responses", async () => {
		const ctx: SafetyContext = {
			env: { OAUTH_KV: makeKv() },
			subject: "user-1",
			scopes: ["write"],
		};

		const result = await dryRun(ctx, "create_agent", "create agent", { token: "secret" }, { slug: "demo" });
		const body = JSON.parse(result.content[0]?.text || "{}") as Record<string, unknown>;

		expect(body).toMatchObject({ dryRun: true, tool: "create_agent" });
		const events = await listAuditEvents(ctx);
		expect(events).toHaveLength(1);
	});

	// The bug this pins (#704): `listAuditEvents` asked KV for the first `limit` keys and then
	// sorted THOSE descending. KV orders lexicographically and the key carries an ISO time, so
	// the first `limit` keys are the OLDEST — correctly sorted newest-first among themselves,
	// which is why the output looked right while answering with events from two months ago.
	// The regime only exists once the log holds more events than the limit, so this test seeds
	// six times the limit; with fewer, both the broken and the fixed reader agree.
	it("returns the newest events when the log holds more than the limit", async () => {
		vi.useFakeTimers();
		try {
			const ctx: SafetyContext = {
				env: { OAUTH_KV: makeKv() },
				subject: "user-1",
				scopes: ["write"],
			};

			for (let i = 0; i < 60; i++) {
				vi.setSystemTime(new Date(Date.UTC(2026, 4, 20, 0, i, 0)));
				await audit(ctx, { tool: "list_agents", action: "completed", seq: i });
			}

			const events = (await listAuditEvents(ctx, 10)) as Array<{ seq: number; time: string }>;

			expect(events).toHaveLength(10);
			expect(events.map((e) => e.seq)).toEqual([59, 58, 57, 56, 55, 54, 53, 52, 51, 50]);
			expect(events[0]?.time).toBe("2026-05-20T00:59:00.000Z");
		} finally {
			vi.useRealTimers();
		}
	});

	it("redacts secrets in audit logs", async () => {
		const ctx: SafetyContext = {
			env: { OAUTH_KV: makeKv() },
			subject: "user-1",
			scopes: ["write"],
		};

		await audit(ctx, {
			tool: "register_instance_runtime",
			input: { runner_token: "secret", nested: { password: "secret" } },
		});

		const [event] = await listAuditEvents(ctx);
		expect(event).toMatchObject({
			input: {
				runner_token: "[redacted]",
				nested: { password: "[redacted]" },
			},
		});
	});
});
