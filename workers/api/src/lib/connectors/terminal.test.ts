import { beforeEach, describe, expect, it, vi } from "vitest";

const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({
	getBoundRunnerConn: vi.fn(),
	callRunner: vi.fn(),
}));
vi.mock("../runner-client.js", () => ({
	getBoundRunnerConn,
	callRunner,
	READ_TIMEOUT_MS: 30_000,
}));

import { TERMINAL_TOOLS } from "./terminal.js";
import { getRegistryTool, registryConnectorGroups, registryToolNameSet, runRegistryTool } from "../tool-registry.js";
import type { Env } from "../../types.js";

const tool = (name: string) => {
	const t = TERMINAL_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`no terminal tool ${name}`);
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

describe("terminal connector — registration", () => {
	it("registers generic terminal tools with correct scopes", () => {
		const names = registryToolNameSet();
		for (const n of ["terminal_list_targets", "terminal_capture", "terminal_run_command", "terminal_send_keys", "terminal_new_target", "terminal_kill_target"]) {
			expect(names.has(n)).toBe(true);
		}
		expect(getRegistryTool("terminal_list_targets")?.scope).toBe("read");
		expect(getRegistryTool("terminal_capture")?.scope).toBe("read");
		expect(getRegistryTool("terminal_run_command")?.scope).toBe("write");
		expect(getRegistryTool("terminal_send_keys")?.scope).toBe("write");
		expect(getRegistryTool("terminal_new_target")?.scope).toBe("write");
		expect(getRegistryTool("terminal_kill_target")?.scope).toBe("write");
	});

	it("groups terminal tools under the terminal connector", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "terminal");
		expect(grp?.tools).toEqual(expect.arrayContaining(["terminal_list_targets", "terminal_run_command"]));
	});
});

describe("terminal connector — runner dispatch", () => {
	it("lists all terminal targets through /terminal/list", async () => {
		callRunner.mockResolvedValue({ targets: [{ backend: "tmux", id: "main" }] });
		const r = await tool("terminal_list_targets").handler(ctx(), {});
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/list", { backend: "all" }, expect.objectContaining({ timeoutMs: 30_000 }));
		expect(JSON.parse(r.content)).toEqual([{ backend: "tmux", id: "main" }]);
	});

	it("captures a prefixed target", async () => {
		callRunner.mockResolvedValue({ pane: "hello" });
		const r = await tool("terminal_capture").handler(ctx(), { target: "tmux:main", lines: 20 });
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/capture", { target: "tmux:main", backend: undefined, lines: 20 }, expect.objectContaining({ timeoutMs: 30_000 }));
		expect(r.content).toBe("hello");
	});

	it("runs a command in the selected backend", async () => {
		callRunner.mockResolvedValue({ pane: "ok" });
		const r = await tool("terminal_run_command").handler(ctx(), { target: "1", backend: "kitty", command: "pwd" });
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/run", { target: "1", backend: "kitty", command: "pwd" });
		expect(r.success).toBe(true);
	});

	it("rejects empty writes before touching the runner", async () => {
		const r = await tool("terminal_run_command").handler(ctx(), { target: "tmux:main", command: "  " });
		expect(r.success).toBe(false);
		expect(callRunner).not.toHaveBeenCalled();
	});
});

describe("terminal connector — write consent", () => {
	const envConsent = (granted: boolean) =>
		({
			DB: { prepare() { return { bind() { return { first: async () => (granted ? { ok: 1 } : null) }; } }; } },
		}) as unknown as Env;

	it("blocks writes without terminal consent", async () => {
		const r = await runRegistryTool("terminal_run_command", { env: envConsent(false), userId: "u1", instanceId: "i1" }, { target: "tmux:main", command: "ls" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/terminal.*permitted|write access/i);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("allows reads without terminal consent", async () => {
		callRunner.mockResolvedValue({ targets: [] });
		const r = await runRegistryTool("terminal_list_targets", { env: envConsent(false), userId: "u1", instanceId: "i1" }, {});
		expect(r.success).toBe(true);
		expect(callRunner).toHaveBeenCalled();
	});
});
