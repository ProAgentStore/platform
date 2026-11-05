/** One relay connection lifecycle, independent from membership/update orchestration (#1555). */
import { hostname } from "node:os";
import { browserSettingsBody, browserSettingsHeaders } from "./browser-settings.js";
import { writeLine } from "../../output.js";
import { RUNNER_RESTART_PATH, RUNNER_UPDATE_PATH } from "./self-update.js";
import { boundedRelayWork, relayIoLimits } from "./relay-io.js";

export const MEMBERSHIP_SYNC_PATH = "/pags/membership/sync";
const CLI_CONTROL_PATHS = new Set([MEMBERSHIP_SYNC_PATH, RUNNER_UPDATE_PATH, RUNNER_RESTART_PATH]);

export interface RelaySocketHandle {
	/** Stop reconnecting and close the socket. Detaching an instance must not leave a
	 *  reconnect timer alive — it would re-open a socket for an agent we no longer serve. */
	close(): void;
	/**
	 * Round trip of one probe through the relay, ms (#924) — "slow" vs "stuck" for this machine.
	 * Null when the socket is not open or no echo came back in time (a platform before the echo, or
	 * a relay too slow to answer within the timeout — which is itself the reading).
	 */
	probeRtt(timeoutMs?: number): Promise<number | null>;
}

/** How long a relayed command may wait on the local runtime (#1169). Without it one wedged request held a mutation slot — and
 *  so the update drain — forever. Mutable so a test need not wait ten minutes. */
export const relayLimits = { forwardMs: 600_000 };

/** The reason a forward is aborted with when the relay sends `{ type: "cancel", id }` (#1358). */
const CANCELLED_BY_RELAY = "cancelled by the relay";

/** The relay echo protocol (#924): the runner sends `rtt:<id>`, the RelayDO answers `rtt-echo:<id>`. */
export const RTT_PROBE_PREFIX = "rtt:";
export const RTT_ECHO_PREFIX = "rtt-echo:";

/**
 * Half-open detection (#1168). A socket the network dropped silently (NAT timeout, Wi-Fi change) never fires `onclose`, so
 * nothing would ever reconnect it while the heartbeat kept the machine looking fresh. Incoming cloud pings prove only the
 * inbound path (#1544), so require a correlated round trip every `idleMs`. Two failed probes recycle the socket; one lost echo
 * is tolerated. Successful heartbeat RTT probes count too. A healthy socket costs one tiny frame per `idleMs`.
 */
export interface RelayLiveness {
	idleMs: number;
	probeTimeoutMs: number;
	checkEveryMs: number;
}
export const DEFAULT_RELAY_LIVENESS: RelayLiveness = { idleMs: 60_000, probeTimeoutMs: 10_000, checkEveryMs: 15_000 };

