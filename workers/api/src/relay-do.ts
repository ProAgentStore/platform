/**
 * RelayDO -- WebSocket relay between cloud (Workflow / API routes) and the
 * user's local browser-runner.  One DO per agent instance.
 *
 * The runner opens a WebSocket to `/connect`, authenticates via query-param
 * token, and listens for command messages.  The cloud side POSTs to `/command`
 * which sends a message on the WebSocket and awaits the runner's response.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.js";

interface PendingRequest {
	resolve: (value: CommandResponse) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface CommandRequest {
	id: string;
	method: string;
	path: string;
	body: unknown;
}

interface CommandResponse {
	id: string;
	status: number;
	result?: unknown;
	error?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class RelayDO extends DurableObject<Env> {
	private pending = new Map<string, PendingRequest>();

	/**
	 * HTTP router.  Three endpoints:
	 *   GET  /connect  -- WebSocket upgrade (runner)
	 *   GET  /status   -- is a runner connected?
	 *   POST /command  -- send a command to the runner (cloud-side)
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/connect") return this.handleConnect(request);
		if (url.pathname === "/status") return this.handleStatus();
		if (url.pathname === "/command" && request.method === "POST") return this.handleCommand(request);

		return new Response("Not found", { status: 404 });
	}

	// ── WebSocket lifecycle (hibernation API) ────────────────────────────

	private handleConnect(request: Request): Response {
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		// Close any existing runner connection (only one allowed).
		// Reject pending requests first — server-side close may not trigger
		// webSocketClose, so in-flight commands would hang until timeout.
		const existing = this.ctx.getWebSockets("runner");
		if (existing.length > 0) {
			this.rejectAll("Runner replaced by new connection");
			for (const ws of existing) {
				try { ws.close(1000, "replaced"); } catch { /* already closed */ }
			}
		}

		this.ctx.acceptWebSocket(server, ["runner"]);

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const text = typeof message === "string" ? message : new TextDecoder().decode(message);

		// Ignore pings
		if (text === "pong") return;

		let parsed: CommandResponse;
		try {
			parsed = JSON.parse(text) as CommandResponse;
		} catch {
			return; // malformed -- ignore
		}

		if (!parsed.id) return;

		const pending = this.pending.get(parsed.id);
		if (!pending) return;

		clearTimeout(pending.timer);
		this.pending.delete(parsed.id);
		pending.resolve(parsed);
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		this.rejectAll("Runner disconnected");
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.rejectAll("Runner WebSocket error");
	}

	// ── Cloud-side command dispatch ──────────────────────────────────────

	private handleStatus(): Response {
		const sockets = this.ctx.getWebSockets("runner");
		const connected = sockets.length > 0;
		return Response.json({ connected });
	}

	private async handleCommand(request: Request): Promise<Response> {
		const sockets = this.ctx.getWebSockets("runner");
		if (sockets.length === 0) {
			return Response.json({ error: "No runner connected" }, { status: 503 });
		}

		const body = (await request.json()) as { method?: string; path: string; body?: unknown; timeoutMs?: number };
		const id = crypto.randomUUID();
		const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0
			? Math.min(body.timeoutMs, DEFAULT_TIMEOUT_MS)
			: DEFAULT_TIMEOUT_MS;

		const cmd: CommandRequest = { id, method: body.method || "POST", path: body.path, body: body.body };

		let result: CommandResponse;
		try {
			result = await new Promise<CommandResponse>((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error("Relay command timed out"));
				}, timeoutMs);

				this.pending.set(id, { resolve, reject, timer });

				// Send to runner
				const ws = sockets[0];
				try {
					ws.send(JSON.stringify(cmd));
				} catch (err) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(err);
				}
			});
		} catch (err) {
			return Response.json(
				{ error: err instanceof Error ? err.message : "Relay command failed" },
				{ status: 504 },
			);
		}

		return Response.json(
			result.error ? { error: result.error } : result.result,
			{ status: result.status || 200 },
		);
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	private rejectAll(reason: string): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}
}
