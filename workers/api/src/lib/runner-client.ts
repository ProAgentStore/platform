import { decryptKey } from "./crypto.js";
import { aliasNodesFor, type NodeRegistration } from "./machine-identity.js";
import { NO_SOCKET_MARKER, relayFailureIsDisconnect, RunnerUnreachableError } from "./runner-unreachable.js";
import { normalizeRunnerNode, readInstanceRunnerNode, relayNameForInstance } from "./runtime-nodes.js";
import type { Env } from "../types.js";

/** A resolved connection to a user's local browser runner (via WebSocket relay). */
export interface RunnerConn {
	endpointUrl: string;
	token: string;
	instanceId: string;
	userId: string;
	env: Env;
	runnerNode?: string;
	relayName: string;
}

/**
 * Resolve the connected runner for an instance and decrypt its bearer token.
 *
 * Returns null when no runner is online — and since #532 that sentence is TRUE. It used to be a
 * description of {@link getRunnerConnIgnoringLiveness} below, which answers a different question
 * (does a registration row exist), and the gap between the two is the whole defect: FOUR call sites
 * had independently written the same `relayConnected` workaround around it (both resolvers below,
 * the Pilot's reclaim, `startSessionOnRunner`), and the ones that had not were exactly the ones
 * reporting a machine that had been off for days as connected.
 *
 * Liveness is the RelayDO's answer, asked here, once. Callers that already probe — or that must
 * hold the row for a machine known to be dead, like the machine-switch reclaim — call
 * {@link getRunnerConnIgnoringLiveness} BY NAME, so the choice is visible at the call site rather
 * than implied by which helper happened to be imported.
 */
export async function getRunnerConn(env: Env, instanceId: string, userId: string, runnerNode?: string | null): Promise<RunnerConn | null> {
	const conn = await getRunnerConnIgnoringLiveness(env, instanceId, userId, runnerNode);
	if (!conn) return null;
	// The RESOLVED node, not the requested one: with no node the row carries the default runtime's
	// machine, and the relay is keyed per (instance, node). This is the same probe `getLiveRunnerConn`
	// used to make on the line after its own call, so the default path's behaviour is unchanged.
	if (!(await relayConnected(env, instanceId, conn.runnerNode ?? null).catch(() => false))) return null;
	return conn;
}

/**
 * The registration ROW for a machine, decrypted — with no claim that the machine is up (#532).
 *
 * For the two callers that need it and say so: a resolver that has already asked the relay itself
 * (and would otherwise pay for a second identical probe), and the machine-switch reclaim, which
 * exists precisely to act on a stamped node that is dead and must be able to see it.
 *
 * Anything that will report, gate, or route on the answer wants {@link getRunnerConn}.
 */
export async function getRunnerConnIgnoringLiveness(
	env: Env,
	instanceId: string,
	userId: string,
	runnerNode?: string | null,
): Promise<RunnerConn | null> {
	const node = normalizeRunnerNode(runnerNode);
	// WHAT `status` MEANS, because three defects in one month have turned on it (#238, #531, #532).
	//
	// It is the last thing a runner SAID about itself — `registered`/`online`, written by the
	// register + heartbeat routes. NOTHING CLEARS IT ON DISCONNECT: `RelayDO.webSocketClose` does
	// not touch D1, so a laptop whose lid closed months ago still reads `online` here forever.
	// `/runtime/status` will write `offline` only when a probe fails AND the heartbeat has already
	// gone stale, which by construction never happens for a machine that simply stopped calling.
	//
	// So this predicate excludes a runner that was explicitly marked down, and NOTHING ELSE. It is
	// not liveness and must never be read as liveness. Liveness is `relayConnected` — the RelayDO
	// holds the socket — and since #532 the one function responsible for asking it on this row's
	// behalf is {@link getRunnerConn}, directly above.
	const row = await env.DB.prepare(
		node
			? "SELECT endpoint_url, token_plaintext, token_ciphertext, token_dek_wrapped, token_iv, runner_node FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3 AND status != 'offline'"
			: "SELECT endpoint_url, token_plaintext, token_ciphertext, token_dek_wrapped, token_iv, runner_node FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2 AND status != 'offline'",
	)
		.bind(...(node ? [instanceId, userId, node] : [instanceId, userId]))
		.first<{
			endpoint_url: string;
			token_plaintext: string | null;
			token_ciphertext: ArrayBuffer | null;
			token_dek_wrapped: ArrayBuffer | null;
			token_iv: ArrayBuffer | null;
			runner_node?: string | null;
		}>();
	if (!row?.endpoint_url) return null;

	let token = row.token_plaintext || "";
	if (!token && row.token_ciphertext && row.token_dek_wrapped && row.token_iv && env.KEY_ENCRYPTION_KEY) {
		try {
			token = await decryptKey(
				new Uint8Array(row.token_ciphertext),
				new Uint8Array(row.token_dek_wrapped),
				new Uint8Array(row.token_iv),
				env.KEY_ENCRYPTION_KEY,
			);
		} catch {
			/* fall through with empty token */
		}
	}
	const resolvedNode = normalizeRunnerNode(row.runner_node || node);
	return {
		endpointUrl: row.endpoint_url.replace(/\/$/, ""),
		token,
		instanceId,
		userId,
		env,
		runnerNode: resolvedNode || undefined,
		relayName: relayNameForInstance(instanceId, resolvedNode),
	};
}

