/**
 * RelayDO -- WebSocket relay between cloud (Workflow / API routes) and the
 * user's local browser-runner.  One DO per agent instance.
 *
 * The runner opens a WebSocket to `/connect`, authenticates via query-param
 * token, and listens for command messages.  The cloud side POSTs to `/command`
 * which sends a message on the WebSocket and awaits the runner's response.
 */
import { DurableObject } from "cloudflare:workers";
import { RunnerLiveness } from "./lib/relay-liveness.js";
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

/** Accept the upgrade only to close it immediately with a code the client can read. A rejected
 *  upgrade surfaces as 1006 with no reason; an accepted-then-closed socket carries both. */
function closeWithReason(code: number, reason: string): Response {
	const pair = new WebSocketPair();
	const [client, server] = [pair[0], pair[1]];
	server.accept();
	try {
		server.close(code, reason.slice(0, 120));
	} catch {
		/* already closing */
	}
	return new Response(null, { status: 101, webSocket: client });
}

export class RelayDO extends DurableObject<Env> {
	private pending = new Map<string, PendingRequest>();
	/** Ping/pong bookkeeping — the difference between "a socket is listed" and "a runner is there". */
	private liveness = new RunnerLiveness();

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

	private async handleConnect(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const force = url.searchParams.get("force") === "1";

		const existing = this.ctx.getWebSockets("runner");

		// If another runner is connected, reject unless forced.
		//
		// "Connected" means it ANSWERED (#497). The old test — `send` did not throw — passes for a
		// peer that has stopped existing at the application layer, which is exactly what a slept
		// laptop is: measured in production, a SIGSTOPped holder kept its slot and forced 4409 for
		// ~5 minutes, while a hard-killed one never conflicted at all. Since the CLI treats a 4409
		// as terminal for the life of the process, that window cost the machine its whole run.
		if (existing.length > 0 && !force) {
			if (await this.liveness.probe(existing)) {
				// Accept, then close with an application code + reason. A rejected UPGRADE reaches
				// the client as close code 1006 with no body, so the CLI's only diagnostic branch
				// (4401/1008 — codes nothing ever sent) never fired and the actionable
				// "Use --force to take over" was discarded: the user saw
				// "Relay disconnected … reconnecting in 30s" forever while the TUI sat on
				// "Setting things up…".
				return closeWithReason(4409, "Another runner is already connected. Use --force to take over.");
			}
		}

		// Close any existing runner connection (forced takeover or dead socket)
		if (existing.length > 0) {
			this.rejectAll("Runner replaced by new connection");
			for (const ws of existing) {
				try { ws.close(1000, "replaced"); } catch { /* already closed */ }
			}
		}

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server, ["runner"]);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const text = typeof message === "string" ? message : new TextDecoder().decode(message);

		// A pong is not noise — it is the ONLY evidence that the peer holding this slot still
		// exists (#497). Dropping it here is what let a frozen runner look alive.
		if (text === "pong") { this.liveness.pong(); return; }

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

	async webSocketClose(_ws: WebSocket): Promise<void> {
		this.rejectAll("Runner disconnected");
	}

	async webSocketError(_ws: WebSocket): Promise<void> {
		this.rejectAll("Runner WebSocket error");
	}

	// ── Cloud-side command dispatch ──────────────────────────────────────

	private handleStatus(): Response {
		const sockets = this.ctx.getWebSockets("runner");
		// A socket in the list may be half-closed (server kept the reference but the client went
		// away between heartbeats), or open to a peer that is frozen and will never answer again.
		//
		// This asks WITHOUT waiting: it pings now and judges on the previous round trip (#497).
		// `relayConnected` runs in a per-node loop on every tool-call resolution path and on the
		// chat context builder, so a 1.5s pong wait per offline node would add seconds to every
		// agent turn. The cost of not waiting is that the first call after a peer freezes still
		// answers "connected"; the next one tells the truth, instead of the ~5 minutes of
		// "connected: true" measured against a SIGSTOPped holder in production.
		// A socket the send cannot even reach is closed inside the probe, as it was here before.
		return Response.json({ connected: this.liveness.observe(sockets) });
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
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}
}
