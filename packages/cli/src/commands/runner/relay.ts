import { hostname } from "node:os";
import { loadSession } from "../login.js";
import { loadMachineIdentity } from "../../machine.js";
import { writeError, writeLine } from "../../output.js";
import { apiPathSegment, clean, pagsApiBase, requestPags, requestRunner } from "./http.js";
import { CLI_VERSION } from "./process.js";
import { diffMembership, instanceLabel, pendingRegistrations, shouldRegisterOnOpen, type DiscoverableInstance } from "./membership.js";
import { formatStatusLine } from "./status-line.js";
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
	/** Poll for newly eligible instances and attach them without a restart (#229). Off for a
	 *  scoped `pags up --instance X`, which must stay exactly as narrow as the user asked. */
	watchInstances = false,
): Promise<void> {
	const apiBase = pagsApiBase(opts.apiBase).replace(/^http/, "ws"); // https → wss
	const pagsToken = clean(opts.pagsToken) || clean(process.env.PAGS_TOKEN) || clean(loadSession()?.token);
	if (!pagsToken) throw new Error("PAGS token required for WebSocket relay");
	const runnerNode = hostname();
	// The hostname stays the routing key — it names the relay DO — but it is NOT this machine's
	// identity: it moves with the network. The persisted id is what lets the server recognise a
	// renamed machine as the same one, so a pin made under an old name keeps working (#379).
	const machine = loadMachineIdentity(runnerNode);

	// Register the runtime (needed for the status badge / getRunnerConn)
	const capabilities = await requestRunner<{ capabilities?: unknown }>("GET", "/capabilities", { url: localUrl, token: runnerToken, instanceId: instanceIds[0] });
	const caps = Array.isArray(capabilities.capabilities) ? capabilities.capabilities.filter((item): item is string => typeof item === "string") : [];
	// Which instances currently hold a runtime registration from THIS machine. Tracked, not
	// assumed: a register that failed at startup used to be lost forever (nothing retried it),
	// and the pane still printed a tick because the success line was unconditional (#497).
	const registered = new Set<string>();
	let lastRegisterError = "";
	const registerRuntime = async (id: string, forceClaim = force): Promise<boolean> => {
		try {
			await requestPags("POST", `/v1/instances/${apiPathSegment(id)}/runtime`, opts, {
				endpointUrl: localUrl,
				token: runnerToken,
				placement: "local",
				capabilities: caps,
				runnerVersion: CLI_VERSION,
				runnerNode,
				machineId: machine.id,
				machineNames: machine.names,
				force: forceClaim,
			});
			registered.add(id);
			return true;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			registered.delete(id);
			lastRegisterError = msg;
			writeError(`register ${id.slice(0, 8)}… failed: ${msg}`);
			return false;
		}
	};
	/** Tell the parent TUI what registration actually stands at — see status-line.ts. */
	const reportRegistration = () => {
		const agents = `${registered.size}/${instanceIds.length}`;
		const state = registered.size === instanceIds.length ? "ok" : registered.size === 0 ? "fail" : "partial";
		writeLine(formatStatusLine({ registration: state, agents, reason: state === "ok" ? undefined : lastRegisterError }));
	};
	for (const id of instanceIds) await registerRuntime(id);

	// The live membership set. A captured array is what made a newly subscribed agent
	// unreachable until restart (#229); sockets are now added and removed while running.
	const attached = new Map<string, RelaySocketHandle>();
	// Instances another live runner owns (4409). Kept out of re-attach until the block clears.
	const blocked = new Set<string>();

	const attach = (id: string, label = `${id.slice(0, 8)}…`) => {
		if (attached.has(id)) return;
		// Each connect mints a fresh instance-scoped relay token using the account
		// session token (resolved above; opts.pagsToken may be unset if it came from
		// the saved session).
		const mintToken = () =>
			requestPags<{ token: string }>("POST", `/v1/relay/${apiPathSegment(id)}/token`, { ...opts, pagsToken }, {}).then((r) => r.token);
		attached.set(
			id,
			openRelaySocket(
				id,
				apiBase,
				mintToken,
				localUrl,
				runnerToken,
				force,
				(conflicted) => {
					blocked.add(conflicted);
					attached.delete(conflicted);
				},
				// Registration rides the RECONNECT, which is the whole wake case (#497). The socket
				// retries with backoff; `POST …/runtime` did not, so after a sleep the machine had a
				// live relay and no runtime row — and `resumeSessionsForNode`, which lives inside that
				// route, never ran either, so its own suspended coding sessions stayed suspended. The
				// upsert is idempotent, so re-registering on every reconnect is safe. The first open
				// is skipped when the register already succeeded above (or in the discovery pass),
				// and taken when it did not — which is how a register lost to a boot-time
				// `fetch failed` finally gets a second chance.
				async (openedId, reconnect) => {
					if (!shouldRegisterOnOpen(reconnect, registered.has(openedId))) return;
					// A reconnect REFRESHES the row; it does not re-claim. `--force` suspends coding
					// sessions owned by other machines, and that is a one-time act the user asked for
					// at startup — a network blip must not repeat it on every socket that comes back.
					// `resumeSessionsForNode`, the half this machine needs after a wake, runs either
					// way (`routes/instances.ts:365`, outside the force branch).
					await registerRuntime(openedId, reconnect ? false : force);
					reportRegistration();
				},
			),
		);
		if (label) writeLine(`Attached agent: ${label}`);
	};

	const detach = (id: string, label = `${id.slice(0, 8)}…`) => {
		const handle = attached.get(id);
		if (!handle) return;
		handle.close();
		attached.delete(id);
		writeLine(`Detached agent: ${label}`);
	};

	for (const id of instanceIds) attach(id, "");

	// Was "Runtime registered with PAGS ✓", printed after the register loop whether or not a
	// single register had succeeded — and the TUI turned that string into the green light (#497).
	reportRegistration();
	writeLine(registered.size === instanceIds.length
		? `Runtime registered with PAGS ✓ (${registered.size}/${instanceIds.length} agents)`
		: `Runtime registration incomplete: ${registered.size}/${instanceIds.length} agents — retried on each relay (re)connect${watchInstances ? " and every 20s while this runs" : ""}.`);
	writeLine("");
	writeLine("═══════════════════════════════════════════════");
	writeLine(`  ✅ CONNECTED — WebSocket relay · ${hostname()}`);
	writeLine(`  Agents:   ${instanceIds.length} instance${instanceIds.length === 1 ? "" : "s"}`);
	writeLine("  No cloudflared needed. Ctrl+C to disconnect.");
	writeLine("═══════════════════════════════════════════════");

	// Heartbeat loop — keeps the runtime status "online" in D1.
	// Uses unref'd timers so the loop doesn't prevent process exit.
	//
	// Reported on TRANSITION, not per beat. A silently dropped heartbeat is not a lost metric:
	// this is the only thing that keeps the console's runner badge online, so once it starts
	// failing the console says "runner offline — run `pags up`" while this window still says
	// CONNECTED, with nothing anywhere explaining the contradiction. The documented remedy for
	// that banner is `pags up --force`, which SUSPENDS coding sessions owned by other machines —
	// so the silence steered the user toward a destructive action. Once per state change keeps
	// a 30s loop from becoming a log spammer.
	let heartbeatFailing = false;
	const heartbeat = () => {
		const timer = setTimeout(async () => {
			// The live set, not the startup array — a heartbeat for a detached instance would
			// keep it looking online, and a newly attached one would look offline until restart.
			let failure: string | null = null;
			for (const id of [...attached.keys()]) {
				try {
					await requestPags("POST", `/v1/instances/${apiPathSegment(id)}/runtime/heartbeat`, opts, { runnerNode });
				} catch (e) {
					failure = e instanceof Error ? e.message : String(e);
				}
			}
			if (failure && !heartbeatFailing) {
				heartbeatFailing = true;
				// The status line is what the pane reads. Before it existed, this message's
				// `fetch failed` was matched as a REGISTRATION failure — so a 30-second heartbeat
				// blip put a permanent ✗ next to "ProAgentStore" for a machine that was fine.
				writeLine(formatStatusLine({ heartbeat: "fail", reason: failure }));
				writeError(`Heartbeat failed: ${failure} — the console will show this machine as OFFLINE until it recovers. The relay itself is still connected; don't run \`pags up --force\` elsewhere.`);
			} else if (!failure && heartbeatFailing) {
				heartbeatFailing = false;
				writeLine(formatStatusLine({ heartbeat: "ok" }));
				writeLine("Heartbeat recovered — this machine reads as online again.");
			}
			heartbeat();
		}, 30_000);
		timer.unref(); // don't keep the process alive just for heartbeats
	};
	heartbeat();

	if (watchInstances) startDiscovery();

	/**
	 * Let go of a conflict that has ended (#497).
	 *
	 * `blocked` had an `add` and no `delete`, which contradicted its own comment ("clearing the
	 * block … lets the next pass attach") and made ONE 4409 permanent for the life of the process.
	 * That is the difference between an agent that comes back on its own and one that comes back
	 * when a human notices and restarts the CLI — and the conflict does end by itself: a holder
	 * that exits takes its socket with it, and an abandoned socket is evicted server-side.
	 *
	 * One cheap status GET per blocked id per pass — not a reconnect. #237 was about a socket
	 * retrying a permanent conflict every 30s and logging it forever; this neither opens a socket
	 * nor logs unless something changed.
	 */
	async function clearFinishedConflicts(): Promise<void> {
		for (const id of [...blocked]) {
			const free = await requestPags<{ connected?: boolean }>(
				"GET",
				`/v1/relay/${apiPathSegment(id)}/status`,
				{ ...opts, pagsToken },
			).then((r) => r.connected === false).catch(() => false);
			if (!free) continue;
			blocked.delete(id);
			writeLine(`Relay conflict cleared: ${id.slice(0, 8)}… — the other runner is gone; reattaching.`);
		}
	}

	/**
	 * Poll for membership changes. Deliberately polling, not server push: a brand-new instance
	 * has no socket for the server to push over, so the first version of this cannot be
	 * realtime (#83 tracks the push path). 20s is under the console's own status refresh, so
	 * the panel flips to connected on its own without feeling like a restart.
	 */
	function startDiscovery(): void {
		const tick = () => {
			const timer = setTimeout(async () => {
				try {
					await clearFinishedConflicts();
					const res = await requestPags<{ instances?: DiscoverableInstance[] }>(
						"GET",
						"/v1/instances/my/instances",
						{ ...opts, pagsToken },
					);
					const { attach: toAttach, detach: toDetach } = diffMembership(
						attached.keys(),
						res.instances ?? [],
						runnerNode,
						blocked,
						// The names this machine has also worn. Without them a pin made under a
						// previous hostname reads as "pinned to another machine", and this poll
						// detaches the agent twenty seconds after startup attached it (#379).
						machine.names,
					);
					for (const inst of toAttach) {
						await registerRuntime(inst.id);
						attach(inst.id, instanceLabel(inst));
					}
					for (const id of toDetach) detach(id);
					// The registration retry nothing else performs (#497). A socket that came up while
					// its `POST …/runtime` failed is the exact state the original report showed — the
					// secure link connected, ProAgentStore "not registered" — and until this, the only
					// thing that could clear it was the socket dropping again, which on a machine that
					// stays awake may never happen. Silent when healthy: an empty list writes nothing.
					const pending = pendingRegistrations(attached.keys(), registered);
					if (pending.length) {
						for (const id of pending) await registerRuntime(id);
						reportRegistration();
					}
				} catch {
					// A failed poll is not worth a log line every 20s — the next one retries, and
					// a genuinely broken session already surfaces on the relay sockets.
				}
				tick();
			}, 20_000);
			timer.unref();
		};
		tick();
	}
}

