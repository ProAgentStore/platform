/** #1156: the engine-install relay routes, against a scripted runner (the tmux endpoints and the engine check). */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

const { callRunner, getBoundRunnerConn } = vi.hoisted(() => ({ callRunner: vi.fn(), getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/runner-client.js")>()), callRunner, getBoundRunnerConn }));
vi.mock("../lib/coding-engines.js", async (orig) => ({ ...(await orig<typeof import("../lib/coding-engines.js")>()), readEngines: async () => ({ engines: [], defaultEngineId: "claude" }), resolveEngineEnv: async () => ({}) }));
vi.mock("../lib/events.js", () => ({ logEvent: vi.fn(async () => undefined) }));

import { registerReauthRoutes } from "./coding-reauth.js";

const SECRET = "install-test-secret";
const UID = "user-1";
const INSTANCE = "inst-1";
const conn = { endpointUrl: "http://mini", token: "t", instanceId: INSTANCE, userId: UID, env: {} as Env, runnerNode: "Sergeys-Mac-mini.local", relayName: `${INSTANCE}:node:mini` };
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let pane: string | null = "";
let check: Record<string, unknown> = {};

async function call(method: string, qs = "", body?: unknown) {
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: { prepare: (sql: string) => ({ bind: () => ({ first: async () => (sql.includes("FROM agent_instances") ? { id: INSTANCE } : null), all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 1 } }) }) }) },
	} as unknown as Env;
	const a = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerReauthRoutes(routes);
	a.route("/v1/instances", routes);
	a.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	const token = await signSession(UID, SECRET, { roles: [] });
	const res = await a.request(`/v1/instances/${INSTANCE}/coding/engine-install${qs}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeEach(() => {
	callRunner.mockReset();
	getBoundRunnerConn.mockReset().mockResolvedValue(conn);
	calls.length = 0;
	pane = "";
	check = { checked: true, binaryFound: true, bin: "grok", binaryPath: "/Users/serge/.grok/bin/grok", version: "1.0.62", login: "missing", vendor: "xai" };
	callRunner.mockImplementation(async (_c: unknown, path: string, body: Record<string, unknown>) => {
		calls.push({ path, body });
		if (path === "/tmux/capture") {
			if (pane === null) throw new Error("Runner /tmux/capture → 404: no such session");
			return { pane };
		}
		if (path === "/tmux/run") return { pane: `$ ${body.command}` };
		if (path === "/coding/engine-check") return check;
		return { ok: true };
	});
});

describe("the engine-install relay (#1156)", () => {
	it("start: opens a fresh terminal on the runner and runs the FIXED installer in it — the caller chose only the engine", async () => {
		const r = await call("POST", "", { clientType: "grok", command: "rm -rf ~" });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ status: "running", clientType: "grok", runs: "curl -fsSL https://x.ai/cli/install.sh | bash", runnerNode: "Sergeys-Mac-mini.local" });
		const run = calls.find((c) => c.path === "/tmux/run");
		expect(run?.body).toEqual({ session: "pags-install-grok", command: '( curl -fsSL https://x.ai/cli/install.sh | bash ); echo "PAGS_INSTALL_EXIT=$?"' });
		expect(calls.map((c) => c.path).slice(0, 3)).toEqual(["/tmux/session", "/tmux/session", "/tmux/run"]);
		expect(calls[0].body).toMatchObject({ action: "kill" });
		// and it says what the machine has now, so an owner sees "not installed yet" / version at once
		expect(r.body.engine).toMatchObject({ installed: true, version: "1.0.62", vendor: "xai" });
	});
	it("refuses an engine it has no installer for, and an offline runner", async () => {
		expect((await call("POST", "", { clientType: "generic" })).status).toBe(400);
		expect((await call("POST", "", {})).status).toBe(400);
		getBoundRunnerConn.mockResolvedValue(null);
		const offline = await call("POST", "", { clientType: "grok" });
		expect(offline.status).toBe(409);
		expect(offline.body.error).toMatch(/No runner connected/);
		expect(calls.filter((c) => c.path === "/tmux/run")).toEqual([]);
	});
	it("status: running while the installer has not printed its exit line", async () => {
		pane = '$ ( curl … ); echo "PAGS_INSTALL_EXIT=$?"\nDownloading…';
		const r = await call("GET", "?clientType=grok");
		expect(r.body).toMatchObject({ status: "running", clientType: "grok" });
		expect(calls.some((c) => c.path === "/tmux/session" && c.body.action === "kill")).toBe(false);
	});
	it("status: success closes the terminal and reports what the machine now has — version, vendor, and that it still needs signing in", async () => {
		pane = "Installed grok 1.0.62\nPAGS_INSTALL_EXIT=0\n$ ";
		const r = await call("GET", "?clientType=grok");
		expect(r.body).toMatchObject({ status: "succeeded", exitCode: 0, engine: { installed: true, version: "1.0.62", vendor: "xai", login: "missing" } });
		expect(r.body.nextStep).toMatch(/coding_engine_reauth/);
		expect(calls.some((c) => c.path === "/tmux/session" && c.body.action === "kill" && c.body.session === "pags-install-grok")).toBe(true);
	});
	it("status: a failed installer keeps its last output, with the exit code", async () => {
		pane = "curl: (6) Could not resolve host: x.ai\nPAGS_INSTALL_EXIT=6\n";
		const r = await call("GET", "?clientType=grok");
		expect(r.body).toMatchObject({ status: "failed", exitCode: 6 });
		expect(r.body.pane).toContain("Could not resolve host");
	});
	it("status: no terminal means no install is running — and still answers what the machine has", async () => {
		pane = null;
		const r = await call("GET", "?clientType=codex");
		expect(r.body).toMatchObject({ status: "none", clientType: "codex" });
		expect(r.body.engine).toBeDefined();
	});
	it("status needs a valid engine; cancel kills that engine's terminal only", async () => {
		expect((await call("GET", "")).status).toBe(400);
		const r = await call("DELETE", "?clientType=gemini");
		expect(r.body).toEqual({ status: "cancelled", clientType: "gemini" });
		expect(calls).toEqual([{ path: "/tmux/session", body: { action: "kill", session: "pags-install-gemini" } }]);
	});
	it("an old runner without the terminal connector, and one without tmux, are named for what they block", async () => {
		callRunner.mockImplementation(async (_c: unknown, path: string) => {
			if (path === "/tmux/session") throw new Error('Runner /tmux/session → 500: spawnSync tmux ENOENT');
			return {};
		});
		const r = await call("POST", "", { clientType: "grok" });
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/tmux is not installed.*the install drives a terminal|install.*tmux/i);
		expect(r.body.error).not.toMatch(/sign-in/);
	});
});
