/**
 * #881: the re-auth relay routes, driven against a scripted runner. The runner seam (`callRunner`)
 * and the two stores are stubbed; the routes, the plan and the pane reading are real.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { EngineReauthState } from "../lib/engine-reauth-store.js";
import type { Env } from "../types.js";

const { callRunner, getBoundRunnerConn, readEngines, hasUserProviderKey, upsertUserProviderKey, notifyUser, store } = vi.hoisted(() => ({
	callRunner: vi.fn(),
	getBoundRunnerConn: vi.fn(),
	readEngines: vi.fn(),
	hasUserProviderKey: vi.fn(),
	upsertUserProviderKey: vi.fn(),
	notifyUser: vi.fn(),
	store: { state: null as EngineReauthState | null },
}));
vi.mock("../lib/runner-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/runner-client.js")>()), callRunner, getBoundRunnerConn }));
vi.mock("../lib/coding-engines.js", async (orig) => ({ ...(await orig<typeof import("../lib/coding-engines.js")>()), readEngines }));
vi.mock("../lib/user-api-key-store.js", () => ({ hasUserProviderKey, upsertUserProviderKey }));
vi.mock("./push.js", () => ({ notifyUser }));
vi.mock("../lib/engine-reauth-store.js", async (orig) => ({
	...(await orig<typeof import("../lib/engine-reauth-store.js")>()),
	readReauthState: async () => store.state,
	writeReauthState: async (_e: unknown, _i: unknown, _u: unknown, s: EngineReauthState) => {
		store.state = s;
	},
}));

import { registerReauthRoutes } from "./coding-reauth.js";

const SECRET = "reauth-test-secret";
const UID = "user-1";
const INSTANCE = "inst-1";
const TOKEN = `sk-ant-oat01-${"Q".repeat(60)}`;
const CLAUDE_URL = "https://claude.ai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback";
const conn = { endpointUrl: "http://pink-laptop", token: "t", instanceId: INSTANCE, userId: UID, env: {} as Env, runnerNode: "pink-laptop", relayName: `${INSTANCE}:node:pink-laptop` };

/** The runner, scripted: every call recorded; `/tmux/capture` and `/tmux/send` answer `pane`. */
let pane = "";
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];

function app() {
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: {
			prepare: (sql: string) => ({
				bind: () => ({
					first: async () => (sql.includes("FROM agent_instances") ? { id: INSTANCE } : null),
					all: async () => ({ results: sql.includes("stop_reason = 'engine_auth'") ? [{ run_id: "run-stopped-1" }] : [] }),
					run: async () => ({ meta: { changes: 1 } }),
				}),
			}),
		},
	} as unknown as Env;
	const a = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerReauthRoutes(routes);
	a.route("/v1/instances", routes);
	a.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	return { a, env };
}

async function call(method: string, path: string, body?: unknown) {
	const { a, env } = app();
	const token = await signSession(UID, SECRET, { roles: [] });
	const res = await a.request(
		`/v1/instances/${INSTANCE}/coding/engine-reauth${path}`,
		{ method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined },
		env,
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
	for (const m of [callRunner, getBoundRunnerConn, readEngines, hasUserProviderKey, upsertUserProviderKey, notifyUser]) m.mockReset();
	store.state = null;
	calls.length = 0;
	pane = "";
	getBoundRunnerConn.mockResolvedValue(conn);
	readEngines.mockResolvedValue({ engines: [{ id: "claude", label: "Claude", command: "claude", auth: "auto" }], defaultEngineId: "claude" });
	hasUserProviderKey.mockResolvedValue(true);
	upsertUserProviderKey.mockResolvedValue(undefined);
	notifyUser.mockResolvedValue(undefined);
	callRunner.mockImplementation(async (_c: unknown, path: string, body: Record<string, unknown>) => {
		calls.push({ path, body });
		if (path === "/tmux/capture" || path === "/tmux/send" || path === "/tmux/run") return { pane };
		return { ok: true };
	});
});

