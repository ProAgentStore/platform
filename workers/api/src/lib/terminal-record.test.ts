/**
 * A repo-less terminal's record survives the terminal (#878) — driven against the REAL schema.
 *
 * The trace: a terminal-operator instance (tmux.control, no repo) ran a long Homebrew build in tmux
 * session `shell`. The session ended, and afterwards `coding_session_capture`, `coding_terminal` and
 * `coding_timeline` all answered "no session", `activeTerminalTarget` was null, and nothing the
 * platform held could say whether the build had finished. These arms replay that: drive the
 * terminal through the dispatcher, end the session, and ask again.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { signSession } from "./session.js";
import type { Env } from "../types.js";

const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn(), callRunner: vi.fn() }));
vi.mock("./runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./runner-client.js")>()),
	getBoundRunnerConn,
	callRunner,
}));

import {
	TERMINAL_HISTORY_KEEP,
	clearTerminalHistory,
	loadTerminalHistory,
	recordTerminalToolUse,
	terminalTargetOf,
} from "./terminal-record.js";
import { runRegistryTool } from "./tool-registry.js";
import { registerFeedRoutes } from "../routes/coding-feed.js";
import { registerTerminalHistoryRoutes } from "../routes/instances-terminal-history.js";

const SECRET = "terminal-record-test-secret";
const UID = "user-1";
const INSTANCE = "inst-1";

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	vi.resetAllMocks();
	d1 = realSchemaD1();
	seedTenant(d1, { userId: UID, instanceIds: [INSTANCE] });
	env = { DB: d1.DB, SESSION_SIGNING_KEY: SECRET } as unknown as Env;
});

afterEach(() => {
	vi.useRealTimers();
});

/** Move the clock past the capture throttle. `created_at` is SQLite's own clock, so only `Date` is faked. */
function later(ms = 30_000): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + ms);
}

const use = (name: string, input: Record<string, unknown>, content: string, success = true) =>
	recordTerminalToolUse(env, { instanceId: INSTANCE, userId: UID, name, input, success, content });

function config(): Record<string, unknown> {
	const row = d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = ?").get(INSTANCE) as { config: string | null };
	return JSON.parse(row.config || "{}");
}

function rows(): Array<{ type: string; target: string; content: string }> {
	return d1.sqlite.prepare("SELECT type, target, content FROM terminal_history WHERE instance_id = ? ORDER BY seq").all(INSTANCE) as never;
}

function app() {
	const a = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerFeedRoutes(routes);
	registerTerminalHistoryRoutes(routes);
	a.route("/v1/instances", routes);
	a.onError((err, c) => c.json({ error: err.message }, err instanceof HttpError ? (err.status as 400) : 500));
	return a;
}

