/**
 * The coding session tools on a repo-less terminal instance (#878).
 *
 * Measured on the pink-laptop terminal instance: tmux session `shell` ran a long Homebrew build and
 * ended. Afterwards `coding_session_capture` answered "No active coding session found." and
 * `coding_session_message` demanded `coding_repo_add` — for an instance that has no use for a repo.
 * These drive the REGISTERED handlers against a stubbed API, so what is asserted is what a caller
 * gets, including which API routes were asked (the tool dispatch, never a side door).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodingSessionTools } from "./coding-tools.js";
import type { McpEnv } from "./http.js";
import type { SafetyContext } from "./safety.js";
import { isMissingTerminal, terminalFamilyFor } from "./terminal-fallback.js";

const env: McpEnv = { API_BASE: "https://api.test" };
const INSTANCE = "86cae7f6";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function handlers(): Map<string, Handler> {
	const map = new Map<string, Handler>();
	registerCodingSessionTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		{ tool: (n: string, _d: string, _s: unknown, h: Handler) => map.set(n, h) } as any,
		env,
		(t?: string) => t || "session-token",
		(): SafetyContext => ({ env, subject: "u1", scopes: ["read", "write", "runtime"] }),
	);
	return map;
}

interface Call {
	method: string;
	path: string;
	body?: Record<string, unknown>;
}

/**
 * A stub API. `routes` maps "METHOD path" to a body (or a function of the request body); anything
 * else is a 404, so an unexpected call is visible as one rather than answered.
 */
function stubApi(routes: Record<string, unknown | ((body: Record<string, unknown>) => unknown)>): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		const path = url.replace("https://api.test", "");
		const method = init?.method ?? "GET";
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
		calls.push({ method, path, body });
		const hit = routes[`${method} ${path}`];
		if (hit === undefined) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
		const value = typeof hit === "function" ? (hit as (b: Record<string, unknown>) => unknown)(body ?? {}) : hit;
		return new Response(JSON.stringify(value), { status: 200 });
	});
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

const base = `/v1/instances/${INSTANCE}`;
const noSessionsNoRepos = {
	[`GET ${base}/coding/sessions`]: { sessions: [] },
	[`GET ${base}/coding/repos`]: { repos: [] },
};
const tmuxTools = { tools: ["tmux_list_sessions", "tmux_capture_pane", "tmux_send_message", "tmux_new_session"].map((name) => ({ name, allowed: true })) };
const BUILD = "==> Summary\n🍺  google-cloud-sdk was successfully installed!\n$ ";