export function openRelaySocket(
	instanceId: string,
	wsBase: string,
	mintToken: (signal?: AbortSignal) => Promise<string>,
	localUrl: string,
	runnerToken: string,
	force = false,
	/** Called when the server says another live runner owns this instance (4409). Retrying
	 *  can never succeed while that runner holds it, so the caller stops re-attaching rather
	 *  than turning a permanent conflict into an endless reconnect log (#229). */
	onConflict?: (instanceId: string) => void,
	/** Called on every successful open, with whether this open is a RE-connect. The socket is the
	 *  only thing here that retries, so anything that must survive a wake has to ride it (#497). */
	onOpen?: (instanceId: string, reconnect: boolean) => void | Promise<void>,
	/** Answers a cloud → CLI control command (#850) instead of forwarding it to the local runner. */
	onControl?: (path: string, body?: unknown) => Promise<{ status: number; result: unknown }>,
	/** The node name this socket connects under — the SAME one the process registers and heartbeats
	 *  under (#922). Read once, not per connect: `os.hostname()` moves under a machine (#379), and a
	 *  socket that followed it opened in a relay slot no registration names, so every status read
	 *  probed the registered name, found no socket, and reported a live machine as disconnected while
	 *  its heartbeat kept `lastSeenAt` fresh — and the slot it was in never had its own row stamped. */
	runnerNode: string = hostname(),
	/** Returns a release handle for an admitted mutation, or null while the safe-update drain is
	 * closed. Read-only probes do not participate. */
	beginMutation: () => (() => void) | null = () => () => undefined,
	/**
	 * Why this agent may not reach `method path` on the local runtime, or null (#1164). Asked of every
	 * relayed command before it is forwarded: the socket names the agent, and the agent's declared
	 * capabilities name the routes it needs (`route-policy.ts`). Absent: nothing is refused.
	 */
	routeRefusal: (method: string, path: string, body?: unknown) => string | null = () => null,
	liveness: RelayLiveness = DEFAULT_RELAY_LIVENESS,
): RelaySocketHandle {
	let backoffMs = 1000;
	let reconnecting = false;
	let closed = false;
	let opened = false;
	let socket: WebSocket | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let generation = 0;
	let attempt: AbortController | null = null;
	let openingTimer: ReturnType<typeof setTimeout> | null = null;
	const rttWaiters = new Map<string, { ws: WebSocket; settle: (echoedAt: number | null) => void }>();
	/** The commands being forwarded to the local runtime, by relay command id, so a relay `cancel` can stop the right one (#1358). */
	const inflight = new Map<string, AbortController>();
	let lastVerifiedAt = Date.now();
	let failedProbes = 0;
	let watchdog: ReturnType<typeof setInterval> | null = null;

	const stopWatchdog = () => {
		if (watchdog) { clearInterval(watchdog); watchdog = null; }
	};

	const scheduleReconnect = (message: string) => {
		if (closed || reconnecting) return;
		reconnecting = true;
		writeLine(`${message} — reconnecting in ${Math.round(backoffMs / 1000)}s`);
		retryTimer = setTimeout(() => {
			reconnecting = false;
			retryTimer = null;
			void connect();
		}, backoffMs);
		retryTimer.unref?.();
		backoffMs = Math.min(backoffMs * 2, 30_000);
	};

	/** One echo probe through `ws`: the round trip in ms, or null when it could not be sent or nothing came back in time. */
	const probe = (ws: WebSocket, timeoutMs: number): Promise<number | null> => {
		if (closed || socket !== ws) return Promise.resolve(null);
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const sentAt = Date.now();
		return new Promise<number | null>((resolveRtt) => {
			const timer = setTimeout(() => { rttWaiters.delete(id); resolveRtt(null); }, timeoutMs);
			timer.unref?.();
			rttWaiters.set(id, { ws, settle: (echoedAt) => {
				clearTimeout(timer); rttWaiters.delete(id);
				if (echoedAt !== null && socket === ws && !closed) { lastVerifiedAt = echoedAt; failedProbes = 0; }
				resolveRtt(echoedAt === null ? null : echoedAt - sentAt);
			} });
			try { ws.send(`${RTT_PROBE_PREFIX}${id}`); } catch { clearTimeout(timer); rttWaiters.delete(id); resolveRtt(null); }
		});
	};

	/** Disposing transport never replays or cancels a mutation already accepted by the local runtime. */
	const disposeSocket = (ws: WebSocket) => {
		if (socket === ws) {
			stopWatchdog();
			if (openingTimer) { clearTimeout(openingTimer); openingTimer = null; }
			socket = null;
		}
		for (const waiter of [...rttWaiters.values()]) if (waiter.ws === ws) waiter.settle(null);
		ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
		try { ws.close(); } catch { /* already gone */ }
	};
	const current = (ws: WebSocket, epoch: number) => !closed && socket === ws && generation === epoch;
	const recycle = (ws: WebSocket, message: string) => {
		generation++;
		attempt?.abort(new Error("Relay connection replaced"));
		disposeSocket(ws);
		scheduleReconnect(message);
	};

	const startWatchdog = (ws: WebSocket) => {
		stopWatchdog();
		let probing = false;
		watchdog = setInterval(() => {
			if (closed || socket !== ws || probing) return;
			const unverifiedMs = Date.now() - lastVerifiedAt;
			if (unverifiedMs < liveness.idleMs) return;
			probing = true;
			const startedAt = Date.now();
			void probe(ws, liveness.probeTimeoutMs).then((rtt) => {
				probing = false;
				// A correlated echo (including a concurrent heartbeat probe) proves BOTH directions. Inbound pings do not.
				if (closed || socket !== ws || rtt !== null || lastVerifiedAt >= startedAt) return;
				if (++failedProbes < 2) return; // tolerate one lost echo before replacing the connection
				recycle(ws, `Relay round trip failed: ${instanceId.slice(0, 8)}… no verified response after two probes (half-open socket)`);
			});
		}, liveness.checkEveryMs);
		watchdog.unref?.();
	};

	const connect = async () => {
		if (closed) return;
		const epoch = ++generation;
		const owner = new AbortController(); attempt = owner;
		// Mint a fresh short-lived, instance-scoped relay token per connect — the
		// long-lived account session token is never placed in the WS URL.
		let relayToken: string;
		try {
			relayToken = await boundedRelayWork((signal) => mintToken(signal), relayIoLimits.mintMs, owner.signal);
		} catch (e) {
			if (closed || generation !== epoch) return;
			const msg = e instanceof Error ? e.message : String(e);
			// 402 = the runner is a Pro feature and this account isn't subscribed.
			// Retrying can never succeed — surface the upgrade message and stop
			// (otherwise a free user sits in an infinite mint-retry loop).
			if (/^402\b/.test(msg)) {
				writeLine(`Runner unavailable for ${instanceId.slice(0, 8)}…: ${msg.replace(/^402\s*/, "")}`);
				return;
			}
			const hint = /401|token|sign/i.test(msg) ? " (run `pags login`)" : "";
			scheduleReconnect(`Relay token mint failed: ${instanceId.slice(0, 8)}…${hint}`);
			return;
		}
		if (closed || generation !== epoch || owner.signal.aborted) return;
		const params = new URLSearchParams({ token: relayToken, node: runnerNode });
		if (force) params.set("force", "1");
		const url = `${wsBase}/v1/relay/${encodeURIComponent(instanceId)}/connect?${params.toString()}`;
		let ws: WebSocket;
		try { ws = new WebSocket(url); }
		catch { scheduleReconnect(`Relay connection could not open: ${instanceId.slice(0, 8)}…`); return; }
		socket = ws;
		openingTimer = setTimeout(() => {
			if (current(ws, epoch)) recycle(ws, `Relay opening timed out: ${instanceId.slice(0, 8)}…`);
		}, relayIoLimits.openingMs);
		openingTimer.unref?.();

		ws.onopen = () => {
			if (!current(ws, epoch)) return;
			if (openingTimer) { clearTimeout(openingTimer); openingTimer = null; }
			backoffMs = 1000;
			const reconnect = opened;
			opened = true;
			lastVerifiedAt = Date.now(); failedProbes = 0;
			startWatchdog(ws);
			writeLine(`Relay connected: ${instanceId.slice(0, 8)}…`);
			// Fire-and-forget: a failing re-registration must not take the socket down with it —
			// it is retried on the next reconnect, and reported through the status line meanwhile.
			void Promise.resolve().then(() => current(ws, epoch) ? onOpen?.(instanceId, reconnect) : undefined).catch(() => undefined);
		};

		ws.onmessage = async (event) => {
			if (!current(ws, epoch)) return;
			const text = typeof event.data === "string" ? event.data : String(event.data);
			// Server pings to verify liveness — respond with pong
			if (text === "ping") { try { ws.send("pong"); } catch { /* closed */ } return; }
			if (text.startsWith(RTT_ECHO_PREFIX)) { rttWaiters.get(text.slice(RTT_ECHO_PREFIX.length))?.settle(Date.now()); return; }
			let cmd: { type?: string; id: string; method?: string; path: string; body?: unknown; browserMode?: unknown; browserEngine?: unknown; browserProfilePolicy?: unknown; browserWebsiteAccess?: unknown };
			try {
				cmd = JSON.parse(text) as { type?: string; id: string; method?: string; path: string; body?: unknown; browserMode?: unknown; browserEngine?: unknown; browserProfilePolicy?: unknown; browserWebsiteAccess?: unknown };
			} catch {
				return;
			}
			// The relay has stopped waiting for this command (#1358): stop forwarding it. The relay already told its caller it timed
			// out, so there is no reply to send — only a local request, and the mutation slot it holds, to let go of.
			if (cmd.type === "cancel" && cmd.id) {
				inflight.get(cmd.id)?.abort(new Error(CANCELLED_BY_RELAY));
				return;
			}
			if (!cmd.id || !cmd.path) return;
			if (onControl && CLI_CONTROL_PATHS.has(cmd.path)) {
				// A detach this pass performs may close THIS socket — the reply is then lost, and the
				// cloud reads the socket going away as the answer it is.
				const reply = await onControl(cmd.path, cmd.body).catch((err) => ({ status: 500, result: { error: err instanceof Error ? err.message : String(err) } }));
				try { ws.send(JSON.stringify({ id: cmd.id, ...reply })); } catch { /* closed by the detach */ }
				return;
			}

			// Dispatch to local runner HTTP server
			const method = (cmd.method || "POST").toUpperCase();
			// Only the routes THIS agent's declared capabilities need (#1164) — refused here, before the
			// runtime, so a socket cannot reach another kind of agent's routes on this machine.
			const refused = routeRefusal(method, cmd.path, cmd.body);
			if (refused) {
				try { ws.send(JSON.stringify({ id: cmd.id, status: 403, result: { error: refused } })); } catch { /* WS closed */ }
				return;
			}
			const releaseMutation = method !== "GET" && method !== "HEAD" ? beginMutation() : null;
			if (method !== "GET" && method !== "HEAD" && !releaseMutation) {
				// Do not let a new local/coding request begin between the final idle observation and
				// the supervised restart. The cloud already treats transient runner unavailability as
				// retryable; reporting it explicitly is safer than accepting work we are about to cut off.
				try { ws.send(JSON.stringify({ id: cmd.id, status: 503, result: { error: "Runner is draining for a safe automatic update; retry shortly." } })); } catch { /* WS closed */ }
				return;
			}
			const controller = new AbortController();
			inflight.set(cmd.id, controller);
			const forwardTimer = setTimeout(() => controller.abort(new DOMException("Local runtime forward timed out", "TimeoutError")), relayLimits.forwardMs);
			forwardTimer.unref?.();
			try {
				const localBody = browserSettingsBody(cmd);
				const hasBody = method !== "GET" && method !== "HEAD" && localBody !== undefined;
				const headers: Record<string, string> = {};
				if (hasBody) headers["Content-Type"] = "application/json";
				if (runnerToken) headers.Authorization = `Bearer ${runnerToken}`;
				headers["X-PAGS-Instance-Id"] = instanceId;
				Object.assign(headers, browserSettingsHeaders(cmd));
				// The forward's own limit, and the relay's cancel, both end the same request.
				const res = await fetch(`${localUrl}${cmd.path}`, {
					method,
					headers,
					body: hasBody ? JSON.stringify(localBody) : undefined,
					signal: controller.signal,
				});
				const text = await res.text().catch(() => "");
				let result: unknown;
				// Marked (#898): a non-JSON reply cut silently read as the runner's whole answer.
				try { result = text ? JSON.parse(text) : {}; } catch { result = text.length > 500 ? { raw: text.slice(0, 500), rawChars: text.length, truncated: true } : { raw: text }; }
				try { ws.send(JSON.stringify({ id: cmd.id, status: res.status, result })); } catch { /* WS closed mid-flight */ }
			} catch (err) {
				// Cancelled by the relay: its caller has already been told, so nothing is sent back.
				if (controller.signal.aborted && (controller.signal.reason as Error | undefined)?.message === CANCELLED_BY_RELAY) return;
				const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
				const error = timedOut ? `The local runtime did not answer within ${Math.round(relayLimits.forwardMs / 1000)}s.` : err instanceof Error ? err.message : String(err);
				try { ws.send(JSON.stringify({ id: cmd.id, status: timedOut ? 504 : 500, error })); } catch { /* WS closed */ }
			} finally {
				clearTimeout(forwardTimer);
				inflight.delete(cmd.id);
				releaseMutation?.();
			}
		};

		ws.onclose = (ev) => {
			if (!current(ws, epoch)) return;
			generation++; owner.abort(new Error("Relay socket closed")); disposeSocket(ws);
			// Another live runner owns this instance. Reconnecting cannot win it, and doing so
			// every backoff produced an identical line forever; tell the caller so discovery
			// stops re-attaching, and say what actually fixes it.
			if (ev.code === 4409 && !force) {
				writeLine(`Relay conflict: ${instanceId.slice(0, 8)}… is connected on another machine — run \`pags up --force\` here to take it over.`);
				closed = true;
				onConflict?.(instanceId);
				return;
			}
			// Report what the server actually SAID. The old branch tested for 4401/1008 — codes
			// nothing in the codebase ever sends — so every real rejection (409 "another runner",
			// 401 after a key rotation) arrived as a bare 1006 and the message was dropped,
			// leaving the user watching an identical reconnect line forever.
			const said = (ev.reason || "").trim();
			const hint = ev.code === 4401 ? " — run `pags login`, then `pags up`" : ev.code === 4409 ? " — run `pags up --force` to take over" : "";
			const reason = said ? ` (${said}${hint})` : ev.code === 1008 ? " (token expired — run `pags login` then `pags up`)" : "";
			scheduleReconnect(`Relay disconnected: ${instanceId.slice(0, 8)}…${reason}`);
		};

		ws.onerror = () => {
			if (current(ws, epoch)) recycle(ws, `Relay connection error: ${instanceId.slice(0, 8)}…`);
		};
	};

	void connect();

	return {
		close() {
			closed = true; generation++;
			attempt?.abort(new Error("Relay handle closed"));
			stopWatchdog();
			if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
			if (socket) disposeSocket(socket);
			for (const waiter of [...rttWaiters.values()]) waiter.settle(null);
		},
		probeRtt(timeoutMs = 5000) {
			const ws = socket;
			if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
			return probe(ws, timeoutMs);
		},
	};
}
