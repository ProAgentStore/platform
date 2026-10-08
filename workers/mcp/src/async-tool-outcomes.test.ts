import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodingSessionTools } from "./coding-tools.js";
import type { TextResult } from "./http.js";
import { registerBaseTools } from "./instance-tools/base.js";
import { registerMachineControlTools } from "./instance-tools/machine-control.js";
import { registerRuntimeTools } from "./instance-tools/runtime.js";
import type { InstanceToolsCtx } from "./instance-tools/shared.js";

type Handler = (input: Record<string, unknown>) => Promise<TextResult>;
function handlers() {
	const tools = new Map<string, Handler>();
	const server = { tool: (name: string, _description: string, _schema: unknown, handler: Handler) => tools.set(name, handler) } as unknown as McpServer;
	const ctx: InstanceToolsCtx = { env: { API_BASE: "https://api.test" }, tokenFor: () => "token", safetyFor: () => ({ env: {}, subject: "u1", scopes: ["read", "write", "runtime", "destructive"] }), groups: new Set(["coding"]) };
	registerRuntimeTools(server, ctx);
	registerBaseTools(server, ctx);
	registerMachineControlTools(server, ctx);
	registerCodingSessionTools(server, ctx.env, ctx.tokenFor, ctx.safetyFor);
	return tools;
}
afterEach(() => vi.unstubAllGlobals());

describe("async tools retain actionable outcomes", () => {
	it.each([
		["set_instance_runner_node", { instance_id: "i1", runner_node: "mac" }, { runnerNode: "mac", attachment: { unconfirmed: true, attached: false } }],
		["force_runner_attach", { instance_id: "i1" }, { attached: false, evicted: true, detail: "attaching" }],
		["runner_update", { runner_node: "mac" }, { action: "scheduled", waitingFor: ["busy-session"] }],
		["coding_repo_add", { instance_id: "i1", path: "~/repo", github_repo: "acme/repo", clone: true }, { cloning: true, job: "job-1", detail: "still cloning" }],
	] as const)("%s preserves a confirmed partial response", async (tool, input, reply) => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(reply), { status: 202 }));
		const result = await handlers().get(tool)?.(input);
		expect(JSON.parse(result?.content[0].text ?? "{}")).toEqual(reply);
	});

	it.each([
		["pause_instance", { instance_id: "i1" }, "my_instances"],
		["coding_repo_remove", { instance_id: "i1", repo_id: "repo-1", confirm: "coding_repo_remove" }, "coding_repos_list"],
		["set_instance_runner_node", { instance_id: "i1", runner_node: "mac" }, "instance_runner_node"],
		["force_runner_attach", { instance_id: "i1", runner_node: "mac" }, "instance_runner_node"],
		// #990: the poll hint is the DURABLE read now — `list_runner_nodes` carries the same
		// operation on the machine's row, but this tool is the one that answers for one machine.
		["runner_update", { runner_node: "mac" }, "runner_update_status"],
		["coding_repo_add", { instance_id: "i1", path: "~/repo", github_repo: "acme/repo", clone: true }, "coding_repos_list"],
	] as const)("%s supplies polling guidance when its mutation reply is lost", async (tool, input, pollTool) => {
		const fetch = vi.fn().mockRejectedValue(new Error("connection lost"));
		vi.stubGlobal("fetch", fetch);
		const result = await handlers().get(tool)?.(input);
		const payload = JSON.parse(result?.content[0].text ?? "{}");
		expect(payload).toMatchObject({ outcome: "unknown", tool, poll: { tool: pollTool } });
		expect(payload.possibleOutcomes.length).toBeGreaterThan(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		if (tool === "coding_repo_add") expect(payload.retry).toEqual({ tool, input });
	});

	it.each([
		["force_runner_attach", { instance_id: "i1" }, "instance_runner_node"],
		// #990: the poll hint is the DURABLE read now — `list_runner_nodes` carries the same
		// operation on the machine's row, but this tool is the one that answers for one machine.
		["runner_update", { runner_node: "mac" }, "runner_update_status"],
	] as const)("%s returns gateway failure detail instead of a bare MCP exception (#901)", async (tool, input, pollTool) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Relay command timed out", { status: 504 })));
		const result = await handlers().get(tool)?.(input);
		const payload = JSON.parse(result?.content[0].text ?? "{}");
		expect(payload).toMatchObject({ outcome: "unknown", tool, confirmation: { reason: "gateway-error", httpStatus: 504 }, poll: { tool: pollTool } });
		expect(payload.detail).toContain(pollTool);
		expect(payload.detail).toContain("does not prove failure");
	});
	it.each(["coding_session_end", "coding_session_fresh"])("%s stops after an unconfirmed end rather than claiming success or starting another session", async (tool) => {
		const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [{ id: "session-1", status: "active", repoId: "repo-1" }] }))).mockRejectedValue(new Error("reply lost"));
		vi.stubGlobal("fetch", fetch);
		const result = await handlers().get(tool)?.({ instance_id: "i1" });
		expect(JSON.parse(result?.content[0].text ?? "{}")).toMatchObject({ outcome: "unknown", poll: { tool: "coding_sessions_list", input: { instance_id: "i1" } } });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
