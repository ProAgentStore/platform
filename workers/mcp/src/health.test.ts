import { describe, expect, it } from "vitest";
import { probeHealth, renderStatusHtml } from "./health.js";
import { newLatencyRing } from "./latency.js";
import { MCP_SERVER_VERSION } from "./server-version.js";

// #198: the one measurement behind `platform_health` and `/status`.

function fetchStub(routes: Record<string, { status?: number; body?: unknown; delayMs?: number; throws?: boolean }>) {
	const calls: string[] = [];
	const impl = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push(url);
		const key = Object.keys(routes).find((k) => url.startsWith(k));
		const r = key ? routes[key] : undefined;
		if (!r) throw new Error(`unexpected fetch ${url}`);
		if (r.throws) throw new Error("network down");
		return new Response(JSON.stringify(r.body ?? { ok: true }), { status: r.status ?? 200 });
	}) as unknown as typeof fetch;
	return { impl, calls };
}

const GH_OK = { body: { status: { indicator: "none" } } };
const env = { API_BASE: "https://api.test", SESSION_SIGNING_KEY: "k" };

describe("probeHealth", () => {
	it("probes the API and GitHub status, measures nothing for auth without a session, and names no tenant", async () => {
		const { impl, calls } = fetchStub({ "https://api.test/health": { body: { ok: true } }, "https://www.githubstatus.com": GH_OK });
		const report = await probeHealth({ env, fetchImpl: impl, ring: newLatencyRing() });
		expect(calls).toEqual(["https://api.test/health", "https://www.githubstatus.com/api/v2/status.json"]);
		expect(report.ok).toBe(true);
		expect(report.service).toBe("proagentstore-mcp");
		expect(report.version).toBe(MCP_SERVER_VERSION);
		expect(report.traceId).toMatch(/^[0-9a-f-]{36}$/);
		expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(report.components.auth.status).toBe("unauthenticated");
		expect(report.components.state).toMatchObject({ status: "ok", probe: "GET /health on the API worker" });
		expect(report.components.connectors.github.status).toBe("ok");
		expect(report.components.runner.status).toBe("unknown");
		expect(report.components.coding_loop.status).toBe("unknown");
		// Every stage is reported against its budget even when empty.
		expect(Object.keys(report.recent).sort()).toEqual(["api", "auth", "connector", "gateway", "state", "tool"]);
		expect(report.recent.tool.budgetMs).toBe(5_000);
		const text = JSON.stringify(report);
		// No credential-shaped KEY anywhere in the report (the prose may say the word "secret").
		expect(text).not.toMatch(/"(token|secret|authorization|session)":/i);
	});

	it("marks the API down when it fails, and the whole report not ok", async () => {
		const { impl } = fetchStub({ "https://api.test/health": { throws: true }, "https://www.githubstatus.com": GH_OK });
		const report = await probeHealth({ env, fetchImpl: impl, ring: newLatencyRing() });
		expect(report.components.state.status).toBe("down");
		expect(report.components.state.detail).toContain("did not answer");
		expect(report.ok).toBe(false);
	});

	it("marks a component degraded when its probe is slow, using the injected clock", async () => {
		let t = 0;
		const now = () => t;
		const { impl } = fetchStub({ "https://api.test/health": { body: {} }, "https://www.githubstatus.com": GH_OK });
		const slow = (async (input: string | URL | Request) => {
			t += 2_500; // over the 2 s `state` budget, under the 8 s connector budget
			return impl(input);
		}) as unknown as typeof fetch;
		const report = await probeHealth({ env, fetchImpl: slow, ring: newLatencyRing(), now });
		expect(report.components.state).toMatchObject({ status: "degraded", ms: 2_500 });
		expect(report.components.connectors.github.status).toBe("ok");
		expect(report.ok).toBe(false);
	});

	it("reads GitHub's own indicator: a non-none indicator is a degraded connector", async () => {
		const { impl } = fetchStub({ "https://api.test/health": { body: {} }, "https://www.githubstatus.com": { body: { status: { indicator: "major" } } } });
		const report = await probeHealth({ env, fetchImpl: impl, ring: newLatencyRing() });
		expect(report.components.connectors.github.status).toBe("degraded");
		expect(report.components.connectors.github.detail).toContain("major");
	});

	it("measures auth from the session when one is given, without a network call", async () => {
		const { impl, calls } = fetchStub({ "https://api.test/health": { body: {} }, "https://www.githubstatus.com": GH_OK });
		const bad = await probeHealth({ env, token: "not.a-session", fetchImpl: impl, ring: newLatencyRing() });
		expect(bad.components.auth.status).toBe("degraded");
		expect(bad.components.auth.probe).toBe("verifyMcpSession");
		expect(calls.filter((u) => !u.includes("/health") && !u.includes("githubstatus"))).toEqual([]);
		const noKey = await probeHealth({ env: { API_BASE: "https://api.test" }, token: "x.y", fetchImpl: impl, ring: newLatencyRing() });
		expect(noKey.components.auth.status).toBe("down");
	});

	it("derives runner and coding-loop verdicts from the session's recent tool samples", async () => {
		const ring = newLatencyRing();
		for (let i = 0; i < 5; i++) ring.record({ stage: "tool", name: "coding_loop_status", ms: 21_000, ok: false });
		for (let i = 0; i < 5; i++) ring.record({ stage: "tool", name: "instance_runtime_status", ms: 120, ok: true });
		const { impl } = fetchStub({ "https://api.test/health": { body: {} }, "https://www.githubstatus.com": GH_OK });
		const report = await probeHealth({ env, fetchImpl: impl, ring });
		expect(report.components.coding_loop.status).toBe("degraded");
		expect(report.components.coding_loop.recent?.p95).toBe(21_000);
		expect(report.components.runner.status).toBe("ok");
		expect(report.recent.tool.count).toBe(10);
	});
});

describe("renderStatusHtml", () => {
	it("renders every component, the budgets and the scope note, escaped, with no script", async () => {
		const { impl } = fetchStub({ "https://api.test/health": { body: {} }, "https://www.githubstatus.com": GH_OK });
		const report = await probeHealth({ env, fetchImpl: impl, ring: newLatencyRing(), traceId: "<img src=x onerror=alert(1)>" });
		const html = renderStatusHtml(report);
		expect(html).toContain("<!doctype html>");
		expect(html).not.toContain("<script");
		for (const label of ["MCP gateway", "Authentication", "Account / state hydration", "Local-runner dispatch", "Coding-loop orchestration", "Connector: GitHub"]) expect(html).toContain(label);
		expect(html).toContain("Latency budgets");
		expect(html).toContain("platform_health");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});
});
