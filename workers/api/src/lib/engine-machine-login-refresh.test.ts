import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HeadlessSession } from "../../../../packages/browser-runner/src/coding/headless.js";
import type { Env } from "../types.js";

/**
 * A fresh interactive `/login` on a pinned machine reaches the engine `coding_loop_start` spawns
 * (#867), asserted across the whole chain: the cloud's real `resolveEngineEnv`, the runner's real
 * `HeadlessSession` (its merge over `process.env`, its spawn), and a `claude` stand-in that
 * authenticates the way Claude Code does — an env `CLAUDE_CODE_OAUTH_TOKEN` wins over the login
 * stored on the machine.
 *
 * `process.env` here plays the `pags up` process: its environment was fixed when it started, and
 * that shell exported a subscription token that has since expired. The stored-login file plays the
 * credential `claude` + `/login` writes, which a person refreshes in a terminal. Only the vault read
 * is mocked — "no token saved in Profile" is the input, as on the reported instance.
 */

vi.mock("./user-ai.js", () => ({ getUserProviderKey: vi.fn(async () => null) }));
const { resolveEngineEnv } = await import("./coding-engines.js");

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-login" }) + "\\n");
function authenticate() {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) return envToken === "valid" ? null : "API Error: 401 - OAuth access token is invalid. Please run /login";
  const stored = fs.readFileSync(process.env.FAKE_STORED_LOGIN, "utf8").trim();
  return stored === "fresh" ? null : "Failed to authenticate: OAuth session expired and could not be refreshed";
}
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const failure = authenticate();
  if (failure) {
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: failure }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: failure }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "authenticated with the machine's stored login" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) + "\\n");
});
`;

const dbEnv = () =>
	({
		DB: {
			prepare() {
				return { bind() { return { async first() { return null; }, async all() { return { results: [] }; } }; } };
			},
		},
	}) as unknown as Env;
const claudeSession = { id: "s1", clientType: "claude", launchCommand: "claude --dangerously-skip-permissions" } as never;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	while (!cond() && Date.now() - start < timeoutMs) await wait(25);
	if (!cond()) throw new Error(`Timed out waiting for ${what}`);
}

describe("a fresh interactive /login on the pinned machine reaches the spawned engine (#867)", () => {
	let dir: string;
	let bin: string;
	let storedLogin: string;
	const saved = { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, login: process.env.FAKE_STORED_LOGIN };
	const sessions: HeadlessSession[] = [];

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-login-refresh-"));
		bin = join(dir, "fake-claude.js");
		storedLogin = join(dir, "stored-login");
		writeFileSync(bin, FAKE_CLAUDE);
		chmodSync(bin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	beforeEach(() => {
		// `pags up` started in a shell that exported a subscription token, since expired.
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "expired";
		process.env.FAKE_STORED_LOGIN = storedLogin;
		writeFileSync(storedLogin, "expired");
	});
	afterEach(() => {
		for (const s of sessions.splice(0)) s.stop();
		for (const [k, v] of [["CLAUDE_CODE_OAUTH_TOKEN", saved.token], ["FAKE_STORED_LOGIN", saved.login]] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	/** One `coding_loop_start` turn on a new engine session, spawned with the cloud's overlay. */
	async function turn(id: string, overlay: Record<string, string> | undefined): Promise<{ pane: string; session: HeadlessSession }> {
		const session = new HeadlessSession({ id, workDir: dir, clientType: "claude", bin, env: overlay });
		sessions.push(session);
		session.start();
		await until(() => session.runState() === "idle", "the engine to initialise");
		session.input("work on the objective");
		await until(() => session.runState() === "idle" && session.lastTurn !== null, "the turn to finish");
		return { pane: session.snapshot(), session };
	}

	it("the overlay for the machine's own login removes an inherited subscription token", async () => {
		expect(await resolveEngineEnv(dbEnv(), "i1", "u1", claudeSession)).toEqual({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" });
	});

	it("after the owner refreshes the login, the next session on the same machine authenticates", async () => {
		const overlay = await resolveEngineEnv(dbEnv(), "i1", "u1", claudeSession);

		// Before the re-login: the stored login is expired, and the engine says so.
		const before = await turn("before", overlay);
		expect(before.pane).toContain("OAuth session expired and could not be refreshed");

		// The owner runs `claude` + `/login` in a terminal on the pinned machine.
		writeFileSync(storedLogin, "fresh");

		// The same runner process (same inherited env), the next coding_loop_start.
		const after = await turn("after", overlay);
		expect(after.pane).toContain("authenticated with the machine's stored login");
		expect(after.pane).not.toContain("Please run /login");
		expect(after.session.authResolved).toBe("machine-login");
	});

	it("regression: the pre-#867 overlay let the inherited token beat the refreshed login", async () => {
		// What resolveEngineEnv returned before: only the API key was removed.
		writeFileSync(storedLogin, "fresh");
		const stale = await turn("stale", { ANTHROPIC_API_KEY: "" });
		expect(stale.pane).toContain("OAuth access token is invalid. Please run /login");
		expect(stale.session.authResolved).toBe("subscription");
	});
});
