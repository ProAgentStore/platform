import { describe, expect, it, vi, afterEach } from "vitest";
import { callRunner, type RunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

/** Build a mock RELAY namespace. */
function mockRelay(handler: (req: Request) => Promise<Response>) {
	return {
		idFromName: (name: string) => ({ name }),
		get: (_id: any) => ({ fetch: handler }),
	};
}

function mockConn(overrides: Partial<RunnerConn & { RELAY?: any }> = {}): RunnerConn {
	return {
		endpointUrl: "http://127.0.0.1:49171",
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

describe("callRunner (relay-only)", () => {
	afterEach(() => { vi.restoreAllMocks(); });

	it("sends command through relay and returns result", async () => {
		const relay = mockRelay(async (req) => {
			const body = await req.json() as any;
			expect(body.method).toBe("POST");
			expect(body.path).toBe("/browser/snapshot");
			return Response.json({ url: "https://job.com", snapshot: "<html>" });
		});
		const conn = mockConn({ RELAY: relay });
		const result = await callRunner<{ url: string }>(conn, "/browser/snapshot", { taskId: "t1" });
		expect(result.url).toBe("https://job.com");
	});

	it("throws when relay returns 503 (no runner connected)", async () => {
		const relay = mockRelay(async () => Response.json({ error: "No runner connected" }, { status: 503 }));
		const conn = mockConn({ RELAY: relay });
		await expect(callRunner(conn, "/test")).rejects.toThrow("No runner connected");
	});

	it("throws when RELAY binding is absent", async () => {
		const conn = mockConn({ RELAY: undefined });
		await expect(callRunner(conn, "/test")).rejects.toThrow("RELAY binding not configured");
	});

	it("propagates relay errors", async () => {
		const relay = mockRelay(async () => Response.json({ error: "Internal" }, { status: 500 }));
		const conn = mockConn({ RELAY: relay });
		await expect(callRunner(conn, "/test")).rejects.toThrow("Runner /test");
	});

	it("handles null JSON response from relay", async () => {
		const relay = mockRelay(async () => new Response("null", { headers: { "Content-Type": "application/json" } }));
		const conn = mockConn({ RELAY: relay });
		const result = await callRunner(conn, "/test");
		expect(result).toBeNull();
	});
});
