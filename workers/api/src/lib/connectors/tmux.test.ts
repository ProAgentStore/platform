import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the runner transport BEFORE importing the connector — the tmux handlers reach
// the machine via getBoundRunnerConn + callRunner over the relay; we drive those.
// vi.hoisted so the fns exist when the hoisted vi.mock factory runs.
const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({
	getBoundRunnerConn: vi.fn(),
	callRunner: vi.fn(),
}));
vi.mock("../runner-client.js", () => ({
	getBoundRunnerConn,
	callRunner,
	READ_TIMEOUT_MS: 30_000,
}));

import { TMUX_TOOLS } from "./tmux.js";
import { getRegistryTool, registryConnectorGroups, registryToolNameSet, runRegistryTool } from "../tool-registry.js";
import type { Env } from "../../types.js";

const tool = (name: string) => {
	const t = TMUX_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`no tmux tool ${name}`);
	return t;
};
const ctx = (over: Record<string, unknown> = {}) =>
	({ env: {} as Env, userId: "u1", instanceId: "i1", agentId: "i1", ...over }) as never;

const FAKE_CONN = { kind: "relay" } as never;

beforeEach(() => {
	getBoundRunnerConn.mockReset();
	callRunner.mockReset();
	getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
	callRunner.mockResolvedValue({});
});

describe("tmux connector — registration", () => {
	it("registers all 6 tools with correct scopes (list/capture read; run/send/new/kill write)", () => {
		const names = registryToolNameSet();
		for (const n of ["tmux_list_sessions", "tmux_capture_pane", "tmux_run_command", "tmux_send_keys", "tmux_new_session", "tmux_kill_session"]) {
			expect(names.has(n)).toBe(true);
		}
		expect(getRegistryTool("tmux_list_sessions")?.scope).toBe("read");
		expect(getRegistryTool("tmux_capture_pane")?.scope).toBe("read");
		expect(getRegistryTool("tmux_run_command")?.scope).toBe("write");
		expect(getRegistryTool("tmux_send_keys")?.scope).toBe("write");
		expect(getRegistryTool("tmux_new_session")?.scope).toBe("write");
		expect(getRegistryTool("tmux_kill_session")?.scope).toBe("write");
	});

	it("groups the 6 tools under the tmux connector for the catalog", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "tmux");
		expect(grp?.tools).toEqual(
			expect.arrayContaining(["tmux_list_sessions", "tmux_capture_pane", "tmux_run_command", "tmux_send_keys", "tmux_new_session", "tmux_kill_session"]),
		);
	});
});

describe("tmux connector — runner resolution guards", () => {
	it("fails with a clear message when there is no instance/user context", async () => {
		const r = await tool("tmux_list_sessions").handler(ctx({ instanceId: undefined }), {});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/no instance context/i);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("tells the user to run `pags up` when no runner is connected", async () => {
		getBoundRunnerConn.mockResolvedValue(null);
		const r = await tool("tmux_run_command").handler(ctx(), { session: "s", command: "ls" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/pags up/);
		expect(callRunner).not.toHaveBeenCalled();
	});
});

describe("tmux connector — dispatch to the runner", () => {
	it("list_sessions calls /tmux/list and returns the sessions JSON", async () => {
		callRunner.mockResolvedValue({ sessions: [{ name: "main" }] });
		const r = await tool("tmux_list_sessions").handler(ctx(), {});
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/tmux/list", {}, expect.objectContaining({ timeoutMs: 30_000 }));
		expect(r.success).toBe(true);
		expect(JSON.parse(r.content)).toEqual([{ name: "main" }]);
	});

	it("capture_pane returns the pane text from /tmux/capture", async () => {
		callRunner.mockResolvedValue({ pane: "$ hello\n" });
		const r = await tool("tmux_capture_pane").handler(ctx(), { session: "main", lines: 50 });
		expect(callRunner).toHaveBeenCalled();
		expect(r.content).toBe("$ hello\n");
		expect(r.success).toBe(true);
	});

	it("run_command sends {session, command} to /tmux/run", async () => {
		callRunner.mockResolvedValue({ pane: "done" });
		const r = await tool("tmux_run_command").handler(ctx(), { session: "main", command: "npm test" });
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/tmux/run", { session: "main", command: "npm test" });
		expect(r.success).toBe(true);
	});

	it("run_command rejects an empty command WITHOUT calling the runner", async () => {
		const r = await tool("tmux_run_command").handler(ctx(), { session: "main", command: "   " });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/command.*required/i);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("send_keys forwards text + keys to /tmux/send", async () => {
		await tool("tmux_send_keys").handler(ctx(), { session: "main", text: "y", keys: "Enter" });
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/tmux/send", expect.objectContaining({ session: "main", text: "y" }));
	});

	it("send_keys rejects when neither text nor keys is provided", async () => {
		const r = await tool("tmux_send_keys").handler(ctx(), { session: "main" });
		expect(r.success).toBe(false);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("new_session creates via /tmux/session action:create and reports existing", async () => {
		callRunner.mockResolvedValue({ existed: true });
		const r = await tool("tmux_new_session").handler(ctx(), { session: "build" });
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/tmux/session", expect.objectContaining({ action: "create", session: "build" }));
		expect(r.content).toMatch(/already exists/i);
	});

	it("kill_session sends action:kill and reports success vs not-found from res.killed", async () => {
		callRunner.mockResolvedValue({ killed: true });
		const ok = await tool("tmux_kill_session").handler(ctx(), { session: "build" });
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/tmux/session", expect.objectContaining({ action: "kill", session: "build" }));
		expect(ok.success).toBe(true);
		expect(ok.content).toMatch(/killed/i);

		callRunner.mockResolvedValue({ killed: false });
		const miss = await tool("tmux_kill_session").handler(ctx(), { session: "gone" });
		expect(miss.success).toBe(false);
		expect(miss.content).toMatch(/no tmux session/i);
	});
});

describe("tmux connector — write-consent gate (runRegistryTool)", () => {
	const envConsent = (granted: boolean) =>
		({
			DB: { prepare() { return { bind() { return { first: async () => (granted ? { ok: 1 } : null) }; } }; } },
		}) as unknown as Env;

	it("blocks a write tool (tmux_run_command) when consent is NOT granted", async () => {
		const r = await runRegistryTool("tmux_run_command", { env: envConsent(false), userId: "u1", agentId: "i1", instanceId: "i1" }, { session: "s", command: "ls" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/consent|allow|enable/i);
		expect(callRunner).not.toHaveBeenCalled(); // gated before the handler runs
	});

	it("allows a read tool (tmux_list_sessions) without consent", async () => {
		callRunner.mockResolvedValue({ sessions: [] });
		const r = await runRegistryTool("tmux_list_sessions", { env: envConsent(false), userId: "u1", agentId: "i1", instanceId: "i1" }, {});
		expect(r.success).toBe(true);
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/tmux/list", {}, expect.anything());
	});
});
