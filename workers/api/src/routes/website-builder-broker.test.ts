import { beforeEach, describe, expect, it, vi } from "vitest";

const { caps, events, registry, run } = vi.hoisted(() => ({ caps: vi.fn(), events: vi.fn(), registry: vi.fn(), run: vi.fn() }));
vi.mock("../lib/agent-capabilities.js", () => ({ capabilitiesForInstance: caps }));
vi.mock("../lib/tool-registry.js", () => ({ getRegistryTool: registry, runRegistryTool: run }));
vi.mock("../lib/events.js", () => ({ logEvent: events }));

import { websiteBuilderBrokerRoutes } from "./website-builder-broker.js";
import { websiteBuilderTokenHash } from "../lib/website-builder-jobs.js";

const token = "a job-only token";
const job = async (extra: Record<string, unknown> = {}) => ({
	id: "j1", instance_id: "i1", user_id: "u1", mcp_url: "https://fws.example/mcp", token_hash: await websiteBuilderTokenHash(token),
	token_expires_at: "2099-01-01 00:00:00", token_revoked_at: null, fws_session_id: null, create_started_at: null, noindex_confirmed: 0,
	status: "running", evidence: null, ...extra,
});

function env(extra: Record<string, unknown> = {}, writes: Array<{ sql: string; args: unknown[] }> = []) {
	return {
		DB: { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ first: () => job(extra), run: async () => { writes.push({ sql, args }); return { meta: { changes: 1 } }; } }) }) },
	} as never;
}

describe("Website Builder broker", () => {
	beforeEach(() => {
		caps.mockReset(); events.mockReset(); registry.mockReset(); run.mockReset();
		registry.mockReturnValue({ name: "mcp_call_tool" });
		caps.mockResolvedValue({ tools: ["mcp_call_tool"] });
		events.mockResolvedValue(undefined);
		run.mockResolvedValue({ success: true, content: JSON.stringify({ tool: "set_meta", data: {} }) });
	});

	it("rejects deploy before any connector or grant call", async () => {
		const res = await websiteBuilderBrokerRoutes.request("/j1/call", { method: "POST", headers: { "content-type": "application/json", "X-Pags-Website-Builder-Token": token }, body: JSON.stringify({ tool: "deploy", args: {} }) }, env());
		expect(res.status).toBe(403);
		expect(caps).not.toHaveBeenCalled();
	});

	it("honours a revoked mcp_call_tool declaration on every call", async () => {
		caps.mockResolvedValue({ tools: ["http_request"] });
		const res = await websiteBuilderBrokerRoutes.request("/j1/call", { method: "POST", headers: { "content-type": "application/json", "X-Pags-Website-Builder-Token": token }, body: JSON.stringify({ tool: "create_site", args: {} }) }, env());
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: expect.stringContaining("no longer permits") });
	});

	it("binds every session tool to PAGS's one observed FWS session", async () => {
		const res = await websiteBuilderBrokerRoutes.request("/j1/call", { method: "POST", headers: { "content-type": "application/json", "X-Pags-Website-Builder-Token": token }, body: JSON.stringify({ tool: "capture_preview", args: { session_id: "other-session", viewport: "desktop" } }) }, env({ fws_session_id: "fws-1", noindex_confirmed: 1 }));
		expect(res.status).toBe(403);
		expect(run).not.toHaveBeenCalled();
	});

	it("requires noindex before it permits a session operation", async () => {
		const res = await websiteBuilderBrokerRoutes.request("/j1/call", { method: "POST", headers: { "content-type": "application/json", "X-Pags-Website-Builder-Token": token }, body: JSON.stringify({ tool: "get_quality_report", args: {} }) }, env({ fws_session_id: "fws-1", noindex_confirmed: 0 }));
		expect(res.status).toBe(403);
		expect(run).not.toHaveBeenCalled();
	});

	it("forces the bound session id instead of trusting the worker's omitted argument", async () => {
		const res = await websiteBuilderBrokerRoutes.request("/j1/call", { method: "POST", headers: { "content-type": "application/json", "X-Pags-Website-Builder-Token": token }, body: JSON.stringify({ tool: "capture_preview", args: { viewport: "desktop" } }) }, env({ fws_session_id: "fws-1", noindex_confirmed: 1 }));
		expect(res.status).toBe(200);
		expect(run).toHaveBeenCalledWith("mcp_call_tool", expect.anything(), expect.objectContaining({ args: { session_id: "fws-1", viewport: "desktop" } }));
	});

	it("records broker-observed capture metadata, not a worker assertion", async () => {
		const writes: Array<{ sql: string; args: unknown[] }> = [];
		run.mockResolvedValue({ success: true, content: JSON.stringify({ tool: "capture_preview", data: { session_id: "fws-1", preview_url: "https://fws.example/session/fws-1/preview", viewport: "desktop", width: 1440, height: 900, mime_type: "image/jpeg" } }) });
		const res = await websiteBuilderBrokerRoutes.request("/j1/call", { method: "POST", headers: { "content-type": "application/json", "X-Pags-Website-Builder-Token": token }, body: JSON.stringify({ tool: "capture_preview", args: { viewport: "desktop" } }) }, env({ fws_session_id: "fws-1", noindex_confirmed: 1 }, writes));
		expect(res.status).toBe(200);
		const stored = writes.find((write) => write.sql.includes("website_builder_job_calls"));
		expect(JSON.parse(String(stored?.args[5]))).toMatchObject({ source: "pags.website_builder_broker", session_id: "fws-1", preview_url: "https://fws.example/session/fws-1/preview", viewport: "desktop", mime_type: "image/jpeg" });
	});

	it("never retries create_site after it has been claimed", async () => {
		const res = await websiteBuilderBrokerRoutes.request("/j1/call", { method: "POST", headers: { "content-type": "application/json", "X-Pags-Website-Builder-Token": token }, body: JSON.stringify({ tool: "create_site", args: { template_slug: "neon-ai" } }) }, env({ create_started_at: "2026-09-24 00:00:00" }));
		expect(res.status).toBe(403);
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects a terminally revoked or expired capability before contacting FWS", async () => {
		const res = await websiteBuilderBrokerRoutes.request("/j1/call", { method: "POST", headers: { "content-type": "application/json", "X-Pags-Website-Builder-Token": token }, body: JSON.stringify({ tool: "list_templates", args: {} }) }, env({ token_expires_at: "2000-01-01 00:00:00" }));
		expect(res.status).toBe(401);
		expect(run).not.toHaveBeenCalled();
	});
});
