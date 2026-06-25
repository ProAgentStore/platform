import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import { LocalRunner, RunnerInputError } from "./runner.js";
import type { BrowserAction, CreateTaskRequest, RunnerConfig, TakeoverInput } from "./types.js";

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

	if (req.method === "GET" && path === "/health") {
		return json(res, 200, {
			ok: true,
			service: "freeagentstore-browser-runtime",
			brainPlacement: "pags",
			controlPlane: "pags",
			runtimePlane: "fags",
			instanceId: runner.config.instanceId,
		});
	}

	if (req.method === "GET" && path === "/capabilities") {
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

	return json(res, 404, { error: "Not found" });
}

function authorize(req: IncomingMessage, config: RunnerConfig): boolean {
	const token = config.token;
	if (config.instanceId && req.headers["x-pags-instance-id"] !== config.instanceId) {
		return false;
	}
	if (!token) return true;
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
