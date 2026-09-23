import { beforeEach, describe, expect, it, vi } from "vitest";

const { caps } = vi.hoisted(() => ({ caps: vi.fn() }));
vi.mock("../lib/agent-capabilities.js", () => ({ capabilitiesForInstance: caps }));
vi.mock("../lib/tool-registry.js", () => ({ getRegistryTool: vi.fn(), runRegistryTool: vi.fn() }));
vi.mock("../lib/events.js", () => ({ logEvent: vi.fn() }));

import { websiteBuilderBrokerRoutes } from "./website-builder-broker.js";
import { websiteBuilderTokenHash } from "../lib/website-builder-jobs.js";

const token = "a job-only token";
const job = async () => ({ id: "j1", instance_id: "i1", user_id: "u1", mcp_url: "https://fws.example/mcp", token_hash: await websiteBuilderTokenHash(token), status: "running", evidence: null });

function env() {
	return {
		DB: { prepare: () => ({ bind: () => ({ first: job, run: async () => ({}) }) }) },
	} as never;
}

describe("Website Builder broker", () => {
	beforeEach(() => caps.mockReset());

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
});
