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
import { getRegistryTool, registryConnectorGroups, registryToolNameSet, renderToolContent, runRegistryTool } from "../tool-registry.js";
import { CONNECTOR_CONSTRAINTS } from "../surface-options.js";
import type { Env } from "../../types.js";

const tool = (name: string) => {
	const t = TMUX_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`no tmux tool ${name}`);
	return t;
};
/** Minimal DB stub: handles bind-less .run() (logEvent retention DELETE) and bound .run()
 *  (logEvent INSERT via noteUnmeteredDrive). Without it logEvent emits noise (#680). */
const stubDb = (): Env["DB"] =>
	({
		prepare: () => ({
			run: async () => ({ meta: { changes: 0 } }),
			bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
		}),
	}) as unknown as Env["DB"];

const ctx = (over: Record<string, unknown> = {}) =>
	({ env: { DB: stubDb() } as unknown as Env, userId: "u1", instanceId: "i1", agentId: "i1", ...over }) as never;

const FAKE_CONN = { kind: "relay" } as never;

beforeEach(() => {
	getBoundRunnerConn.mockReset();
	callRunner.mockReset();
	getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
	callRunner.mockResolvedValue({});
});

describe("tmux connector — registration", () => {
	it("registers all 7 tools with correct scopes (list/capture read; run/send/send-message/new/kill write)", () => {
		const names = registryToolNameSet();
		for (const n of ["tmux_list_sessions", "tmux_capture_pane", "tmux_run_command", "tmux_send_keys", "tmux_send_message", "tmux_new_session", "tmux_kill_session"]) {
			expect(names.has(n)).toBe(true);
		}
		expect(getRegistryTool("tmux_list_sessions")?.scope).toBe("read");
		expect(getRegistryTool("tmux_capture_pane")?.scope).toBe("read");
		expect(getRegistryTool("tmux_run_command")?.scope).toBe("write");
		expect(getRegistryTool("tmux_send_keys")?.scope).toBe("write");
		expect(getRegistryTool("tmux_send_message")?.scope).toBe("write");
		expect(getRegistryTool("tmux_new_session")?.scope).toBe("write");
		expect(getRegistryTool("tmux_kill_session")?.scope).toBe("write");
	});

	it("groups the 7 tools under the tmux connector for the catalog", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "tmux");
		expect(grp?.tools).toEqual(
			expect.arrayContaining(["tmux_list_sessions", "tmux_capture_pane", "tmux_run_command", "tmux_send_keys", "tmux_send_message", "tmux_new_session", "tmux_kill_session"]),
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

	it("send_message types text + Enter via /tmux/send and returns the post-settle pane", async () => {
		callRunner.mockResolvedValue({ pane: ">\n", paneBefore: "> ", changed: true });
		const r = await tool("tmux_send_message").handler(ctx(), { session: "main", message: "hello" });
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/tmux/send", { session: "main", text: "hello", keys: ["Enter"] });
		expect(r.success).toBe(true);
		expect(r.content).toContain(">\n");
	});

	it("send_message returns success:false and a warning when the pane did not change (CLI not ready)", async () => {
		callRunner.mockResolvedValue({ pane: "> idle", paneBefore: "> idle", changed: false });
		// The warning is OURS about the pane, so it rides in `tail` outside the fence (#752) —
		// read at the dispatch seam, which is where the model sees it.
		const t = tool("tmux_send_message");
		const raw = await t.handler(ctx(), { session: "main", message: "hello" });
		const r = { ...raw, content: renderToolContent(t, raw) };
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/pane did not change/);
		expect(r.content).toMatch(/input prompt/);
	});

	it("send_message rejects an empty message without calling the runner", async () => {
		const r = await tool("tmux_send_message").handler(ctx(), { session: "main", message: "" });
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
	/**
	 * Consent answers as asked; the CONSTRAINT join always finds the instance and it declares no
	 * ceiling. The two must be told apart (#441), and #447 is what made that true HERE: the gate
	 * skips its lookup entirely for a connector with no vocabulary, so while `tmux` had none these
	 * calls never reached it. Giving `tmux` a vocabulary opts it into the fail-closed lookup, and a
	 * fixture answering `null` to every query would now refuse a READ for a reason that has nothing
	 * to do with consent — which is the thing under test here.
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

/**
 * The single-SESSION binding (#447) — the ceiling the one PUBLISHED Operator could not declare.
 *
 * #403 moved `tmux-operator` off the generic `terminal_*` tools and onto the backend-exclusive
 * `tmux_*` ones, which made it a tmux agent by construction and, because `CONNECTOR_CONSTRAINTS`
 * is keyed by CONNECTOR, simultaneously moved it onto a connector with no vocabulary. So the only
 * agent with live instances was the only one that could not be bound to a pane: a `tmux` key was
 * DROPPED by `parseConstraintSpec`, making the declaration unwritable rather than merely unwritten.
 *
 * The `terminal` half of this is `terminal.test.ts`'s "single-target binding" block. This is the
 * same argument for the connector that actually ships: `tmux_run_command` is arbitrary shell on
 * the owner's machine, and "one pane, one job" is the constraint that says which machine's which
 * window it may be.
 */
describe("tmux connector — the single-session binding (#447)", () => {
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
												agent_config: JSON.stringify({ capabilities: { surfaces: ["tmux"], ...(agent ? { surfaceOptions: { tmux: agent } } : {}) } }),
												instance_config: JSON.stringify(instance ? { surfaceOptions: { tmux: instance } } : {}),
											}
										: { ok: 1 },
							};
						},
					};
				},
			},
		}) as unknown as Env;

	it("AN UNBOUND `single` INSTANCE REFUSES rather than guessing a pane, and names the route that fixes it", async () => {
		const r = await runRegistryTool(
			"tmux_capture_pane",
			{ env: env({ sessions: "single" }, null), userId: "u1", instanceId: "i1" },
			{ session: "anything" },
		);
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/drives exactly one tmux session/i);
		// The refusal must name the tmux route, not the terminal one. Before #447 this string was a
		// literal `/terminal-target`, which for a tmux agent sends the reader to a route that
		// governs a different resource — worse than naming none.
		expect(r.content).toContain("PUT /v1/instances/{id}/tmux-session");
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("WITH `main` BOUND, the bound session runs and any other session is refused", async () => {
		callRunner.mockResolvedValue({ pane: "hi" });
		const ok = await runRegistryTool(
			"tmux_capture_pane",
			{ env: env({ sessions: "single" }, { boundSession: "main" }), userId: "u1", instanceId: "i1" },
			{ session: "main" },
		);
		expect(ok.success).toBe(true);

		callRunner.mockClear();
		const refused = await runRegistryTool(
			"tmux_capture_pane",
			{ env: env({ sessions: "single" }, { boundSession: "main" }), userId: "u1", instanceId: "i1" },
			{ session: "other" },
		);
		expect(refused.success).toBe(false);
		// The runner is never reached — a ceiling that only hides a control in the console is walked
		// straight through by the first confidently-wrong model call.
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("`tmux_list_sessions` still runs unbound — you cannot bind what you have not listed", async () => {
		callRunner.mockResolvedValue({ sessions: [] });
		const r = await runRegistryTool("tmux_list_sessions", { env: env({ sessions: "single" }, null), userId: "u1", instanceId: "i1" }, {});
		expect(r.success).toBe(true);
		// Not a special case: the tool takes no `session` argument, and a tool without the governed
		// arg in its schema is not gated. That is the same rule that leaves `terminal_list_targets`
		// free under a `targets: "single"` ceiling.
		expect(getRegistryTool("tmux_list_sessions")?.jsonSchema.properties).not.toHaveProperty("session");
	});

	it("AN AGENT DECLARING NOTHING is byte-identical to before the vocabulary existed", async () => {
		callRunner.mockResolvedValue({ pane: "hi" });
		const r = await runRegistryTool("tmux_capture_pane", { env: env(null, null), userId: "u1", instanceId: "i1" }, { session: "whatever" });
		expect(r.success).toBe(true);
		// This is the promise the ticket makes to the two LIVE instances, which run today with no
		// ceiling: shipping the vocabulary must not start refusing their calls.
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/tmux/capture", expect.objectContaining({ session: "whatever" }), expect.anything());
	});

	it("A CALL THAT NAMES NO INSTANCE IS NOW REFUSED — the fail-closed cost of joining the table (#441)", async () => {
		// Deliberately pinned, because it IS a behaviour change and the ticket predicted the
		// opposite. `runRegistryTool` skips the ceiling lookup entirely for a connector with no
		// vocabulary, so while `tmux` had none, a call carrying no instance authority ran
		// unconstrained. Giving `tmux` an entry opts it into #441's posture: a ceiling that cannot
		// be LOCATED is a refusal. Subscriber calls always carry an instance and are unaffected;
		// an agent-TEMPLATE surface (a creator's own trial chat) passes the agent id and now
		// refuses where it previously ran.
		const r = await runRegistryTool("tmux_list_sessions", { env: env(null, null), userId: "u1" }, {});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/could not be resolved|names no instance/i);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("the constraint vocabulary matches the tools' own schemas — two lists that must not drift", () => {
		// The assertion `terminal.test.ts` makes for `backends`, made here for the binding arg. A
		// tool that starts taking `session` without the vocabulary knowing, or a vocabulary that
		// renames the arg, silently disconnects the ceiling from the thing it governs.
		const def = CONNECTOR_CONSTRAINTS.tmux.sessions;
		expect(def.kind).toBe("binding");
		const arg = def.kind === "binding" ? def.arg : "";
		expect(arg).toBe("session");
		// Every tmux tool EXCEPT the lister addresses a session, and each must declare it.
		for (const t of TMUX_TOOLS) {
			if (t.name === "tmux_list_sessions") {
				expect(t.jsonSchema.properties, t.name).not.toHaveProperty(arg);
				continue;
			}
			expect(t.jsonSchema.properties, t.name).toHaveProperty(arg);
		}
	});
});
