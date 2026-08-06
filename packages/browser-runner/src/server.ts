import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import { LocalRunner, RunnerInputError } from "./runner.js";
import type { BrowserAction, CreateTaskRequest, RunnerConfig, TakeoverInput } from "./types.js";
import type { CodingAction, StartCodingInput } from "./coding/runtime.js";

export function createRunnerServer(runner: LocalRunner) {
	return createServer(async (req, res) => {
		try {
			if (!authorize(req, runner.config)) {
				return json(res, 401, { error: "Unauthorized" });
			}
			await route(runner, req, res);
		} catch (error) {
			const status = error instanceof RunnerInputError ? error.status : 500;
			json(res, status, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

export async function startRunnerServer(config: RunnerConfig): Promise<{
	runner: LocalRunner;
	close: () => Promise<void>;
	url: string;
}> {
	const runner = new LocalRunner(config);
	const server = createRunnerServer(runner);
	await new Promise<void>((resolve) => {
		server.listen(config.port, config.host, resolve);
	});
	const address = server.address() as AddressInfo;
	const actualPort = address.port;
	return {
		runner,
		url: `http://${config.host}:${actualPort}`,
		async close() {
			await runner.close();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

async function route(runner: LocalRunner, req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
	const path = url.pathname.replace(/\/$/, "") || "/";

	if ((req.method === "GET" || req.method === "POST") && path === "/health") {
		return json(res, 200, {
			ok: true,
			service: "proagentstore-browser-runtime",
			brainPlacement: "pags",
			controlPlane: "pags",
			runtimePlane: "pags",
			instanceId: runner.config.instanceId,
		});
	}

	if ((req.method === "GET" || req.method === "POST") && path === "/capabilities") {
		return json(res, 200, runner.capabilities());
	}

	if (req.method === "GET" && path === "/sessions") {
		return json(res, 200, { sessions: runner.store.listSessions() });
	}

	if (req.method === "POST" && path === "/sessions") {
		return json(res, 201, runner.store.createSession());
	}

	if (req.method === "GET" && path === "/tasks") {
		return json(res, 200, { tasks: runner.store.listTasks() });
	}

	if (req.method === "POST" && path === "/tasks") {
		const body = await readJson<CreateTaskRequest>(req);
		return json(res, 202, runner.createTask(body));
	}

	const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
	if (req.method === "GET" && taskMatch) {
		const task = runner.store.getTask(taskMatch[1]);
		if (!task) return json(res, 404, { error: "Task not found" });
		return json(res, 200, task);
	}

	const approveMatch = path.match(/^\/tasks\/([^/]+)\/approve$/);
	if (req.method === "POST" && approveMatch) {
		return json(res, 200, await runner.approveTask(approveMatch[1]));
	}

	const cancelMatch = path.match(/^\/tasks\/([^/]+)\/cancel$/);
	if (req.method === "POST" && cancelMatch) {
		return json(res, 200, runner.cancelTask(cancelMatch[1]));
	}

	if (req.method === "GET" && path === "/events") {
		const limit = clampLimit(url.searchParams.get("limit"), 100, 500);
		return json(res, 200, { events: runner.store.listEvents(limit) });
	}

	// ── Brain-driven browser control (remote LLM acts on the live page) ─────
	if (req.method === "POST" && path === "/browser/snapshot") {
		const b = await readJson<{ taskId?: string }>(req).catch(() => ({}) as { taskId?: string });
		return json(res, 200, await runner.browserSnapshot(b.taskId));
	}
	if (req.method === "POST" && path === "/browser/act") {
		const body = await readJson<BrowserAction & { resumePath?: string }>(req);
		return json(res, 200, await runner.browserAct(body, body.resumePath));
	}
	if (req.method === "POST" && path === "/browser/event") {
		const b = await readJson<{ taskId: string; type: string; message: string; data?: unknown }>(req);
		return json(res, 200, runner.browserEvent(b.taskId, b.type, b.message, b.data));
	}
	if (req.method === "POST" && path === "/browser/handoff") {
		const b = await readJson<{ taskId: string; challenge?: string; label?: string; reason?: string }>(req);
		return json(res, 200, await runner.browserHandoff(b.taskId, b.label ?? b.challenge ?? "this step", b.reason ?? "challenge"));
	}
	if (req.method === "POST" && path === "/browser/handoff-status") {
		const b = await readJson<{ taskId: string }>(req);
		return json(res, 200, await runner.browserHandoffStatus(b.taskId));
	}
	if (req.method === "POST" && path === "/browser/resume") {
		const b = await readJson<{ taskId: string }>(req);
		return json(res, 200, await runner.browserResume(b.taskId));
	}
	if (req.method === "POST" && path === "/browser/input") {
		const b = await readJson<{ taskId: string; value: string }>(req);
		return json(res, 200, runner.browserSubmitInput(b.taskId, String(b.value ?? "")));
	}
	if (req.method === "POST" && path === "/browser/complete") {
		const b = await readJson<{ taskId: string; outcome: string; detail?: string }>(req);
		return json(res, 200, await runner.browserComplete(b.taskId, b.outcome, b.detail));
	}

	// ── Human takeover (remote view + control) ──────────────────────────────
	if (req.method === "GET" && path === "/takeover") {
		return json(res, 200, { takeovers: runner.listTakeovers() });
	}
	const frameMatch = path.match(/^\/takeover\/([^/]+)\/frame$/);
	if (req.method === "GET" && frameMatch) {
		return json(res, 200, await runner.takeoverFrame(frameMatch[1]));
	}
	const inputMatch = path.match(/^\/takeover\/([^/]+)\/input$/);
	if (req.method === "POST" && inputMatch) {
		const body = await readJson<TakeoverInput>(req);
		await runner.takeoverInput(inputMatch[1], body);
		return json(res, 200, { ok: true });
	}
	const resumeMatch = path.match(/^\/takeover\/([^/]+)\/resume$/);
	if (req.method === "POST" && resumeMatch) {
		return json(res, 200, await runner.resumeTakeover(resumeMatch[1]));
	}
	const endMatch = path.match(/^\/takeover\/([^/]+)\/end$/);
	if (req.method === "POST" && endMatch) {
		await runner.endTakeover(endMatch[1]);
		return json(res, 200, { ok: true });
	}

	// ── Brain-driven coding control (remote LLM drives a tmux coding CLI) ────
	// The tmux analogue of the /browser/* surface: start → capture → act → end.
	if (req.method === "POST" && path === "/coding/start") {
		const b = await readJson<StartCodingInput>(req);
		return json(res, 200, runner.coding.start(b));
	}
	if (req.method === "POST" && path === "/coding/capture") {
		const b = await readJson<{ sessionId: string }>(req);
		return json(res, 200, runner.coding.snapshot(b.sessionId));
	}
	if (req.method === "POST" && path === "/coding/act") {
		const b = await readJson<{ sessionId: string; action: CodingAction }>(req);
		return json(res, 200, runner.coding.act(b.sessionId, b.action));
	}
	if (req.method === "POST" && path === "/coding/end") {
		const b = await readJson<{ sessionId: string }>(req);
		return json(res, 200, runner.coding.end(b.sessionId));
	}
	if (req.method === "GET" && path === "/coding/sessions") {
		return json(res, 200, { sessions: runner.coding.list() });
	}
	if ((req.method === "GET" || req.method === "POST") && path === "/coding/diagnostics") {
		// No tmux figures here any more (#247). The coding engine spawns a child process
		// directly, so `pagsTmuxTotal` was structurally always 0 and `tmuxTotal` counted the
		// user's own unrelated sessions — this is the panel someone opens BECAUSE something is
		// wrong, and it pointed them at a false cause. The terminal-operator agents, which do
		// use tmux, have their own /tmux/* endpoints and are unaffected.
		return json(res, 200, { tracked: runner.coding.diagnostics() });
	}
	if (req.method === "POST" && path === "/coding/browse") {
		const { readdirSync, statSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const { homedir } = await import("node:os");
		const b = await readJson<{ dir?: string }>(req);
		const raw = (b.dir || "~").replace(/^~(?=$|\/)/, homedir());
		const dir = resolve(raw);
		try {
			const entries = readdirSync(dir, { withFileTypes: true })
				.filter((e) => !e.name.startsWith("."))
				.slice(0, 200)
				.map((e) => ({
					name: e.name,
					type: e.isDirectory() ? "dir" : "file",
					size: e.isFile() ? statSync(resolve(dir, e.name)).size : undefined,
				}));
			return json(res, 200, { dir, entries });
		} catch (e: unknown) {
			return json(res, 400, { error: e instanceof Error ? e.message : String(e), dir });
		}
	}
	// Close every tracked coding session. The path still says "kill-tmux" ON PURPOSE: an older
	// runner must keep answering a newer API, and renaming it would 404 across that skew (#247).
	// The tmux half is gone — it only ever targeted `pags-*` sessions, which the coding engine
	// has never created. `closeAll()` is the part that always worked, and is now the whole job.
	if (req.method === "POST" && (path === "/coding/kill-tmux" || path === "/coding/close-sessions")) {
		const closed = runner.coding.diagnostics().map((s) => s.sessionId);
		runner.coding.closeAll();
		return json(res, 200, { closed: closed.length, sessions: closed });
	}
	// ── Read-only code inspection (the Co-pilot/Chat's "eyes" — no CLI driving) ──
	// Confined to the session's workDir by inspect.ts; errors surface as 400.
	if (req.method === "POST" && path === "/coding/read-file") {
		const b = await readJson<{ sessionId?: string; workDir?: string; path: string; maxBytes?: number }>(req);
		try {
			return json(res, 200, runner.coding.readFile(b));
		} catch (e: unknown) {
			return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
		}
	}
	if (req.method === "POST" && path === "/coding/git") {
		const b = await readJson<{ sessionId?: string; workDir?: string; cmd: "status" | "diff" | "diff-stat" | "log" | "ls-files"; path?: string; n?: number }>(req);
		try {
			return json(res, 200, runner.coding.git(b));
		} catch (e: unknown) {
			return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
		}
	}
	if (req.method === "POST" && path === "/coding/git-remote") {
		const b = await readJson<{ sessionId?: string; workDir?: string }>(req);
		try {
			return json(res, 200, runner.coding.gitRemote(b));
		} catch (e: unknown) {
			return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
		}
	}
	if (req.method === "POST" && path === "/coding/tree") {
		const b = await readJson<{ sessionId?: string; workDir?: string; path?: string; maxDepth?: number; maxEntries?: number }>(req);
		try {
			return json(res, 200, runner.coding.tree(b));
		} catch (e: unknown) {
			return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
		}
	}
	if (req.method === "POST" && path === "/coding/event") {
		// Brain progress events — recorded by PAGS, ignored locally. Accept + ack.
		return json(res, 200, { ok: true });
	}

	// ── Human takeover of a coding session (text frames + keystrokes) ───────
	if (req.method === "POST" && path === "/coding/takeover") {
		const b = await readJson<{ sessionId: string; reason?: string; label?: string }>(req);
		return json(res, 200, runner.coding.beginTakeover(b.sessionId, { reason: b.reason, label: b.label }));
	}
	if (req.method === "POST" && path === "/coding/takeover-status") {
		const b = await readJson<{ sessionId: string }>(req);
		return json(res, 200, runner.coding.takeoverStatus(b.sessionId));
	}
	const codingFrameMatch = path.match(/^\/coding\/takeover\/([^/]+)\/frame$/);
	if (req.method === "GET" && codingFrameMatch) {
		return json(res, 200, runner.coding.takeoverFrame(codingFrameMatch[1]));
	}
	const codingInputMatch = path.match(/^\/coding\/takeover\/([^/]+)\/input$/);
	if (req.method === "POST" && codingInputMatch) {
		const b = await readJson<{ text?: string; keys?: string }>(req);
		return json(res, 200, runner.coding.takeoverInput(codingInputMatch[1], b));
	}
	const codingResolveMatch = path.match(/^\/coding\/takeover\/([^/]+)\/resolve$/);
	if (req.method === "POST" && codingResolveMatch) {
		const b = await readJson<{ value?: string }>(req);
		return json(res, 200, runner.coding.resolveTakeover(codingResolveMatch[1], b.value));
	}
	const codingEndMatch = path.match(/^\/coding\/takeover\/([^/]+)\/end$/);
	if (req.method === "POST" && codingEndMatch) {
		return json(res, 200, runner.coding.endTakeover(codingEndMatch[1]));
	}

	// ── tmux connector ──────────────────────────────────────────────────────
	// The machine-global terminal surface any permitted agent can drive over the
	// relay: list EVERY live session (not just pags-* ones), read a pane, and —
	// gated by write-consent in the cloud — send keys / run a command. Reuses the
	// coding runtime's tmux primitives.
	if ((req.method === "GET" || req.method === "POST") && path === "/tmux/list") {
		const { listSessionsDetailed } = await import("./coding/tmux.js");
		return json(res, 200, { sessions: listSessionsDetailed() });
	}
	if (req.method === "POST" && path === "/tmux/capture") {
		const { capturePane, sessionExists } = await import("./coding/tmux.js");
		const b = await readJson<{ session?: string; lines?: number }>(req);
		const session = String(b.session || "").trim();
		if (!session) return json(res, 400, { error: "A `session` name is required." });
		if (!sessionExists(session)) return json(res, 404, { error: `No tmux session "${session}".` });
		const lines = Math.min(Math.max(Number(b.lines) || 200, 1), 2000);
		return json(res, 200, { session, pane: capturePane(session, lines) });
	}
	if (req.method === "POST" && path === "/tmux/send") {
		const { sendText, sendKey, capturePane, sessionExists } = await import("./coding/tmux.js");
		const b = await readJson<{ session?: string; text?: string; keys?: string[] }>(req);
		const session = String(b.session || "").trim();
		if (!session) return json(res, 400, { error: "A `session` name is required." });
		if (!sessionExists(session)) return json(res, 404, { error: `No tmux session "${session}".` });
		if (b.text != null) sendText(session, String(b.text));
		for (const k of b.keys ?? []) sendKey(session, String(k));
		return json(res, 200, { session, pane: capturePane(session, 200) });
	}
	if (req.method === "POST" && path === "/tmux/run") {
		const { runCommand, capturePane, sessionExists } = await import("./coding/tmux.js");
		const b = await readJson<{ session?: string; command?: string }>(req);
		const session = String(b.session || "").trim();
		const command = String(b.command ?? "");
		if (!session) return json(res, 400, { error: "A `session` name is required." });
		if (!command.trim()) return json(res, 400, { error: "A `command` is required." });
		if (!sessionExists(session)) return json(res, 404, { error: `No tmux session "${session}".` });
		runCommand(session, command);
		return json(res, 200, { session, command, pane: capturePane(session, 200) });
	}
	if (req.method === "POST" && path === "/tmux/session") {
		const { createSession, killSession, sessionExists } = await import("./coding/tmux.js");
		const { homedir } = await import("node:os");
		const b = await readJson<{ action?: string; session?: string; workDir?: string; command?: string }>(req);
		const session = String(b.session || "").trim();
		if (!session) return json(res, 400, { error: "A `session` name is required." });
		if (b.action === "kill") {
			return json(res, 200, { session, killed: killSession(session) });
		}
		// default: create
		if (sessionExists(session)) return json(res, 200, { session, created: false, existed: true });
		const { resolve } = await import("node:path");
		const workDir = resolve(String(b.workDir || "~").replace(/^~(?=$|\/)/, homedir()));
		createSession(session, workDir, b.command ? String(b.command) : undefined);
		return json(res, 200, { session, created: true, workDir });
	}

	// ── generic terminal connector ──────────────────────────────────────────
	// One local-terminal vocabulary over backend-specific adapters. tmux is fully
	// controllable; kitty needs remote control enabled; iTerm2 needs macOS Automation access.
	if ((req.method === "GET" || req.method === "POST") && path === "/terminal/list") {
		const { listTerminalTargets } = await import("./coding/terminal.js");
		const b = req.method === "POST" ? await readJson<{ backend?: string }>(req) : { backend: "all" };
		const backend = b.backend === "tmux" || b.backend === "kitty" || b.backend === "iterm2" ? b.backend : "all";
		return json(res, 200, { targets: listTerminalTargets(backend) });
	}
	if (req.method === "POST" && path === "/terminal/capture") {
		const { captureTerminalTarget } = await import("./coding/terminal.js");
		const b = await readJson<{ target?: string; backend?: string; lines?: number }>(req);
		const target = String(b.target || "").trim();
		if (!target) return json(res, 400, { error: "A `target` is required." });
		const backend = b.backend === "tmux" || b.backend === "kitty" || b.backend === "iterm2" ? b.backend : undefined;
		return json(res, 200, { target, pane: captureTerminalTarget(target, { backend, lines: b.lines }) });
	}
	if (req.method === "POST" && path === "/terminal/run") {
		const { runTerminalCommand } = await import("./coding/terminal.js");
		const b = await readJson<{ target?: string; backend?: string; command?: string }>(req);
		const target = String(b.target || "").trim();
		const command = String(b.command ?? "");
		if (!target) return json(res, 400, { error: "A `target` is required." });
		if (!command.trim()) return json(res, 400, { error: "A `command` is required." });
		const backend = b.backend === "tmux" || b.backend === "kitty" || b.backend === "iterm2" ? b.backend : undefined;
		return json(res, 200, { target, command, pane: runTerminalCommand(target, command, backend) });
	}
	if (req.method === "POST" && path === "/terminal/send") {
		const { sendTerminalKeys } = await import("./coding/terminal.js");
		const b = await readJson<{ target?: string; backend?: string; text?: string; keys?: string[] }>(req);
		const target = String(b.target || "").trim();
		if (!target) return json(res, 400, { error: "A `target` is required." });
		const backend = b.backend === "tmux" || b.backend === "kitty" || b.backend === "iterm2" ? b.backend : undefined;
		return json(res, 200, { target, pane: sendTerminalKeys(target, { backend, text: b.text == null ? undefined : String(b.text), keys: b.keys ?? [] }) });
	}
	if (req.method === "POST" && path === "/terminal/session") {
		const { createTerminalTarget, killTerminalTarget } = await import("./coding/terminal.js");
		const b = await readJson<{ action?: string; target?: string; backend?: string; name?: string; workDir?: string; command?: string }>(req);
		const backend = b.backend === "tmux" || b.backend === "kitty" || b.backend === "iterm2" ? b.backend : undefined;
		if (b.action === "kill") {
			const target = String(b.target || "").trim();
			if (!target) return json(res, 400, { error: "A `target` is required." });
			return json(res, 200, { target, killed: killTerminalTarget(target, backend) });
		}
		if (!backend) return json(res, 400, { error: "`backend` must be tmux, kitty, or iterm2." });
		const target = createTerminalTarget({ backend, name: b.name, workDir: b.workDir, command: b.command });
		return json(res, 200, { target });
	}

	return json(res, 404, { error: "Not found" });
}

/**
 * Authorize a request to the local runner (#245).
 *
 * This surface drives a coding CLI that `pags up` launches with
 * `--dangerously-skip-permissions` / `--sandbox danger-full-access`, so "who may POST here" is
 * the whole security boundary. Two things were the wrong way round:
 *
 * 1. **No token used to mean ALLOW.** `pags up` always generates one, so that path was safe —
 *    but `pags-browser-runner` run directly (its own --help documents this) passes
 *    `token: undefined`, and served the entire surface unauthenticated. Now it fails CLOSED;
 *    the standalone entrypoint generates a token instead of starting open.
 *
 * 2. **A browser could reach it.** Binding to loopback is not isolation: a page the user is
 *    visiting cannot READ a cross-origin response, but it can still SEND the POST, and the
 *    server sets no CORS headers and did no Origin check. The token already made that
 *    unguessable — but nothing legitimate that calls this runner is a browser (the cloud
 *    dispatches over the relay; the CLI calls it directly), and neither sends `Origin`. So the
 *    presence of that header is by itself proof the caller is a web page, and is refused before
 *    the token is even considered. Also closes DNS-rebinding, which loopback does not.
 */
function authorize(req: IncomingMessage, config: RunnerConfig): boolean {
	if (req.headers.origin) return false;
	const token = config.token;
	if (config.instanceId && req.headers["x-pags-instance-id"] !== config.instanceId) {
		return false;
	}
	if (!token) return false;
	const auth = req.headers.authorization || "";
	const headerToken = req.headers["x-pags-runner-token"];
	return auth === `Bearer ${token}` || headerToken === token;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	const raw = Buffer.concat(chunks).toString("utf-8");
	if (!raw) return {} as T;
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new RunnerInputError("Request body must be valid JSON");
	}
}

function clampLimit(value: string | null, fallback: number, max: number): number {
	const parsed = Number(value || fallback);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(JSON.stringify(body));
}