/**
 * Resolve the runner for an instance honoring its node binding (`config.runnerNode`).
 * This is the connection every runner feature (chat tools, apply, coding) should use so a
 * user with several machines can say "this agent runs on that machine" and have it respected
 * CONSISTENTLY. When pinned, that machine is **authoritative**: we do NOT silently fall back
 * to another node when it's offline — doing so would run the agent somewhere the user didn't
 * choose and misreport "online" for the wrong machine. Pinned + offline → null (the agent is
 * offline; the user can start that machine or repin). Unpinned → the legacy default runtime.
 */
export async function getBoundRunnerConn(env: Env, instanceId: string, userId: string): Promise<RunnerConn | null> {
	// A read failure is NOT "unpinned". Treating it as one walks straight into the fallback this
	// function's contract forbids two lines below — running the agent on a machine the user did not
	// choose, in a different checkout, and reporting that machine as online. When the pin cannot be
	// read, the honest answer is the same as pinned-and-offline: no connection, retry.
	const node = await readInstanceRunnerNode(env, instanceId, userId).catch(() => null);
	if (node === null) return null;
	if (node) {
		// Pinned = authoritative: only that machine, and only if its relay socket is ACTUALLY
		// live. We can't trust the DB `status` column — it's never cleared when a runner drops
		// (RelayDO.webSocketClose doesn't touch D1), so a machine that closed its laptop still
		// reads `registered`. The RelayDO is the only source of truth. Pinned + dead → offline.
		if (await relayConnected(env, instanceId, node).catch(() => false)) {
			// Already probed, on this exact node — the loader, so the socket is not asked about twice.
			return getRunnerConnIgnoringLiveness(env, instanceId, userId, node);
		}
		// The pinned NAME is dead — but a name is not a machine (#379). `os.hostname()` moves under
		// the machine (DHCP, VPN, the `.local` mDNS form), so a pin can outlive the name it was
		// made with while the machine it means is right here with a live socket. Route to a node
		// that carries the SAME persisted `machine_id`: that is the pinned machine, proven by a
		// recorded fact rather than inferred, so it does NOT breach the no-fallback contract above.
		// No id recorded → no candidates → the same null as before.
		for (const alias of await sameMachineNodes(env, instanceId, userId, node)) {
			if (await relayConnected(env, instanceId, alias).catch(() => false)) {
				return getRunnerConnIgnoringLiveness(env, instanceId, userId, alias);
			}
		}
		return null;
	}
	// Unpinned: route to whichever registered machine holds a LIVE relay socket right now —
	// not whatever the stale `instance_runtimes` default points at. A second `pags up` overwrites
	// that default row (to the newest machine) BEFORE its socket is up and it's never cleared on
	// disconnect, so trusting it silently repoints an unpinned agent at an offline machine.
	return getLiveRunnerConn(env, instanceId, userId);
}

/**
 * Node names that are the SAME MACHINE as `pinned`, freshest first (#379).
 *
 * Read across ALL the user's registrations, not just this instance's, because the pinned name may
 * belong to a machine this agent never registered on — that is precisely the stranded case. The
 * pure rule (and why an unknown id yields nothing) lives in `machine-identity.ts`.
 *
 * Only reached when the pinned name is already known to be dead, so the happy path pays nothing.
 */
async function sameMachineNodes(env: Env, instanceId: string, userId: string, pinned: string): Promise<string[]> {
	const { results } = await env.DB.prepare(
		`SELECT runner_node AS node, machine_id AS machineId, instance_id AS instanceId, last_seen_at AS lastSeenAt
		 FROM instance_runtime_nodes
		 WHERE user_id = ?1 AND runner_node IS NOT NULL AND runner_node != ''
		 ORDER BY updated_at DESC LIMIT 200`,
	)
		.bind(userId)
		.all<NodeRegistration>()
		.catch(() => ({ results: [] as NodeRegistration[] }));
	return aliasNodesFor(pinned, results ?? [], instanceId);
}

/**
 * Which node a stale pin ACTUALLY resolves to right now, or null (#379).
 *
 * The same question `getBoundRunnerConn` answers while routing, asked by the console so its card
 * can say "pinned to X; that machine now reports as Y" instead of warning about a pin that is
 * being honoured. Callers pass a pin they have already found to be dead — probing it again here
 * would only buy a duplicate relay fetch.
 */
export async function liveAliasForPin(env: Env, instanceId: string, userId: string, pinned: string): Promise<string | null> {
	for (const alias of await sameMachineNodes(env, instanceId, userId, pinned).catch(() => [])) {
		if (await relayConnected(env, instanceId, alias).catch(() => false)) return alias;
	}
	return null;
}