describe("coding_session_message on a bare terminal instance (#878)", () => {
	it("types into the last-used tmux target — no repo, no coding_repo_add", async () => {
		const calls = stubApi({
			...noSessionsNoRepos,
			[`GET ${base}/terminal-session`]: { activeTerminalTarget: null, lastTerminalTarget: "tmux:shell" },
			[`GET ${base}/tools?allowed=true`]: tmuxTools,
			[`POST ${base}/tools/tmux_send_message`]: { success: true, content: "$ brew list | grep google\ngoogle-cloud-sdk\n$ " },
		});
		const r = await handlers().get("coding_session_message")?.({ instance_id: INSTANCE, message: "brew list | grep google" });
		const out = r?.content[0].text ?? "";
		expect(out).not.toMatch(/coding_repo_add/);
		expect(out).toMatch(/^Sent to tmux:shell \(the terminal last used on this agent\)/);
		const sent = calls.find((c) => c.path === `${base}/tools/tmux_send_message`);
		expect(sent?.body).toEqual({ session: "shell", message: "brew list | grep google" });
		// Never a coding session opened for it — there is no repo to open one on.
		expect(calls.some((c) => c.method === "POST" && c.path === `${base}/coding/sessions`)).toBe(false);
	});

	it("reattaches: a tmux target that has ended is opened again under the same name, then sent to", async () => {
		let sends = 0;
		const calls = stubApi({
			...noSessionsNoRepos,
			[`GET ${base}/terminal-session`]: { activeTerminalTarget: "tmux:shell", lastTerminalTarget: "tmux:shell" },
			[`GET ${base}/tools?allowed=true`]: tmuxTools,
			[`POST ${base}/tools/tmux_send_message`]: () => (++sends === 1 ? { success: false, content: `Error: No tmux session "shell".` } : { success: true, content: "$ " }),
			[`POST ${base}/tools/tmux_new_session`]: { success: true, content: `Created tmux session "shell".` },
		});
		const r = await handlers().get("coding_session_message")?.({ instance_id: INSTANCE, message: "brew list" });
		const out = r?.content[0].text ?? "";
		expect(out).toMatch(/^Sent to tmux:shell \(the selected terminal\)/);
		expect(out).toMatch(/a new one was opened under the same name/);
		expect(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`).filter((c) => c.includes("/tools/"))).toEqual([
			`POST ${base}/tools/tmux_send_message`,
			`POST ${base}/tools/tmux_new_session`,
			`POST ${base}/tools/tmux_send_message`,
		]);
		expect(calls.find((c) => c.path.endsWith("/tools/tmux_new_session"))?.body).toEqual({ session: "shell" });
	});

	it("a refusal from the tool dispatch is reported, not retried around — consent still decides", async () => {
		const calls = stubApi({
			...noSessionsNoRepos,
			[`GET ${base}/terminal-session`]: { activeTerminalTarget: null, lastTerminalTarget: "tmux:shell" },
			[`GET ${base}/tools?allowed=true`]: tmuxTools,
			[`POST ${base}/tools/tmux_send_message`]: { success: false, content: "Writing via the tmux connector isn't permitted for this agent." },
		});
		const r = await handlers().get("coding_session_message")?.({ instance_id: INSTANCE, message: "ls" });
		expect(r?.content[0].text).toMatch(/^Error sending to tmux:shell.*isn't permitted/);
		expect(calls.some((c) => c.path.endsWith("/tools/tmux_new_session"))).toBe(false);
	});

	it("no terminal ever used: says how to get one instead of guessing", async () => {
		stubApi({
			...noSessionsNoRepos,
			[`GET ${base}/terminal-session`]: { activeTerminalTarget: null, lastTerminalTarget: null },
			[`GET ${base}/tools?allowed=true`]: tmuxTools,
		});
		const r = await handlers().get("coding_session_message")?.({ instance_id: INSTANCE, message: "ls" });
		expect(r?.content[0].text).toMatch(/no repo and no terminal it has used yet/);
	});

	it("an instance with no repo AND no terminal tools keeps the coding_repo_add answer", async () => {
		stubApi({
			...noSessionsNoRepos,
			[`GET ${base}/terminal-session`]: { activeTerminalTarget: null, lastTerminalTarget: null },
			[`GET ${base}/tools?allowed=true`]: { tools: [{ name: "github_list_issues", allowed: true }] },
		});
		const r = await handlers().get("coding_session_message")?.({ instance_id: INSTANCE, message: "ls" });
		expect(r?.content[0].text).toMatch(/coding_repo_add/);
	});
});

describe("coding_session_capture on a bare terminal instance (#878)", () => {
	it("reads the live pane of the last-used target", async () => {
		stubApi({
			...noSessionsNoRepos,
			[`GET ${base}/terminal-session`]: { activeTerminalTarget: null, lastTerminalTarget: "tmux:shell" },
			[`GET ${base}/tools?allowed=true`]: tmuxTools,
			[`POST ${base}/tools/tmux_capture_pane`]: { success: true, content: BUILD },
		});
		const r = await handlers().get("coding_session_capture")?.({ instance_id: INSTANCE });
		expect(JSON.parse(r?.content[0].text ?? "{}")).toMatchObject({ source: "live", terminalTarget: "tmux:shell", pane: BUILD });
	});

	it("after the tmux session ended: the last stored pane, marked as stored", async () => {
		stubApi({
			...noSessionsNoRepos,
			[`GET ${base}/terminal-session`]: { activeTerminalTarget: null, lastTerminalTarget: "tmux:shell" },
			[`GET ${base}/tools?allowed=true`]: tmuxTools,
			[`POST ${base}/tools/tmux_capture_pane`]: { success: false, content: `Error: No tmux session "shell".` },
			[`GET ${base}/terminal-history?terminal=1&limit=1`]: { entries: [{ seq: 7, type: "terminal", content: BUILD, createdAt: "2026-09-28 21:10:00", target: "tmux:shell" }] },
		});
		const r = await handlers().get("coding_session_capture")?.({ instance_id: INSTANCE });
		const body = JSON.parse(r?.content[0].text ?? "{}");
		expect(body).toMatchObject({ source: "stored", live: false, terminalTarget: "tmux:shell", pane: BUILD, capturedAt: "2026-09-28 21:10:00" });
		expect(body.liveError).toMatch(/No tmux session/);
	});

	it("an instance with a repo is unchanged: no active session is still that answer", async () => {
		stubApi({
			[`GET ${base}/coding/sessions`]: { sessions: [] },
			[`GET ${base}/coding/repos`]: { repos: [{ id: "r1", name: "demo" }] },
		});
		const r = await handlers().get("coding_session_capture")?.({ instance_id: INSTANCE });
		expect(r?.content[0].text).toBe("No active coding session found.");
	});
});

describe("choosing the family that reaches a target", () => {
	it("prefers terminal_* for any backend, and uses tmux_* only for a tmux target", () => {
		expect(terminalFamilyFor(new Set(["terminal_send_message", "tmux_send_message"]), "tmux:shell", "send")?.family).toBe("terminal");
		expect(terminalFamilyFor(new Set(["tmux_send_message"]), "tmux:shell", "send")?.family).toBe("tmux");
		expect(terminalFamilyFor(new Set(["tmux_send_message"]), "kitty:3", "send")).toBeNull();
	});

	it("recognises the runner's missing-session answers, and nothing else", () => {
		expect(isMissingTerminal(`Error: No tmux session "shell".`)).toBe(true);
		expect(isMissingTerminal("can't find session: shell")).toBe(true);
		expect(isMissingTerminal("Writing via the tmux connector isn't permitted")).toBe(false);
	});
});
