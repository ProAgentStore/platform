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
import { getRegistryTool, registryConnectorGroups, registryToolNameSet, renderToolContent, runRegistryTool } from "../tool-registry.js";
import { CONNECTOR_CONSTRAINTS } from "../surface-options.js";
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
		for (const n of ["terminal_list_targets", "terminal_capture", "terminal_run_command", "terminal_send_keys", "terminal_send_message", "terminal_new_target", "terminal_kill_target"]) {
			expect(names.has(n)).toBe(true);
		}
		expect(getRegistryTool("terminal_list_targets")?.scope).toBe("read");
		expect(getRegistryTool("terminal_capture")?.scope).toBe("read");
		expect(getRegistryTool("terminal_run_command")?.scope).toBe("write");
		expect(getRegistryTool("terminal_send_keys")?.scope).toBe("write");
		expect(getRegistryTool("terminal_send_message")?.scope).toBe("write");
		expect(getRegistryTool("terminal_new_target")?.scope).toBe("write");
		expect(getRegistryTool("terminal_kill_target")?.scope).toBe("write");
	});

	it("groups terminal tools under the terminal connector", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "terminal");
		expect(grp?.tools).toEqual(expect.arrayContaining(["terminal_list_targets", "terminal_run_command", "terminal_send_message"]));
	});

	it("the constraint vocabulary matches the tools' own schemas — two lists that must not drift", () => {
		// `CONNECTOR_CONSTRAINTS.terminal.backends` is what a creator may declare and what the gate
		// enforces; the schema enums are what the model is offered. A backend added to one and not
		// the other is either an unreachable declaration or an unconstrained argument.
		const def = CONNECTOR_CONSTRAINTS.terminal.backends;
		// A VALUE ceiling is what this test is about: `wildcard`/`values` only exist on that variant,
		// so narrow rather than cast — if `backends` is ever re-declared as a binding, this fails loudly.
		if (def.kind !== "values") throw new Error("CONNECTOR_CONSTRAINTS.terminal.backends must be a value ceiling");
		expect(getRegistryTool("terminal_list_targets")?.jsonSchema.properties.backend.enum).toEqual([def.wildcard, ...def.values]);
		expect(getRegistryTool("terminal_new_target")?.jsonSchema.properties.backend.enum).toEqual([...def.values]);
		for (const name of ["terminal_capture", "terminal_run_command", "terminal_send_keys", "terminal_send_message", "terminal_kill_target"]) {
			expect(getRegistryTool(name)?.jsonSchema.properties.backend.enum, name).toEqual([...def.values]);
		}
		// And the argument it governs is one every terminal tool actually takes.
		for (const t of TERMINAL_TOOLS) expect(t.jsonSchema.properties, t.name).toHaveProperty(def.arg);
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

	it("sends text and key arrays through /terminal/send", async () => {
		callRunner.mockResolvedValue({ pane: "sent" });
		const r = await tool("terminal_send_keys").handler(ctx(), { target: "tmux:main", text: "echo hi", keys: ["Enter"] });
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/send", { target: "tmux:main", backend: undefined, text: "echo hi", keys: ["Enter"] });
		expect(r.success).toBe(true);
		expect(r.content).toBe("sent");
	});

	it("rejects empty writes before touching the runner", async () => {
		const r = await tool("terminal_run_command").handler(ctx(), { target: "tmux:main", command: "  " });
		expect(r.success).toBe(false);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("send_message types text + Enter via /terminal/send and returns the post-settle pane", async () => {
		callRunner.mockResolvedValue({ pane: "output\n", paneBefore: "> ", changed: true });
		const r = await tool("terminal_send_message").handler(ctx(), { target: "tmux:main", message: "explain this" });
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/send", { target: "tmux:main", backend: undefined, text: "explain this", keys: ["Enter"] });
		expect(r.success).toBe(true);
		expect(r.content).toContain("output\n");
	});

	it("send_message returns success:false and a warning when changed=false (CLI not ready)", async () => {
		callRunner.mockResolvedValue({ pane: "> waiting", paneBefore: "> waiting", changed: false });
		// The warning is OURS about the pane, so it rides in `tail` outside the fence (#752) —
		// read at the dispatch seam, which is where the model sees it.
		const t = tool("terminal_send_message");
		const raw = await t.handler(ctx(), { target: "tmux:main", message: "hello" });
		const r = { ...raw, content: renderToolContent(t, raw) };
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/pane did not change/);
		expect(r.content).toMatch(/input prompt/);
	});

	it("send_message rejects an empty message without calling the runner", async () => {
		const r = await tool("terminal_send_message").handler(ctx(), { target: "tmux:main", message: "" });
		expect(r.success).toBe(false);
		expect(callRunner).not.toHaveBeenCalled();
	});
});

describe("terminal connector — write consent", () => {
	/**
	 * Consent answers as asked; the CONSTRAINT join always finds the instance and it declares no
	 * ceiling. The two must be told apart (#441): since the constraint gate fails closed on a row it
	 * cannot locate, a fixture that answered `null` to every query would refuse these calls for a
	 * reason that has nothing to do with consent — which is the thing under test here.
	 */
	const envConsent = (granted: boolean) =>
		({
			DB: {
				prepare(sql: string) {
					const constraintQuery = sql.includes("agent_instances");
					return { bind() { return { first: async () => (constraintQuery ? { agent_config: "{}", instance_config: "{}" } : granted ? { ok: 1 } : null) }; } };
				},
			},
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

/**
 * The backend ceiling, enforced where it has to be: at DISPATCH.
 *
 * These go through `runRegistryTool`, not through a handler and not through the console, because
 * that is the claim under test — a constraint the model can talk around is not a constraint
 * (ADR 0001, #395). Every one of them asserts the runner was never reached.
 */
describe("terminal connector — the backend ceiling (#404)", () => {
	/** An owner whose agent declares `backends`, and whose write-consent answer we choose. */
	const env = (backends: string[] | null, consent = true) =>
		({
			DB: {
				prepare(sql: string) {
					const constraintQuery = sql.includes("agent_instances");
					return {
						bind() {
							return {
								first: async () =>
									constraintQuery
										? {
												agent_config: JSON.stringify({
													capabilities: { surfaces: ["tmux"], ...(backends ? { surfaceOptions: { terminal: { backends } } } : {}) },
												}),
												instance_config: "{}",
											}
										: consent
											? { ok: 1 }
											: null,
							};
						},
					};
				},
			},
		}) as unknown as Env;

	it("refuses an out-of-scope backend BEFORE the runner is touched", async () => {
		const r = await runRegistryTool("terminal_capture", { env: env(["tmux"]), userId: "u1", instanceId: "i1" }, { target: "1", backend: "iterm2" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("`terminal.backends` (tmux)");
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("refuses a target that names an out-of-scope backend by prefix", async () => {
		// The way the tool is actually driven: a prefixed target and no `backend` at all. This is
		// the call that made a "tmux Operator" report two iTerm2 windows (#402).
		const r = await runRegistryTool("terminal_capture", { env: env(["tmux"]), userId: "u1", instanceId: "i1" }, { target: "iterm2:1:1:1" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("iterm2:1:1:1");
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("CONSENT AND CONSTRAINTS COMPOSE — write consent granted, argument out of scope, still refused", async () => {
		// Consent asks *may this instance mutate at all*; a constraint asks *within what*. Passing
		// the first has never been an answer to the second.
		const r = await runRegistryTool("terminal_run_command", { env: env(["tmux"], true), userId: "u1", instanceId: "i1" }, { target: "3", backend: "kitty", command: "rm -rf /" });
		expect(r.success).toBe(false);
		expect(r.content).not.toMatch(/isn't permitted/i);
		expect(r.content).toContain("`terminal.backends` (tmux)");
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("narrows a defaulted `backend` to the declared one, so listing returns only tmux", async () => {
		callRunner.mockResolvedValue({ targets: [] });
		await runRegistryTool("terminal_list_targets", { env: env(["tmux"]), userId: "u1", instanceId: "i1" }, {});
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/list", { backend: "tmux" }, expect.anything());
	});

	it("passes an in-scope call straight through", async () => {
		callRunner.mockResolvedValue({ pane: "hi" });
		const r = await runRegistryTool("terminal_capture", { env: env(["tmux"]), userId: "u1", instanceId: "i1" }, { target: "tmux:main" });
		expect(r.success).toBe(true);
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/capture", { target: "tmux:main", backend: "tmux", lines: undefined }, expect.anything());
	});

	it("AN AGENT THAT DECLARES NOTHING IS UNCHANGED — still `all`, still reaches every backend", async () => {
		// The regression that would be invisible: this is every agent on the platform today.
		callRunner.mockResolvedValue({ targets: [] });
		await runRegistryTool("terminal_list_targets", { env: env(null), userId: "u1", instanceId: "i1" }, {});
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/list", { backend: "all" }, expect.anything());

		callRunner.mockResolvedValue({ pane: "hi" });
		const r = await runRegistryTool("terminal_capture", { env: env(null), userId: "u1", instanceId: "i1" }, { target: "iterm2:1:1:1" });
		expect(r.success).toBe(true);
	});

	it("fails CLOSED when the constraints cannot be read at all", async () => {
		const broken = { DB: { prepare() { return { bind() { return { first: async () => { throw new Error("D1 down"); } }; } }; } } } as unknown as Env;
		const r = await runRegistryTool("terminal_list_targets", { env: broken, userId: "u1", instanceId: "i1" }, {});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/could not be read/i);
		expect(callRunner).not.toHaveBeenCalled();
	});
});

/**
 * The single-target BINDING (#402), asserted at the dispatcher for the same reason the backend
 * ceiling is: the console is not where this holds. The creator declares `targets: "single"` in
 * capabilities; the subscriber binds WHICH target in the instance config, the way `runnerNode`
 * binds which machine — and the two are merged and enforced in `runRegistryTool`.
 */
describe("terminal connector — the single-target binding (#402)", () => {
	/** An agent config and an instance config, exactly as the merge reads them out of D1. */
	const env = (agent: Record<string, unknown> | null, instance: Record<string, unknown> | null) =>
		({
			DB: {
				prepare(sql: string) {
					const constraintQuery = sql.includes("agent_instances");
					return {
						bind() {
							return {
								first: async () =>
									constraintQuery
										? {
												agent_config: JSON.stringify({ capabilities: { surfaces: ["tmux"], ...(agent ? { surfaceOptions: { terminal: agent } } : {}) } }),
												instance_config: JSON.stringify(instance ? { surfaceOptions: { terminal: instance } } : {}),
											}
										: { ok: 1 },
							};
						},
					};
				},
			},
		}) as unknown as Env;

	it("A SUBSCRIBER BINDS A TARGET WITHIN THE CEILING, and the call goes through", async () => {
		callRunner.mockResolvedValue({ pane: "hi" });
		const r = await runRegistryTool(
			"terminal_capture",
			{ env: env({ backends: ["tmux"], targets: "single" }, { boundTarget: "tmux:main" }), userId: "u1", instanceId: "i1" },
			{ target: "tmux:main" },
		);
		expect(r.success).toBe(true);
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/capture", { target: "tmux:main", backend: "tmux", lines: undefined }, expect.anything());
	});

	it("A CALL NAMING A NON-BOUND TARGET IS REFUSED, and the runner is never reached", async () => {
		// The acceptance test, and the whole argument of the ticket: a constraint that only hides a
		// control in the console is walked straight through by the first confidently-wrong model
		// call. `terminal_run_command` is a WRITE — this is a shell command on the owner's machine.
		const r = await runRegistryTool(
			"terminal_run_command",
			{ env: env({ backends: ["tmux"], targets: "single" }, { boundTarget: "tmux:main" }), userId: "u1", instanceId: "i1" },
			{ target: "tmux:prod", command: "rm -rf ." },
		);
		expect(r.success).toBe(false);
		expect(r.content).toContain("`terminal.targets` (single)");
		expect(r.content).toContain("tmux:main");
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("A SUBSCRIBER CANNOT WIDEN THE BACKENDS — the instance's own request is dropped", async () => {
		// The ceiling is a catalog claim: `lintAgentClaims` (#362) checks a description against
		// capabilities, so an instance that could widen it would make the agent's own description
		// false by configuration. Asserted at the dispatcher, not only at the resolver.
		const r = await runRegistryTool(
			"terminal_capture",
			{ env: env({ backends: ["tmux"] }, { backends: ["tmux", "kitty", "iterm2"] }), userId: "u1", instanceId: "i1" },
			{ target: "iterm2:1:1:1" },
		);
		expect(r.success).toBe(false);
		expect(r.content).toContain("`terminal.backends` (tmux)");
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("cannot smuggle a binding outside the ceiling in through the instance config either", async () => {
		// Bound to iTerm2 on a tmux-only agent: the binding is dropped by the merge, and what is
		// left is `single` with nothing bound — which refuses. Never "iTerm2 is fine after all".
		const r = await runRegistryTool(
			"terminal_capture",
			{ env: env({ backends: ["tmux"], targets: "single" }, { boundTarget: "iterm2:1:1:1" }), userId: "u1", instanceId: "i1" },
			{ target: "iterm2:1:1:1" },
		);
		expect(r.success).toBe(false);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("fills an omitted target from the binding, so the model never has to carry it", async () => {
		callRunner.mockResolvedValue({ pane: "hi" });
		await runRegistryTool(
			"terminal_capture",
			{ env: env({ targets: "single" }, { boundTarget: "tmux:main" }), userId: "u1", instanceId: "i1" },
			{},
		);
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/capture", { target: "tmux:main", backend: undefined, lines: undefined }, expect.anything());
	});

	it("lets an unbound single-target agent LIST — the one call that has to keep working", async () => {
		callRunner.mockResolvedValue({ targets: [] });
		const r = await runRegistryTool("terminal_list_targets", { env: env({ targets: "single" }, null), userId: "u1", instanceId: "i1" }, {});
		expect(r.success).toBe(true);
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/list", { backend: "all" }, expect.anything());
	});

	it("AN AGENT THAT DECLARES NEITHER HALF IS BYTE-IDENTICAL TO TODAY", async () => {
		// Every agent on the platform right now, including the generic Terminal Operator, which
		// MUST stay `many` — surveying every backend is its entire purpose.
		callRunner.mockResolvedValue({ pane: "hi" });
		const r = await runRegistryTool("terminal_capture", { env: env(null, null), userId: "u1", instanceId: "i1" }, { target: "iterm2:1:1:1" });
		expect(r.success).toBe(true);
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/terminal/capture", { target: "iterm2:1:1:1", backend: undefined, lines: undefined }, expect.anything());
	});
});