describe("the re-auth relay (#881)", () => {
	it("start: with a stored Claude token, runs setup-token in a fresh shell and relays the URL", async () => {
		pane = `Browser didn't open? Use the url below to sign in:\n${CLAUDE_URL}\n\nPaste code here if prompted >`;
		const { status, body } = await call("POST", "", {});
		expect(status).toBe(200);
		expect(body).toMatchObject({ status: "pending", clientType: "claude", method: "claude-setup-token", loginState: "awaiting_code", url: CLAUDE_URL });
		expect(String(body.lands)).toContain("platform-stored");
		// Stale login killed, a SHELL started (no command — so a CLI that exits leaves its output), then the login run in it.
		expect(calls.map((c) => c.path)).toEqual(["/tmux/session", "/tmux/session", "/tmux/run"]);
		expect(calls[0].body).toMatchObject({ action: "kill", session: "pags-signin-claude" });
		expect(calls[1].body).toEqual({ session: "pags-signin-claude", workDir: "~" });
		expect(calls[2].body.command).toBe("env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN claude setup-token");
		expect(store.state?.status).toBe("pending");
	});

	it("input: relays the code with Enter, stores the fresh token, closes the terminal — and never shows the token", async () => {
		pane = `${CLAUDE_URL}\nPaste code here if prompted >`;
		await call("POST", "", {});
		calls.length = 0;
		pane = `Paste code here if prompted > abc#def\n\nYour OAuth token (valid for 1 year):\n${TOKEN}\nStore this token securely.`;
		const { status, body } = await call("POST", "/input", { text: "abc#def" });
		expect(status).toBe(200);
		expect(calls[0]).toEqual({ path: "/tmux/send", body: { session: "pags-signin-claude", text: "abc#def", keys: ["Enter"] } });
		expect(upsertUserProviderKey).toHaveBeenCalledWith(expect.anything(), UID, "claude-code", TOKEN);
		expect(calls.some((c) => c.path === "/tmux/session" && c.body.action === "kill")).toBe(true);
		expect(body.status).toBe("succeeded");
		expect(body.resumableRuns).toEqual(["run-stopped-1"]);
		expect(JSON.stringify(body)).not.toContain(TOKEN);
		expect(store.state?.status).toBe("succeeded");
		expect(notifyUser).toHaveBeenCalledOnce();
	});

	it("status: Codex device flow reports the code to enter, and success without anything sent back", async () => {
		readEngines.mockResolvedValue({ engines: [{ id: "codex", label: "Codex", command: "codex", auth: "subscription" }], defaultEngineId: "codex" });
		pane = "1. Open this link\n   https://auth.openai.com/codex/device\n2. Enter this one-time code\n   WXYZ-1234";
		const started = await call("POST", "", {});
		expect(started.body).toMatchObject({ method: "codex-device-auth", loginState: "device_code", deviceCode: "WXYZ-1234" });
		pane += "\nSuccessfully logged in";
		const { body } = await call("GET", "");
		expect(body.status).toBe("succeeded");
		expect(upsertUserProviderKey).not.toHaveBeenCalled();
	});

	it("start: picks the highlighted SUBSCRIPTION option of Claude's login menu, never another", async () => {
		hasUserProviderKey.mockResolvedValue(false);
		pane = "Select login method:\n❯ 1. Claude account with subscription · Pro, Max\n  2. Anthropic Console account · API usage billing";
		await call("POST", "", {});
		expect(calls.find((c) => c.path === "/tmux/send")?.body).toEqual({ session: "pags-signin-claude", keys: ["Enter"] });

		calls.length = 0;
		pane = "Select login method:\n  1. Claude account with subscription\n❯ 2. Anthropic Console account · API usage billing";
		await call("POST", "", {});
		expect(calls.some((c) => c.path === "/tmux/send")).toBe(false);
	});

	it("refuses an API-key engine, an offline runner, and junk input", async () => {
		readEngines.mockResolvedValue({ engines: [{ id: "k", label: "Key", command: "claude", auth: "api-key" }], defaultEngineId: "k" });
		expect((await call("POST", "", {})).status).toBe(400);

		readEngines.mockResolvedValue({ engines: [{ id: "claude", label: "Claude", command: "claude", auth: "auto" }], defaultEngineId: "claude" });
		getBoundRunnerConn.mockResolvedValue(null);
		expect((await call("POST", "", {})).status).toBe(409);

		expect((await call("POST", "/input", { text: "a\nb" })).status).toBe(400);
		expect((await call("POST", "/input", { text: "abc" })).status).toBe(409); // nothing pending
	});

	it("status: a login terminal that vanished ends the relay as failed", async () => {
		pane = `${CLAUDE_URL}\nPaste code here if prompted >`;
		await call("POST", "", {});
		callRunner.mockImplementation(async (_c: unknown, path: string) => {
			if (path === "/tmux/capture") throw new Error('Runner /tmux/capture → 404: {"error":"No tmux session"}');
			return { ok: true };
		});
		const { body } = await call("GET", "");
		expect(body.status).toBe("failed");
		expect(String(body.nextStep)).toContain("Start the sign-in again");
	});

	it("an old runner without the terminal connector is named, not a bare 404", async () => {
		callRunner.mockImplementation(async (_c: unknown, path: string) => {
			if (path === "/tmux/session") throw new Error('Runner /tmux/session → 404: {"error":"Not found"}');
			return {};
		});
		const { status, body } = await call("POST", "", {});
		expect(status).toBe(409);
		expect(String(body.error)).toContain("runner_update");
	});

	it("cancel closes the terminal and marks the relay cancelled", async () => {
		pane = `${CLAUDE_URL}\nPaste code here`;
		await call("POST", "", {});
		const { body } = await call("DELETE", "");
		expect(body.status).toBe("cancelled");
		expect(calls.at(-1)).toEqual({ path: "/tmux/session", body: { action: "kill", session: "pags-signin-claude" } });
	});
});