async function call(path: string, method = "GET") {
	const token = await signSession(UID, SECRET, { roles: ["user"] });
	const res = await app().fetch(new Request(`https://api.test${path}`, { method, headers: { Authorization: `Bearer ${token}` } }), env);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const BUILD = "==> Installing google-cloud-sdk\n==> Pouring python@3.12\n==> Summary\n🍺  google-cloud-sdk was successfully installed!\n$ ";

describe("what a terminal tool call leaves behind (#878)", () => {
	it("a command records the target, what was typed and the settled pane", async () => {
		await use("tmux_run_command", { session: "shell", command: "brew install --cask google-cloud-sdk" }, "==> Downloading…\n");
		expect(config().lastTerminalTarget).toBe("tmux:shell");
		expect(rows()).toEqual([
			{ type: "command", target: "tmux:shell", content: "brew install --cask google-cloud-sdk" },
			{ type: "terminal", target: "tmux:shell", content: "==> Downloading…\n" },
		]);
	});

	it("an unchanged pane polled again stores nothing — the console polls every 4s (#466)", async () => {
		await use("tmux_capture_pane", { session: "shell" }, BUILD);
		await use("tmux_capture_pane", { session: "shell" }, BUILD);
		await use("tmux_capture_pane", { session: "shell" }, BUILD);
		expect(rows().filter((r) => r.type === "terminal")).toHaveLength(1);
	});

	it("a changed pane polled while busy is throttled like a working engine's, then stored", async () => {
		await use("tmux_run_command", { session: "shell", command: "brew install gcloud" }, "==> Downloading…\n");
		await use("tmux_capture_pane", { session: "shell" }, "==> Building…\n");
		expect(rows().filter((r) => r.type === "terminal")).toHaveLength(1);
		later();
		await use("tmux_capture_pane", { session: "shell" }, BUILD);
		expect(rows().filter((r) => r.type === "terminal").map((r) => r.content)).toEqual(["==> Downloading…\n", BUILD]);
	});

	it("a refused or failed call records nothing", async () => {
		await use("tmux_run_command", { session: "shell", command: "rm -rf build" }, "Writing via the tmux connector isn't permitted", false);
		expect(rows()).toEqual([]);
		expect(config().lastTerminalTarget).toBeUndefined();
	});

	it("killing the session keeps the target and the record — the work that ran there is what gets asked about", async () => {
		await use("tmux_run_command", { session: "shell", command: "brew install gcloud" }, BUILD);
		await use("tmux_kill_session", { session: "shell" }, `Killed tmux session "shell".`);
		expect(config().lastTerminalTarget).toBe("tmux:shell");
		expect(rows().map((r) => r.type)).toEqual(["command", "terminal", "system"]);
	});

	it("both tool families land in one target vocabulary", () => {
		expect(terminalTargetOf("tmux_send_keys", { session: "shell" })).toBe("tmux:shell");
		expect(terminalTargetOf("terminal_capture", { target: "tmux:shell" })).toBe("tmux:shell");
		expect(terminalTargetOf("terminal_capture", { target: "3", backend: "kitty" })).toBe("kitty:3");
		expect(terminalTargetOf("terminal_new_target", { backend: "tmux", name: "build" }, "{}")).toBe("tmux:build");
		expect(terminalTargetOf("terminal_list_targets", {})).toBeNull();
		expect(terminalTargetOf("github_list_issues", { session: "x" })).toBeNull();
	});

	it("keeps the newest TERMINAL_HISTORY_KEEP rows per instance", async () => {
		for (let i = 0; i < TERMINAL_HISTORY_KEEP + 5; i++) await use("tmux_run_command", { session: "shell", command: `echo ${i}` }, "");
		const kept = rows();
		expect(kept).toHaveLength(TERMINAL_HISTORY_KEEP);
		expect(kept[kept.length - 1].content).toBe(`echo ${TERMINAL_HISTORY_KEEP + 4}`);
	});

	it("pages newest-first by default, walks back with `before`, polls with `since`", async () => {
		for (let i = 1; i <= 5; i++) await use("tmux_run_command", { session: "shell", command: `step ${i}` }, "");
		const newest = await loadTerminalHistory(env, { instanceId: INSTANCE, userId: UID, limit: 2 });
		expect(newest.entries.map((e) => e.content)).toEqual(["step 4", "step 5"]);
		expect(newest.hasMore).toBe(true);
		const older = await loadTerminalHistory(env, { instanceId: INSTANCE, userId: UID, limit: 2, before: newest.oldestSeq ?? 0 });
		expect(older.entries.map((e) => e.content)).toEqual(["step 2", "step 3"]);
		const forward = await loadTerminalHistory(env, { instanceId: INSTANCE, userId: UID, since: older.newestSeq ?? 0 });
		expect(forward.entries.map((e) => e.content)).toEqual(["step 4", "step 5"]);
	});

	it("is cleared only on purpose — rows and the remembered target together", async () => {
		await use("tmux_run_command", { session: "shell", command: "ls" }, BUILD);
		expect(await clearTerminalHistory(env, INSTANCE, UID)).toBe(2);
		expect(rows()).toEqual([]);
		expect(config().lastTerminalTarget).toBeUndefined();
	});
});

describe("the dispatcher records every surface's terminal calls (#878)", () => {
	it("a capture through runRegistryTool is recorded", async () => {
		getBoundRunnerConn.mockResolvedValue({ id: "conn" });
		callRunner.mockResolvedValue({ pane: BUILD });
		const r = await runRegistryTool("tmux_capture_pane", { env, userId: UID, instanceId: INSTANCE }, { session: "shell" });
		expect(r.success).toBe(true);
		expect(config().lastTerminalTarget).toBe("tmux:shell");
		expect(rows()).toEqual([{ type: "terminal", target: "tmux:shell", content: BUILD }]);
	});

	it("a write the consent gate refuses never reaches the runner and records nothing", async () => {
		getBoundRunnerConn.mockResolvedValue({ id: "conn" });
		const r = await runRegistryTool("tmux_run_command", { env, userId: UID, instanceId: INSTANCE }, { session: "shell", command: "brew install gcloud" });
		expect(r.success).toBe(false);
		expect(callRunner).not.toHaveBeenCalled();
		expect(rows()).toEqual([]);
	});

	it("a capture of a session that has ended fails and does not overwrite the stored pane", async () => {
		await use("tmux_capture_pane", { session: "shell" }, BUILD);
		getBoundRunnerConn.mockResolvedValue({ id: "conn" });
		callRunner.mockRejectedValue(new Error(`No tmux session "shell".`));
		const r = await runRegistryTool("tmux_capture_pane", { env, userId: UID, instanceId: INSTANCE }, { session: "shell" });
		expect(r.success).toBe(false);
		expect(rows()).toEqual([{ type: "terminal", target: "tmux:shell", content: BUILD }]);
	});
});

describe("coding_timeline / coding_terminal answer a repo-less instance from its record (#878)", () => {
	async function theTrace() {
		await use("tmux_run_command", { session: "shell", command: "brew install --cask google-cloud-sdk" }, "==> Downloading…\n");
		later();
		await use("tmux_capture_pane", { session: "shell" }, BUILD);
		await use("tmux_kill_session", { session: "shell" }, `Killed tmux session "shell".`);
	}

	it("the terminal arm returns the last stored pane, whole, after the session ended", async () => {
		await theTrace();
		const { status, body } = await call(`/v1/instances/${INSTANCE}/coding/timeline?terminal=1&limit=1`);
		expect(status).toBe(200);
		expect(body).toMatchObject({ sessionId: null, source: "terminal_history", terminalTarget: "tmux:shell", hasMore: true });
		const entries = body.entries as Array<{ content: string; target: string }>;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ content: BUILD, target: "tmux:shell" });
	});

	it("the feed arm returns the narrative — what was typed, the panes, and that the terminal closed", async () => {
		await theTrace();
		const { status, body } = await call(`/v1/instances/${INSTANCE}/coding/timeline`);
		expect(status).toBe(200);
		expect(body).toMatchObject({ sessionId: null, source: "terminal_history", terminalTarget: "tmux:shell" });
		const events = body.events as Array<{ type: string; content: string }>;
		expect(events.map((e) => e.type)).toEqual(["command", "terminal", "terminal", "system"]);
		expect(events[0].content).toBe("brew install --cask google-cloud-sdk");
		expect(events[2].content).toContain("successfully installed");
	});

	it("an instance that never drove a terminal still gets the 404, now saying both halves", async () => {
		const { status, body } = await call(`/v1/instances/${INSTANCE}/coding/timeline`);
		expect(status).toBe(404);
		expect(String(body.error)).toMatch(/no terminal history/);
	});

	it("a session asked for BY ID that does not exist is still an error, not the terminal's record", async () => {
		await theTrace();
		const { status } = await call(`/v1/instances/${INSTANCE}/coding/timeline?session_id=nope`);
		expect(status).toBe(404);
	});

	it("GET /terminal-history reads it and DELETE clears it", async () => {
		await theTrace();
		const read = await call(`/v1/instances/${INSTANCE}/terminal-history?terminal=1`);
		expect(read.body).toMatchObject({ lastTerminalTarget: "tmux:shell" });
		expect(read.body.entries as unknown[]).toHaveLength(2);
		const cleared = await call(`/v1/instances/${INSTANCE}/terminal-history`, "DELETE");
		expect(cleared.body).toEqual({ cleared: 4 });
		expect((await call(`/v1/instances/${INSTANCE}/coding/timeline`)).status).toBe(404);
	});
});