/**
 * Which machine holds a live socket for this instance, IGNORING the pin — for DESCRIPTION ONLY.
 *
 * Never for routing: taking this answer as a destination is exactly the fallback
 * `getBoundRunnerConn` forbids. `/runtime/status` needs it to say the true sentence "you are
 * pinned to X, which is dead; Y is up" instead of reporting Y's liveness as though it were the
 * agent's (#380). Still live-checked — the DB `status` column is never cleared on disconnect.
 */
export async function liveNodeIgnoringPin(env: Env, instanceId: string, userId: string): Promise<string | null> {
	const conn = await getLiveRunnerConn(env, instanceId, userId).catch(() => null);
	return conn?.runnerNode || null;
}

/**
 * Resolve a runner connection to a machine whose relay socket is CONNECTED right now. Prefers
 * the legacy default runtime (the common single-machine + old-client case), else scans the
 * user's registered nodes for a live one. Returns null if nothing is actually connected. This
 * is the antidote to the stale-`status` column: routing follows the socket, not the DB row.
 */
async function getLiveRunnerConn(env: Env, instanceId: string, userId: string): Promise<RunnerConn | null> {
	// `getRunnerConn` IS the default row plus that probe since #532 — the check that used to be
	// written out on this line is now inside it, so a non-null answer here is already live-checked.
	const def = await getRunnerConn(env, instanceId, userId);
	if (def) return def;
	// Default is stale/offline — scan the per-machine node registrations for a live socket.
	const { results } = await env.DB.prepare(
		"SELECT DISTINCT runner_node FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node IS NOT NULL AND runner_node != '' ORDER BY updated_at DESC",
	).bind(instanceId, userId).all<{ runner_node: string }>().catch(() => ({ results: [] as { runner_node: string }[] }));
	for (const r of results ?? []) {
		const node = normalizeRunnerNode(r.runner_node);
		if (!node) continue;
		if (await relayConnected(env, instanceId, node).catch(() => false)) {
			return getRunnerConnIgnoringLiveness(env, instanceId, userId, node);
		}
	}
	return null;
}

export async function relayConnected(env: Env, instanceId: string, runnerNode?: string | null): Promise<boolean> {
	try {
		if (!env.RELAY) return false;
		const stub = env.RELAY.get(env.RELAY.idFromName(relayNameForInstance(instanceId, runnerNode)));
		const res = await stub.fetch(new Request("https://relay/status"));
		if (!res.ok) return false;
		const data = (await res.json()) as { connected?: boolean };
		return data.connected === true;
	} catch {
		return false;
	}
}

/**
 * Live check: is a runner WebSocket actually connected for this instance right now?
 * Queries the RelayDO (authoritative — it holds the socket), NOT the DB `status`
 * column, which can read "active"/"online" after an unclean disconnect. Cheap: the DO
 * is hibernated when idle. Returns false on any error (treat unknown as offline).
 */
export async function isRunnerOnline(env: Env, instanceId: string, runnerNode?: string | null): Promise<boolean> {
	return relayConnected(env, instanceId, runnerNode);
}

/** Short timeout for READ-type runner commands (terminal capture, snapshots, status). A
 *  connected-but-hung runner (process wedged without closing the WS) would otherwise hold the
 *  request for the full DEFAULT_TIMEOUT_MS (120s) — a ~1.5-3s capture poll must fail fast and
 *  free the socket instead of stacking 2-minute waits in the RelayDO. Mutating commands
 *  (act/clone/start) keep the long default. */
export const READ_TIMEOUT_MS = 10_000;

/** Send a command to the runner via the WebSocket relay DO. `opts.timeoutMs` caps how long
 *  the relay waits for the runner's reply (defaults to the DO's 120s); pass READ_TIMEOUT_MS
 *  for reads so a hung runner can't wedge the UI. */
export async function callRunner<T = unknown>(conn: RunnerConn, path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
	if (!conn.env.RELAY) throw new Error("RELAY binding not configured");
	const stub = conn.env.RELAY.get(conn.env.RELAY.idFromName(conn.relayName || conn.instanceId));
	const res = await stub.fetch(new Request("https://relay/command", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ method: "POST", path, body, timeoutMs: opts?.timeoutMs }),
	}));
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		// A DISCONNECT KNOWS IT IS ONE (#341, following #339). The RelayDO reports two distinct
		// facts — 503, no socket at dispatch; 504 "Runner disconnected", the socket went away with
		// a command in flight — and both mean "gone for now", which a caller can wait out. Raising
		// a typed error stops every catch site inferring that from the wording, and stops this line
		// prescribing `pags up` to someone already running it: the remedy depends on WHY it is not
		// attached (`diagnoseAttachment`, #237), which this function cannot see and must not guess.
		if (relayFailureIsDisconnect(res.status, detail)) {
			throw new RunnerUnreachableError(`No runner connected — ${NO_SOCKET_MARKER} for this agent.`);
		}
		throw new Error(`Runner ${path} → ${res.status}: ${detail.slice(0, 200)}`);
	}
	return (await res.json()) as T;
}
