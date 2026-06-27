import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { callRunner, type RunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

// ── Stub helpers ────────────────────────────────────────────────────────

/** Build a mock RELAY namespace whose stub.fetch returns `handler`'s result. */
function mockRelay(handler: (req: Request) => Promise<Response>) {
	return {
		idFromName: (name: string) => ({ name }),
		get: (_id: any) => ({
			fetch: handler,
		}),
	};
}

function mockConn(overrides: Partial<RunnerConn & { RELAY?: any }> = {}): RunnerConn {
	return {
		endpointUrl: "https://tunnel.example.com",
		token: "runner-tok",
		instanceId: "inst-1",
		userId: "user-1",
		env: {
			RELAY: overrides.RELAY ?? undefined,
			DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
		} as unknown as Env,
		...overrides,
	};
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("callRunner relay-first logic", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("uses relay when RELAY binding exists and runner is connected", async () => {
		const relay = mockRelay(async (req) => {
			const body = await req.json() as any;
			expect(body.method).toBe("POST");
			expect(body.path).toBe("/browser/snapshot");
			return Response.json({ url: "https://job.com", snapshot: "<html>" });
		});
		const conn = mockConn({ RELAY: relay });
		// Should NOT call global fetch (tunnel path)
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("should not be called"));

		const result = await callRunner<{ url: string; snapshot: string }>(conn, "/browser/snapshot", { taskId: "t1" });
		expect(result.url).toBe("https://job.com");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("falls back to tunnel when relay returns 503 (no runner connected)", async () => {
		const relay = mockRelay(async () => {
			return Response.json({ error: "No runner connected" }, { status: 503 });
		});
		const conn = mockConn({ RELAY: relay });
		globalThis.fetch = vi.fn().mockResolvedValue(
			Response.json({ ok: true }),
		);

		const result = await callRunner(conn, "/browser/snapshot", { taskId: "t1" });
		expect(result).toEqual({ ok: true });
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("falls back to tunnel when RELAY binding is absent", async () => {
		const conn = mockConn({ RELAY: undefined });
		globalThis.fetch = vi.fn().mockResolvedValue(
			Response.json({ result: "from-tunnel" }),
		);

		const result = await callRunner(conn, "/test");
		expect(result).toEqual({ result: "from-tunnel" });
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("propagates relay errors (non-503) instead of falling back", async () => {
		const relay = mockRelay(async () => {
			return Response.json({ error: "Internal relay error" }, { status: 500 });
		});
		const conn = mockConn({ RELAY: relay });
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("should not be called"));

		await expect(callRunner(conn, "/test")).rejects.toThrow("Relay /test");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("falls back to tunnel when relay throws a network error", async () => {
		const relay = mockRelay(async () => {
			throw new TypeError("fetch failed");
		});
		const conn = mockConn({ RELAY: relay });
		globalThis.fetch = vi.fn().mockResolvedValue(
			Response.json({ from: "tunnel" }),
		);

		const result = await callRunner(conn, "/test");
		expect(result).toEqual({ from: "tunnel" });
	});

	it("handles null JSON response from relay without falling back to tunnel", async () => {
		const relay = mockRelay(async () => {
			return new Response("null", { headers: { "Content-Type": "application/json" } });
		});
		const conn = mockConn({ RELAY: relay });
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("should not be called"));

		const result = await callRunner(conn, "/test");
		expect(result).toBeNull();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
