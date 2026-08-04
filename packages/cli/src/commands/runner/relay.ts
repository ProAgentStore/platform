import { hostname } from "node:os";
import { loadSession } from "../login.js";
import { writeError, writeLine } from "../../output.js";
import { apiPathSegment, clean, pagsApiBase, requestPags, requestRunner } from "./http.js";
import { CLI_VERSION } from "./process.js";
import type { PagsRequestOptions } from "./types.js";

/**
 * Connect to PAGS via WebSocket relay — no tunnel, no cloudflared.
 * Opens one WS per instance to the RelayDO and dispatches incoming commands
 * to the local runner HTTP server.
 */
export async function connectViaRelay(
	instanceIds: string[],
	localUrl: string,
	runnerToken: string,
	opts: PagsRequestOptions,
	force = false,
): Promise<void> {
	const apiBase = pagsApiBase(opts.apiBase).replace(/^http/, "ws"); // https → wss
	const pagsToken = clean(opts.pagsToken) || clean(process.env.PAGS_TOKEN) || clean(loadSession()?.token);
	if (!pagsToken) throw new Error("PAGS token required for WebSocket relay");
	const runnerNode = hostname();

	// Register the runtime (needed for the status badge / getRunnerConn)
	const capabilities = await requestRunner<{ capabilities?: unknown }>("GET", "/capabilities", { url: localUrl, token: runnerToken, instanceId: instanceIds[0] });
	const caps = Array.isArray(capabilities.capabilities) ? capabilities.capabilities.filter((item): item is string => typeof item === "string") : [];
	for (const id of instanceIds) {
		try {
			await requestPags("POST", `/v1/instances/${apiPathSegment(id)}/runtime`, opts, {
				endpointUrl: localUrl,
				token: runnerToken,
				placement: "local",
				capabilities: caps,
				runnerVersion: CLI_VERSION,
				runnerNode,
				force,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			writeError(`register ${id.slice(0, 8)}… failed: ${msg}`);
		}
	}

	for (const id of instanceIds) {
		// Each connect mints a fresh instance-scoped relay token using the account
		// session token (resolved above; opts.pagsToken may be unset if it came from
		// the saved session).
		const mintToken = () =>
			requestPags<{ token: string }>("POST", `/v1/relay/${apiPathSegment(id)}/token`, { ...opts, pagsToken }, {}).then((r) => r.token);
		openRelaySocket(id, apiBase, mintToken, localUrl, runnerToken, force);
	}

	writeLine("Runtime registered with PAGS ✓");
	writeLine("");
	writeLine("═══════════════════════════════════════════════");
	writeLine(`  ✅ CONNECTED — WebSocket relay · ${hostname()}`);
	writeLine(`  Agents:   ${instanceIds.length} instance${instanceIds.length === 1 ? "" : "s"}`);
	writeLine("  No cloudflared needed. Ctrl+C to disconnect.");
	writeLine("═══════════════════════════════════════════════");

	// Heartbeat loop — keeps the runtime status "online" in D1.
	// Uses unref'd timers so the loop doesn't prevent process exit.
	const heartbeat = () => {
		const timer = setTimeout(async () => {
			for (const id of instanceIds) {
				await requestPags("POST", `/v1/instances/${apiPathSegment(id)}/runtime/heartbeat`, opts, { runnerNode }).catch(() => undefined);
			}
			heartbeat();
		}, 30_000);
		timer.unref(); // don't keep the process alive just for heartbeats
	};
	heartbeat();
}

export function openRelaySocket(
	instanceId: string,
	wsBase: string,
	mintToken: () => Promise<string>,
	localUrl: string,
	runnerToken: string,
	force = false,
): void {
	let backoffMs = 1000;
	let reconnecting = false;

	const connect = async () => {
		// Mint a fresh short-lived, instance-scoped relay token per connect — the
		// long-lived account session token is never placed in the WS URL.
		let relayToken: string;
		try {
			relayToken = await mintToken();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// 402 = the runner is a Pro feature and this account isn't subscribed.
			// Retrying can never succeed — surface the upgrade message and stop
			// (otherwise a free user sits in an infinite mint-retry loop).
			if (/^402\b/.test(msg)) {
				writeLine(`Runner unavailable for ${instanceId.slice(0, 8)}…: ${msg.replace(/^402\s*/, "")}`);
				return;
			}
			const hint = /401|token|sign/i.test(msg) ? " (run `pags login`)" : "";
			writeLine(`Relay token mint failed: ${instanceId.slice(0, 8)}…${hint} — retrying in ${Math.round(backoffMs / 1000)}s`);
			setTimeout(() => { connect(); }, backoffMs);
			backoffMs = Math.min(backoffMs * 2, 30_000);
			return;
		}
		const params = new URLSearchParams({ token: relayToken, node: hostname() });
		if (force) params.set("force", "1");
		const url = `${wsBase}/v1/relay/${encodeURIComponent(instanceId)}/connect?${params.toString()}`;
		const ws = new WebSocket(url);

		ws.onopen = () => {
			backoffMs = 1000;
			writeLine(`Relay connected: ${instanceId.slice(0, 8)}…`);
		};

		ws.onmessage = async (event) => {
			const text = typeof event.data === "string" ? event.data : String(event.data);
			// Server pings to verify liveness — respond with pong
			if (text === "ping") { try { ws.send("pong"); } catch { /* closed */ } return; }
			let cmd: { id: string; method?: string; path: string; body?: unknown };
			try {
				cmd = JSON.parse(text) as { id: string; method?: string; path: string; body?: unknown };
			} catch {
				return;
			}
			if (!cmd.id || !cmd.path) return;

			// Dispatch to local runner HTTP server
			const method = (cmd.method || "POST").toUpperCase();
			const hasBody = method !== "GET" && method !== "HEAD" && cmd.body !== undefined;
			try {
				const headers: Record<string, string> = {};
				if (hasBody) headers["Content-Type"] = "application/json";
				if (runnerToken) headers.Authorization = `Bearer ${runnerToken}`;
				headers["X-PAGS-Instance-Id"] = instanceId;
				const res = await fetch(`${localUrl}${cmd.path}`, {
					method,
					headers,
					body: hasBody ? JSON.stringify(cmd.body) : undefined,
				});
				const text = await res.text().catch(() => "");
				let result: unknown;
				try { result = text ? JSON.parse(text) : {}; } catch { result = { raw: text.slice(0, 500) }; }
				try { ws.send(JSON.stringify({ id: cmd.id, status: res.status, result })); } catch { /* WS closed mid-flight */ }
			} catch (err) {
				try { ws.send(JSON.stringify({ id: cmd.id, status: 500, error: err instanceof Error ? err.message : String(err) })); } catch { /* WS closed */ }
			}
		};

		ws.onclose = (ev) => {
			if (reconnecting) return;
			reconnecting = true;
			// Report what the server actually SAID. The old branch tested for 4401/1008 — codes
			// nothing in the codebase ever sends — so every real rejection (409 "another runner",
			// 401 after a key rotation) arrived as a bare 1006 and the message was dropped,
			// leaving the user watching an identical reconnect line forever.
			const said = (ev.reason || "").trim();
			const hint = ev.code === 4401 ? " — run `pags login`, then `pags up`" : ev.code === 4409 ? " — run `pags up --force` to take over" : "";
			const reason = said ? ` (${said}${hint})` : ev.code === 1008 ? " (token expired — run `pags login` then `pags up`)" : "";
			writeLine(`Relay disconnected: ${instanceId.slice(0, 8)}…${reason} — reconnecting in ${Math.round(backoffMs / 1000)}s`);
			setTimeout(() => {
				reconnecting = false;
				connect();
			}, backoffMs);
			backoffMs = Math.min(backoffMs * 2, 30_000);
		};

		ws.onerror = () => {
			// onclose will fire after onerror -- reconnect handled there
		};
	};

	connect();
}
