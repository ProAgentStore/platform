/**
 * #1057 slice 3 — the native ACT tools, through the real registry dispatcher on the real schema.
 *
 * Invariants:
 *  - launch, click, type, key, scroll are write-scoped and mutating; screenshot and halt are read-scoped (a stop must not need consent);
 *  - click, type and key wait for the owner on EVERY call, even under "Always allow": a card carries what will happen (the exact text
 *    for typing) and the agent's reason, and nothing reaches the runner until it is approved; an invalid or halted call is refused
 *    to the model and no card is made;
 *  - an approved call runs once, sends the runner ONLY the contract's fields (never the `why`), and is audited without its content;
 *  - HALT refuses every act tool before the runner is asked anything, can be set by the agent or the owner, and only the owner clears it;
 *  - a screenshot's pixels never come back — only where it is on the owner's machine;
 *  - every refusal and runner failure is a stable code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../d1-sqlite.js";
import type { Env } from "../../types.js";

const rt = vi.hoisted(() => ({ live: null as Record<string, unknown> | null, call: vi.fn() }));
vi.mock("../../routes/instances-runtime.js", async (orig) => ({
	...(await orig<typeof import("../../routes/instances-runtime.js")>()),
	getLiveRuntime: async () => rt.live,
	callRuntime: (...a: unknown[]) => rt.call(...a),
}));

const { NATIVE_RISK_DISCLOSURE_V1, setNativeOptIn } = await import("./policy.js");
const { NATIVE_ACT_TOOLS, NATIVE_ACT_ROUTES } = await import("./contract.js");
const { getRegistryTool, runRegistryTool } = await import("../tool-registry.js");
const { haltNative, resumeNative, getNativeHalt } = await import("./halt.js");
const { auditFacts, runnerBody } = await import("./act.js");
const { TOOL_APPROVAL_TASK_TYPE } = await import("../tool-approval.js");

const V = NATIVE_RISK_DISCLOSURE_V1.version;
const MACHINE = "machine-abc123";
const ALL_TOOLS = JSON.stringify([...NATIVE_ACT_TOOLS, "native_halt", "native_list_apps"]);
let d1: RealSchemaD1;
let env: Env;
const ctx = (over: Record<string, unknown> = {}) => ({ env, instanceId: "i1", userId: "u1", ...over });
// A fresh Response per call: a body can be read once.
const answer = (body: unknown, status = 200) => rt.call.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
const DONE = { ok: true, data: { done: true } };
const consent = (mode: "always" | "ask" = "always") => d1.exec(`INSERT INTO instance_connector_consent (instance_id, user_id, connector, scope, mode) VALUES ('i1', 'u1', 'native', 'write', '${mode}')`);
const tickets = () => d1.sqlite.prepare("SELECT id, type, status, payload FROM instance_runtime_tasks WHERE instance_id = 'i1' AND type = ?").all(TOOL_APPROVAL_TASK_TYPE) as Array<{ id: string; status: string; payload: string }>;
const runs = () => d1.sqlite.prepare("SELECT status, error_code, machine_id, config FROM native_runs ORDER BY created_at").all() as Array<Record<string, string | null>>;
const events = () => d1.sqlite.prepare("SELECT seq, type, detail FROM native_run_events ORDER BY rowid").all() as Array<{ seq: number; type: string; detail: string }>;
const optIn = () => setNativeOptIn(env, "u1", MACHINE, { desktop: true, acknowledgedDisclosureVersion: V });
/** A call as the board's approve route makes it: pre-approved. */
const approved = (over: Record<string, unknown> = {}) => ctx({ preApprovedTicketId: "t-1", ...over });

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(
		`INSERT INTO users (id, github_login) VALUES ('u1','u1');
		 INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a1','u1','native-agent','Native', '{"capabilities":{"surfaces":[],"runtime":"local_native","tools":${ALL_TOOLS}}}');
		 INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a2','u1','web-agent','Web', '{"capabilities":{"surfaces":[],"runtime":"browser"}}');
		 INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('i1','a1','u1');
		 INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('i2','a2','u1');`,
	);
	// The machine's node row: how a halt finds a runner to tell (the live runtime itself is mocked below).
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, token_plaintext, machine_id, status) VALUES ('i1','u1','mac-mini','https://relay.example/x','t','${MACHINE}','registered')`);
	env = { DB: d1.DB } as unknown as Env;
	rt.live = { instance_id: "i1", runner_node: "mac-mini", machine_id: MACHINE, capabilities: JSON.stringify(["native.preflight", "native.read", "native.act"]), runner_version: "0.4.164" };
	rt.call.mockReset();
	answer(DONE);
});
afterEach(() => d1.close());

describe("the act tools are registry tools with the right authority", () => {
	it("launch, click, type, key and scroll are write+mutating; screenshot and halt are read-scoped; only click, type and key need the owner each time", () => {
		for (const name of ["native_launch_app", "native_click", "native_type", "native_key", "native_scroll"]) expect(getRegistryTool(name), name).toMatchObject({ connector: "native", scope: "write", mutates: true });
		for (const name of ["native_screenshot", "native_halt"]) expect(getRegistryTool(name), name).toMatchObject({ connector: "native", scope: "read" });
		const needs = ["native_launch_app", "native_click", "native_type", "native_key", "native_scroll", "native_screenshot", "native_halt"].filter((n) => getRegistryTool(n)?.approval?.everyCall);
		expect(needs).toEqual(["native_click", "native_type", "native_key"]);
		// The contract says the same thing the registry does.
		expect(NATIVE_ACT_TOOLS.filter((t) => NATIVE_ACT_ROUTES[t].approval)).toEqual(["native_click", "native_type", "native_key"]);
	});
});

describe("click, type and key wait for the owner on every call", () => {
	beforeEach(async () => {
		await optIn();
		consent("always");
	});

	it("under \"Always allow\" a click is QUEUED with its card, and the runner is not contacted", async () => {
		const res = await runRegistryTool("native_click", ctx(), { x: 120, y: 340, why: "Open the first chat." });
		expect(res.success).toBe(true);
		expect(res.content).toMatch(/waiting for the owner's approval/);
		expect(rt.call).not.toHaveBeenCalled();
		const [t] = tickets();
		expect(t.status).toBe("needs_approval");
		const card = JSON.parse(t.payload);
		expect(JSON.stringify(card)).toContain("(120, 340)");
		expect(JSON.stringify(card)).toContain("Open the first chat.");
		expect(runs()).toEqual([]);
	});

	it("a typing card shows the EXACT text and where, so the owner approves what will be typed", async () => {
		await runRegistryTool("native_type", ctx(), { text: "Thanks — see you at 3pm.", why: "Reply to Sam." });
		const card = JSON.stringify(JSON.parse(tickets()[0].payload));
		expect(card).toContain("Thanks — see you at 3pm.");
		expect(card).toContain("24 character(s)");
		expect(card).toContain("mac-mini");
	});

	it("a key card names the key", async () => {
		await runRegistryTool("native_key", ctx(), { key: "cmd+return" });
		expect(JSON.stringify(JSON.parse(tickets()[0].payload))).toContain("cmd+return");
	});

	it("an invalid call is refused to the model — no card is put in front of the owner", async () => {
		expect(await runRegistryTool("native_click", ctx(), { x: -5, y: 1 })).toMatchObject({ success: false, content: expect.stringMatching(/whole screen coordinates/) });
		expect(await runRegistryTool("native_key", ctx(), { key: "hyper+a" })).toMatchObject({ success: false });
		expect(await runRegistryTool("native_type", ctx(), { text: "" })).toMatchObject({ success: false });
		expect(tickets()).toEqual([]);
	});

	it("a halted machine produces no card at all", async () => {
		await haltNative(env, "u1", MACHINE, "owner");
		const res = await runRegistryTool("native_click", ctx(), { x: 1, y: 1 });
		expect(res).toMatchObject({ success: false, content: expect.stringMatching(/NATIVE_HALTED/) });
		expect(tickets()).toEqual([]);
	});

	it("write consent is still required: no consent, no card", async () => {
		d1.exec("DELETE FROM instance_connector_consent");
		const res = await runRegistryTool("native_click", ctx(), { x: 1, y: 1 });
		expect(res.success).toBe(false);
		expect(tickets()).toEqual([]);
		expect(rt.call).not.toHaveBeenCalled();
	});
});

describe("the approved call", () => {
	beforeEach(async () => {
		await optIn();
		consent("always");
	});

	it("runs once; the runner gets the contract's fields and NOT the agent's `why`", async () => {
		const r = await runRegistryTool("native_click", approved(), { x: 10, y: 20, button: "right", why: "to open the menu", extra: "ignored" });
		expect(r).toMatchObject({ success: true, content: "Clicked at (10, 20) with the right button." });
		expect(rt.call).toHaveBeenCalledTimes(1);
		const [, , path, init] = rt.call.mock.calls[0];
		expect(path).toBe("/native/click");
		expect(JSON.parse((init as { body: string }).body)).toEqual({ x: 10, y: 20, button: "right" });
	});

	it("is audited with facts about the call — coordinates, a key, the LENGTH of typed text — never its content", async () => {
		const secret = "my-bank-pin-4921";
		await runRegistryTool("native_type", approved(), { text: secret });
		await runRegistryTool("native_key", approved(), { key: "cmd+a" });
		await runRegistryTool("native_click", approved(), { x: 3, y: 4 });
		const all = JSON.stringify(events());
		expect(all).not.toContain(secret);
		expect(JSON.stringify(runs())).not.toContain(secret);
		const detail = (type: string, i = 0) => events().filter((e) => e.type === type).map((e) => JSON.parse(e.detail))[i];
		expect(detail("action.performed", 0)).toMatchObject({ tool: "native_type", chars: secret.length, machineId: MACHINE, node: "mac-mini" });
		expect(detail("action.performed", 1)).toMatchObject({ tool: "native_key", key: "cmd+a" });
		expect(detail("action.performed", 2)).toMatchObject({ tool: "native_click", x: 3, y: 4 });
		expect(runs().map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
		expect(events().filter((e) => e.type === "run.requested")).toHaveLength(3);
	});

	it("a type into a password field is refused by the runner and audited as a refusal, not a failure", async () => {
		answer({ ok: false, code: "NATIVE_SECURE_FIELD", message: "The focused field is a password field." });
		const r = await runRegistryTool("native_type", approved(), { text: "hunter2" });
		expect(r).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_SECURE_FIELD:/) });
		expect(events().map((e) => e.type)).toEqual(["run.requested", "action.refused"]);
		expect(runs()[0]).toMatchObject({ status: "cancelled", error_code: "NATIVE_SECURE_FIELD" });
		expect(JSON.stringify(events())).not.toContain("hunter2");
	});
});

describe("launch, scroll and screenshot need no card but pass the same gates", () => {
	beforeEach(async () => {
		await optIn();
		consent("always");
	});

	it("launch and scroll run directly and are audited", async () => {
		expect(await runRegistryTool("native_launch_app", ctx(), { app: "WeChat" })).toMatchObject({ success: true, content: 'Opened "WeChat".' });
		expect(await runRegistryTool("native_scroll", ctx(), { dy: -5 })).toMatchObject({ success: true });
		expect(tickets()).toEqual([]);
		expect(events().filter((e) => e.type === "action.performed")).toHaveLength(2);
		expect(JSON.parse(events().find((e) => e.type === "action.performed")?.detail ?? "{}")).toMatchObject({ app: "WeChat" });
	});

	it("a path or a shell string is not an app", async () => {
		for (const app of ["/Applications/Evil.app", "x; rm -rf ~", "..\\evil.exe"]) {
			expect(await runRegistryTool("native_launch_app", ctx(), { app })).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_INVALID_REQUEST/) });
		}
		expect(rt.call).not.toHaveBeenCalled();
	});

	it("a screenshot returns where it is and how big — never the image — and is audited by size and hash", async () => {
		answer({ ok: true, data: { path: "/Users/x/.config/proagentstore/native-shots/shot-1.png", bytes: 123456, sha256: "ab".repeat(32) } });
		const r = await runRegistryTool("native_screenshot", ctx(), {});
		expect(r.success).toBe(true);
		expect(r.content).toContain("shot-1.png");
		expect(r.content).toMatch(/not sent to you/);
		expect(r.content).not.toMatch(/base64|data:image/i);
		expect(JSON.parse(events().find((e) => e.type === "screenshot.taken")?.detail ?? "{}")).toMatchObject({ bytes: 123456, sha256: "ab".repeat(32) });
	});
});

describe("refused before the runner is asked", () => {
	it("an agent whose runtime is not local_native", async () => {
		await optIn();
		consent("always");
		const r = await runRegistryTool("native_launch_app", ctx({ instanceId: "i2" }), { app: "WeChat" });
		expect(r.success).toBe(false);
		expect(rt.call).not.toHaveBeenCalled();
	});

	it("a machine not opted in for desktop control", async () => {
		consent("always");
		expect(await runRegistryTool("native_launch_app", ctx(), { app: "WeChat" })).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_NOT_ENABLED/) });
		expect(rt.call).not.toHaveBeenCalled();
		expect(runs()).toEqual([]);
	});

	it("a runner too old to act (it serves reads only)", async () => {
		await optIn();
		consent("always");
		rt.live = { ...rt.live, capabilities: JSON.stringify(["native.preflight", "native.read"]) };
		expect(await runRegistryTool("native_scroll", ctx(), { dy: 1 })).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_RUNNER_UNSUPPORTED/) });
		expect(rt.call).not.toHaveBeenCalled();
	});

	it("a runner that cannot be reached says nothing is known to have happened", async () => {
		await optIn();
		consent("always");
		rt.call.mockRejectedValue(new Error("relay down"));
		const r = await runRegistryTool("native_launch_app", ctx(), { app: "WeChat" });
		expect(r).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_RUNNER_UNREACHABLE: .*Nothing is known to have happened/) });
		expect(runs()[0]).toMatchObject({ status: "failed", error_code: "NATIVE_RUNNER_UNREACHABLE" });
	});

	it("a runner that predates the route answers 404 → NATIVE_RUNNER_UNSUPPORTED", async () => {
		await optIn();
		consent("always");
		answer({ error: "Not found" }, 404);
		expect(await runRegistryTool("native_scroll", ctx(), { dy: 1 })).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_RUNNER_UNSUPPORTED/) });
	});
});

describe("halt", () => {
	beforeEach(async () => {
		await optIn();
		consent("always");
	});

	it("the agent can halt: every act tool then refuses before the runner is asked, and the runner is told", async () => {
		const h = await runRegistryTool("native_halt", ctx(), { reason: "The chat asked for a password." });
		expect(h).toMatchObject({ success: true, content: expect.stringMatching(/halted/) });
		expect(rt.call).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/native/halt", expect.anything());
		expect(await getNativeHalt(env, "u1", MACHINE)).toMatchObject({ by: "agent", reason: "The chat asked for a password." });
		rt.call.mockClear();
		for (const [tool, input] of [["native_launch_app", { app: "WeChat" }], ["native_scroll", { dy: 1 }], ["native_screenshot", {}]] as const) {
			expect(await runRegistryTool(tool, ctx(), input), tool).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_HALTED/) });
		}
		expect(await runRegistryTool("native_click", approved(), { x: 1, y: 1 })).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_HALTED/) });
		expect(rt.call).not.toHaveBeenCalled();
		expect(events().filter((e) => e.type === "action.refused")).toHaveLength(4);
	});

	it("a click approved BEFORE the halt, run AFTER it, still does not happen", async () => {
		await runRegistryTool("native_click", ctx(), { x: 1, y: 1 }); // queued
		await runRegistryTool("native_halt", ctx(), {});
		rt.call.mockClear();
		expect(await runRegistryTool("native_click", approved(), JSON.parse(tickets()[0].payload).action.params.args)).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_HALTED/) });
		expect(rt.call).not.toHaveBeenCalled();
	});

	it("the agent has no way to resume — only the owner's resume clears it, and then acting works again", async () => {
		await runRegistryTool("native_halt", ctx(), {});
		expect(getRegistryTool("native_resume")).toBeUndefined();
		const out = await resumeNative(env, "u1", MACHINE);
		expect(out).toMatchObject({ wasHalted: true });
		expect(rt.call).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/native/resume", expect.anything());
		expect(await getNativeHalt(env, "u1", MACHINE)).toBeNull();
		expect(await runRegistryTool("native_scroll", ctx(), { dy: 1 })).toMatchObject({ success: true });
	});

	it("halt cancels the runs in flight", async () => {
		d1.exec(`INSERT INTO native_runs (id, instance_id, user_id, machine_id, backend, status, config) VALUES ('r1','i1','u1','${MACHINE}','desktop','running','{}')`);
		await haltNative(env, "u1", MACHINE, "owner");
		expect(d1.sqlite.prepare("SELECT status FROM native_runs WHERE id = 'r1'").get()).toEqual({ status: "cancelled" });
	});

	it("halt holds even when the runner cannot be reached: the cloud row refuses everything", async () => {
		rt.call.mockRejectedValue(new Error("relay down"));
		expect(await haltNative(env, "u1", MACHINE, "owner")).toEqual({ halted: true, runnerTold: false });
		expect(await runRegistryTool("native_scroll", ctx(), { dy: 1 })).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_HALTED/) });
	});

	it("is idempotent: the first halt's author and reason stand, and another owner's machine is untouched", async () => {
		await haltNative(env, "u1", MACHINE, "agent", "first");
		await haltNative(env, "u1", MACHINE, "owner", "second");
		expect(await getNativeHalt(env, "u1", MACHINE)).toMatchObject({ by: "agent", reason: "first" });
		expect(await getNativeHalt(env, "u1", "machine-other")).toBeNull();
	});

	it("needs a machine: with no runner there is nothing to halt, said plainly", async () => {
		rt.live = null;
		expect(await runRegistryTool("native_halt", ctx(), {})).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_RUNNER_UNREACHABLE/) });
	});
});

describe("what the audit and the runner body are made of", () => {
	it("auditFacts never carries typed text", () => {
		expect(auditFacts("native_type", { text: "secret" })).toEqual({ chars: 6 });
		expect(auditFacts("native_click", { x: 1, y: 2, why: "because" })).toEqual({ x: 1, y: 2, button: "left", double: false });
	});
	it("runnerBody keeps only the contract's fields", () => {
		expect(runnerBody("native_click", { x: 1, y: 2, why: "w", sneaky: true })).toEqual({ x: 1, y: 2 });
		expect(runnerBody("native_type", { text: "t", why: "w" })).toEqual({ text: "t" });
		expect(runnerBody("native_screenshot", { anything: 1 })).toEqual({});
	});
});