export interface RelaySocketHandle {
	/** Stop reconnecting and close the socket. Detaching an instance must not leave a
	 *  reconnect timer alive — it would re-open a socket for an agent we no longer serve. */
	close(): void;
}

export function openRelaySocket(
	instanceId: string,
	wsBase: string,
	mintToken: () => Promise<string>,
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
): RelaySocketHandle {
	let backoffMs = 1000;
	let reconnecting = false;
	let closed = false;
	let opened = false;
	let socket: WebSocket | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;

	const connect = async () => {
		if (closed) return;
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
			retryTimer = setTimeout(() => { connect(); }, backoffMs);
			backoffMs = Math.min(backoffMs * 2, 30_000);
			return;
		}
		const params = new URLSearchParams({ token: relayToken, node: hostname() });
		if (force) params.set("force", "1");
		const url = `${wsBase}/v1/relay/${encodeURIComponent(instanceId)}/connect?${params.toString()}`;
		const ws = new WebSocket(url);
		socket = ws;

		ws.onopen = () => {
			backoffMs = 1000;
			const reconnect = opened;
			opened = true;
			writeLine(`Relay connected: ${instanceId.slice(0, 8)}…`);
			// Fire-and-forget: a failing re-registration must not take the socket down with it —
			// it is retried on the next reconnect, and reported through the status line meanwhile.
			void Promise.resolve(onOpen?.(instanceId, reconnect)).catch(() => undefined);
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
			if (closed || reconnecting) return;
			// Another live runner owns this instance. Reconnecting cannot win it, and doing so
			// every backoff produced an identical line forever; tell the caller so discovery
			// stops re-attaching, and say what actually fixes it.
			if (ev.code === 4409 && !force) {
				writeLine(`Relay conflict: ${instanceId.slice(0, 8)}… is connected on another machine — run \`pags up --force\` here to take it over.`);
				closed = true;
				onConflict?.(instanceId);
				return;
			}
			reconnecting = true;
			// Report what the server actually SAID. The old branch tested for 4401/1008 — codes
			// nothing in the codebase ever sends — so every real rejection (409 "another runner",
			// 401 after a key rotation) arrived as a bare 1006 and the message was dropped,
			// leaving the user watching an identical reconnect line forever.
			const said = (ev.reason || "").trim();
			const hint = ev.code === 4401 ? " — run `pags login`, then `pags up`" : ev.code === 4409 ? " — run `pags up --force` to take over" : "";
			const reason = said ? ` (${said}${hint})` : ev.code === 1008 ? " (token expired — run `pags login` then `pags up`)" : "";
			writeLine(`Relay disconnected: ${instanceId.slice(0, 8)}…${reason} — reconnecting in ${Math.round(backoffMs / 1000)}s`);
			retryTimer = setTimeout(() => {
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

	return {
		close() {
			closed = true;
			if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
			try { socket?.close(); } catch { /* already closed */ }
			socket = null;
		},
	};
}
