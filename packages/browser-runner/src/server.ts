import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import { LocalRunner, RunnerInputError } from "./runner.js";
import type { CreateTaskRequest, RunnerConfig } from "./types.js";

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
			service: "proagentstore-browser-runner",
			brainPlacement: "pags",
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
