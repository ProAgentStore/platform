import { describe, expect, it, vi } from "vitest";
import { ALERT_THRESHOLDS, LATENCY_BUDGET_MS, newLatencyRing, percentile, summarize, verdictFor, withRequestTiming } from "./latency.js";

// #198: stage-level latency. The ring is the health tool's memory; the wrapper is the
// per-request `gateway` sample and the trace id every response now carries.

describe("percentile (nearest rank)", () => {
	it("is null on nothing and exact on a full set", () => {
		expect(percentile([], 95)).toBeNull();
		const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
		expect(percentile(sorted, 50)).toBe(50);
		expect(percentile(sorted, 95)).toBe(95);
		expect(percentile(sorted, 99)).toBe(99);
		expect(percentile(sorted, 100)).toBe(100);
	});
	it("never indexes past the end on tiny sets", () => {
		expect(percentile([7], 99)).toBe(7);
		expect(percentile([1, 9], 50)).toBe(1);
	});
});

describe("ring + summary", () => {
	const sample = (stage: "tool" | "api", name: string, ms: number, ok = true) => ({ stage, name, ms, ok, at: 1_000 });

	it("summarises one stage at a time, with failures and the newest sample", () => {
		const ring = newLatencyRing();
		[100, 200, 300, 400, 12_000].forEach((ms, i) => {
			ring.record({ ...sample("tool", "whoami", ms), at: 1_000 + i });
		});
		ring.record(sample("api", "/v1/auth/me/account", 50));
		ring.record({ ...sample("tool", "my_instances", 21_000, false), at: 9_999 });
		const s = ring.summary("tool");
		expect(s.count).toBe(6);
		expect(s.max).toBe(21_000);
		expect(s.failures).toBe(1);
		expect(s.failureRatePct).toBeCloseTo(16.7, 1);
		expect(s.newestAt).toBe(9_999);
		expect(ring.summary("api").count).toBe(1);
		expect(ring.summary("connector").count).toBe(0);
	});

	it("filters a stage by name family", () => {
		const ring = newLatencyRing();
		ring.record(sample("tool", "coding_loop_status", 4_300));
		ring.record(sample("tool", "whoami", 120));
		expect(ring.summaryWhere("tool", (n) => n.startsWith("coding_loop_")).count).toBe(1);
	});

	it("is bounded: old samples fall off", () => {
		const ring = newLatencyRing(3);
		for (let i = 0; i < 10; i++) ring.record(sample("tool", "t", i));
		expect(ring.samples("tool").map((s) => s.ms)).toEqual([7, 8, 9]);
	});

	it("rounds and floors durations so a clock skew never records a negative", () => {
		const ring = newLatencyRing();
		ring.record(sample("tool", "t", -3.7));
		expect(ring.samples()[0]?.ms).toBe(0);
	});
});

describe("verdictFor", () => {
	const summaryOf = (values: number[], failures = 0) =>
		summarize(values.map((ms, i) => ({ stage: "tool" as const, name: "t", ms, ok: i >= failures, at: 0 })));

	it("is unknown below the minimum sample count — an empty ring never reads as healthy", () => {
		expect(verdictFor("tool", summaryOf([]))).toBe("unknown");
		expect(verdictFor("tool", summaryOf(Array(ALERT_THRESHOLDS.minSamples - 1).fill(10)))).toBe("unknown");
	});

	it("is ok within budget and degraded when p95 exceeds it", () => {
		expect(verdictFor("tool", summaryOf([100, 200, 300, 400, 500]))).toBe("ok");
		expect(verdictFor("tool", summaryOf([100, 200, 300, 400, LATENCY_BUDGET_MS.tool + 1]))).toBe("degraded");
	});

	it("is degraded on a transport failure rate over the threshold even when fast", () => {
		// 1 failure in 5 = 20% > 2%.
		expect(verdictFor("api", summaryOf([10, 10, 10, 10, 10], 1))).toBe("degraded");
	});
});

describe("withRequestTiming", () => {
	const ctx = {} as ExecutionContext;

	it("stamps X-Trace-Id and Server-Timing on the response and logs one gateway line", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const inner = { fetch: async () => new Response("hi", { status: 200, headers: { "X-Existing": "1" } }) };
		const res = await withRequestTiming(inner).fetch(new Request("https://mcp.test/health?code=SECRET"), {}, ctx);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hi");
		expect(res.headers.get("X-Existing")).toBe("1");
		expect(res.headers.get("X-Trace-Id")).toMatch(/^[0-9a-f-]{36}$/);
		expect(res.headers.get("Server-Timing")).toMatch(/^gateway;dur=\d+$/);
		const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
		const request = lines.find((l) => l.kind === "mcp.request");
		expect(request).toMatchObject({ method: "GET", path: "/health", status: 200 });
		// The query string is where an OAuth code or state lives — never logged.
		expect(JSON.stringify(lines)).not.toContain("SECRET");
		expect(lines.find((l) => l.kind === "mcp.latency")).toMatchObject({ stage: "gateway", name: "request", ok: true });
		log.mockRestore();
	});

	it("keeps a caller-supplied X-Trace-Id so a client can correlate", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const inner = { fetch: async () => new Response(null, { status: 204 }) };
		const res = await withRequestTiming(inner).fetch(new Request("https://mcp.test/", { headers: { "X-Trace-Id": "client-trace-1" } }), {}, ctx);
		expect(res.headers.get("X-Trace-Id")).toBe("client-trace-1");
		vi.restoreAllMocks();
	});

	it("records a failed sample and rethrows when the inner handler throws", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const inner = {
			fetch: async () => {
				throw new Error("boom");
			},
		};
		await expect(withRequestTiming(inner).fetch(new Request("https://mcp.test/mcp"), {}, ctx)).rejects.toThrow("boom");
		const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
		expect(lines.find((l) => l.kind === "mcp.latency")).toMatchObject({ stage: "gateway", ok: false });
		expect(lines.find((l) => l.kind === "mcp.request")).toMatchObject({ status: 0 });
		log.mockRestore();
	});
});
