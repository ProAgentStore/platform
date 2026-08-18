import { describe, expect, it, vi } from "vitest";
import {
	audit,
	AUDIT_VALUE_MAX,
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

/**
 * ADR 0004 — an audit event points at content; it does not copy it.
 *
 * This is the test the ADR names, and it exists because the obvious "improvement" to #701 —
 * start logging the bodies — looks locally correct and passes everything else. It drives the
 * three shared helpers that used to pass the caller's `input` verbatim, so a refusal and a
 * rehearsal are now recorded the same way a success always was.
 */
describe("ADR 0004 — an audited value is an identity or a size, never a body", () => {
	const CONTENT = `/**\n * QA Automation — implementation.\n */\n${"const x = 1;\n".repeat(400)}`;

	function ctxWithKv(over: Partial<SafetyContext> = {}): SafetyContext {
		return { env: { OAUTH_KV: makeKv() }, subject: "user-1", scopes: ["write"], ...over };
	}

	/** Every string anywhere in the event, so the budget is asserted over the whole payload
	 *  rather than over the fields this test happened to think of. */
	function strings(value: unknown, out: string[] = []): string[] {
		if (typeof value === "string") out.push(value);
		else if (Array.isArray(value)) for (const v of value) strings(v, out);
		else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
		return out;
	}

	it("a REFUSED write records the file's size, not the file", async () => {
		// The live event that prompted ADR 0004: one `write_agent_file` denied for a missing
		// confirmation, with the whole source file on the record — while the fourteen that
		// succeeded recorded `{agent_id, path, message}` and no content at all.
		const ctx = ctxWithKv();

		await requireConfirmation(ctx, "write_agent_file", undefined, "write_agent_file", {
			agent_id: "qa-automation",
			path: "src/agent.ts",
			content: CONTENT,
		});

		const [event] = (await listAuditEvents(ctx)) as Array<Record<string, unknown>>;
		const input = event?.input as Record<string, unknown>;
		expect(input.agent_id).toBe("qa-automation");
		expect(input.path).toBe("src/agent.ts");
		expect(input.content).toBeUndefined();
		expect(input.contentBytes).toBe(new TextEncoder().encode(CONTENT).length);
		expect(JSON.stringify(event)).not.toContain("QA Automation");
	});

	it("a DRY RUN records the prompt's size, not the prompt", async () => {
		const ctx = ctxWithKv();
		const message = "Act as the dev agent for issue #135. ".repeat(20);

		await dryRun(ctx, "chat_with_instance", "send private instance chat message", { instance_id: "e4d2d031", message }, { endpoint: "/v1/instances/e4d2d031/chat", method: "POST" });

		const [event] = (await listAuditEvents(ctx)) as Array<Record<string, unknown>>;
		const input = event?.input as Record<string, unknown>;
		expect(input.instance_id).toBe("e4d2d031");
		expect(input.message).toBeUndefined();
		expect(input.messageBytes).toBe(new TextEncoder().encode(message).length);
	});

	it("a DENIED call on the scope path is summarised too", async () => {
		const ctx = ctxWithKv({ scopes: ["read"] });

		await requirePermission(ctx, "runtime", "coding_loop_start", { instance_id: "i1", objective: CONTENT });

		const [event] = (await listAuditEvents(ctx)) as Array<Record<string, unknown>>;
		const input = event?.input as Record<string, unknown>;
		expect(input.objective).toBeUndefined();
		expect(input.objectiveBytes).toBe(new TextEncoder().encode(CONTENT).length);
	});

	it("no audited value anywhere exceeds the identifier budget, at any depth", async () => {
		// The general form of the rule. A nested body is exactly how this would come back:
		// `dryRun`'s `wouldDo` is an arbitrary object composed by the call site.
		const ctx = ctxWithKv();

		await dryRun(
			ctx,
			"batch_write_agent_files",
			"write files",
			{ agent_id: "a1", files: [{ path: "a.ts", content: CONTENT }] },
			{ wrote: [{ path: "a.ts", body: CONTENT }], note: CONTENT },
		);

		const [event] = (await listAuditEvents(ctx)) as Array<Record<string, unknown>>;
		const long = strings(event).filter((s) => s.length > AUDIT_VALUE_MAX);
		expect(long, `audited string(s) longer than an id: ${long.map((s) => s.slice(0, 40)).join(" | ")}`).toEqual([]);
		// And the sizes survived — this is a summary, not a deletion.
		expect(JSON.stringify(event)).toContain("contentBytes");
		expect(JSON.stringify(event)).toContain("bodyBytes");
	});

	it("keeps identifiers, which are the whole point of the record", async () => {
		const ctx = ctxWithKv();
		const ids = {
			instance_id: "bd43f4de-1111-2222-3333-444455556666",
			session_id: "csess_6ce3627a-3c3f-439a-90f3-ff4a6de3167a",
			traceId: "9f1c2b84-6d3e-4a55-9c07-2f8ab41d7e63",
			path: "packages/browser-runner/src/coding/headless.ts",
			messageBytes: 1519,
		};

		await audit(ctx, { tool: "chat_with_instance", action: "completed", input: ids });

		expect((await listAuditEvents(ctx))[0]).toMatchObject({ input: ids });
	});
});
