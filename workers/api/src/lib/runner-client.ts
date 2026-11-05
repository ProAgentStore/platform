import { BROWSER_EVIDENCE_TIMEOUT_MS, refreshBrowserEvidence } from "./browser-evidence.js";
import { type BrowserScreenshotsSetting, withBrowserCaptureSettings } from "./browser-screenshots.js";
import { browserSettingsForDispatch } from "./browser-settings-dispatch.js";
import { decryptKey } from "./crypto.js";
import { logError } from "./error-log.js";
import { latestResourceSample, resourceHistory, resourcesView } from "./runner-resources.js";
import { aliasNodesFor, machineNamesFor, type NodeRegistration } from "./machine-identity.js";
import { routeFor, TIMED_OUT_READ_PATHS } from "./runner-routes.js";
import { READ_TIMEOUT_MS, RELAY_DEFAULT_TIMEOUT_MS } from "./runner-timeouts.js";
import { DRAINING_MARKER, NO_SOCKET_MARKER, relayFailureIsDisconnect, relayWireCode, runnerErrorCode, RunnerError, runnerErrorTag, RunnerUnreachableError, UNRESPONSIVE_MARKER } from "./runner-unreachable.js";
import { normalizeRunnerNode, readInstanceRunnerNode, relayNameForInstance } from "./runtime-nodes.js";
import type { Env } from "../types.js";
import type { StaleSocketVerdict } from "./relay-liveness.js";

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
	// Availability status is a historical diagnostic, never registration revocation (#1551).
	// A failed health read can mark the row offline while a relay later reconnects; filtering on
	// that snapshot rejects a presently responsive socket. The live resolver checks the relay,
	// while this loader only enforces registration and owner identity. Explicit unregistration
	// removes the row; paused/canceled instance authorisation stays at the operation boundary.
	const row = await env.DB.prepare(
		node
			? "SELECT endpoint_url, token_plaintext, token_ciphertext, token_dek_wrapped, token_iv, runner_node FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3"
			: "SELECT endpoint_url, token_plaintext, token_ciphertext, token_dek_wrapped, token_iv, runner_node FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2",
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
	// By machine id, not a capped scan (#1174): a "newest 200 rows" read let rows under an abandoned spelling — which heartbeats
	// no longer refresh, so they sort last — fall off the end, and a pin on "Macmini" became unreachable on a live Mac mini. The
	// pinned name's own rows say which machine(s) it is; only those machines' rows are read, however many other rows exist.
	const ids = await env.DB.prepare(
		"SELECT DISTINCT machine_id AS id FROM instance_runtime_nodes WHERE user_id = ?1 AND runner_node = ?2 AND machine_id IS NOT NULL AND machine_id != ''",
	)
		.bind(userId, pinned)
		.all<{ id: string }>()
		.then((r) => (r.results ?? []).map((x) => x.id))
		.catch(() => [] as string[]);
	if (!ids.length) return [];
	const marks = ids.map((_, i) => `?${i + 2}`).join(",");
	const { results } = await env.DB.prepare(
		`SELECT runner_node AS node, machine_id AS machineId, instance_id AS instanceId, last_seen_at AS lastSeenAt
		 FROM instance_runtime_nodes
		 WHERE user_id = ?1 AND machine_id IN (${marks}) AND runner_node IS NOT NULL AND runner_node != ''
		 ORDER BY updated_at DESC`,
	)
		.bind(userId, ...ids)
		.all<NodeRegistration>()
		.catch(() => ({ results: [] as NodeRegistration[] }));
	// The id-less rows under those names too (#1181): each name's rows are the evidence for which id it carries, and an id-less row under an
	// unambiguous name is that machine — the answer the machines list gives, so the router and the list cannot disagree.
	const names = [...new Set((results ?? []).map((r) => r.node).filter(Boolean))];
	let rows: NodeRegistration[] = results ?? [];
	if (names.length) {
		const nm = names.map((_, i) => `?${i + 2}`).join(",");
		const { results: sameNames } = await env.DB.prepare(
			`SELECT runner_node AS node, machine_id AS machineId, instance_id AS instanceId, last_seen_at AS lastSeenAt
			 FROM instance_runtime_nodes WHERE user_id = ?1 AND runner_node IN (${nm}) ORDER BY updated_at DESC`,
		)
			.bind(userId, ...names)
			.all<NodeRegistration>()
			.catch(() => ({ results: [] as NodeRegistration[] }));
		const seen = new Set(rows.map((r) => `${r.instanceId}\0${r.node}`));
		rows = [...rows, ...(sameNames ?? []).filter((r) => !seen.has(`${r.instanceId}\0${r.node}`))];
	}
	return aliasNodesFor(pinned, rows, instanceId);
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
 * Every node name this owner's machines have ever registered, unreduced (#1541) — the one read
 * both {@link getRunnerConnForStampedNode} and {@link sameMachine} resolve identity against, so a
 * name's ambiguity is judged the same way, against the same evidence, on both the SEND and the
 * RELEASE side of one call. Owner-wide and NOT pre-filtered by any one name's `machine_id`:
 * filtering first (as `sameMachineNodes` below does, for the different, fallback-tolerant question
 * a live PIN asks) can miss a row that would reveal `answeredBy` ALSO carries a second, unrelated
 * id elsewhere in the fleet — exactly the case a caller must see in order to refuse it.
 *
 * Deliberately does NOT catch a failed read into an empty result. An empty array here reads as "no
 * registration under this name" — `machineNamesFor`'s `unknown` case — which both callers trust as
 * the legacy, nothing-contradicts-the-string case. Swallowing a DB error into that same shape would
 * turn "identity evidence unavailable" into "no contradiction found", which can dispatch a stop or
 * release a lock on a read that never actually happened. Let it throw; `endCodingSession` has
 * nothing that treats a thrown identity check as a confirmed stop either way.
 */
async function ownerNodeRegistrations(env: Env, userId: string): Promise<NodeRegistration[]> {
	const { results } = await env.DB.prepare(
		"SELECT runner_node AS node, machine_id AS machineId, instance_id AS instanceId, last_seen_at AS lastSeenAt FROM instance_runtime_nodes WHERE user_id = ?1",
	)
		.bind(userId)
		.all<NodeRegistration>();
	return results ?? [];
}

/**
 * Resolve a connection for the node a PAST RECORD is stamped to, falling back to a proven alias of
 * the same physical machine when the stamped node itself answers nothing live (#1541).
 *
 * The same spirit as the authoritative-pin alias walk {@link getBoundRunnerConn} already does for a
 * live PIN (#379) — a renamed machine (DHCP, VPN, the `.local` mDNS form) can answer under a name
 * no record mentions, and a stamp is exactly as vulnerable to that as a pin is — but stricter, and
 * checked BEFORE any connection attempt, not after: identity is resolved first, and a stamped name
 * the fleet's own history shows is AMBIGUOUS (two different machine ids recorded under it — two
 * real machines have answered to this exact name) is refused outright, never even trying the exact
 * name directly. String equality is not proof once a recorded contradiction exists; it is still
 * trusted, as every stamp-routed call elsewhere in this file always has, only when nothing
 * contradicts it (no id recorded at all — a legacy row, or an old CLI). Sending a command that
 * names an exact past session (`/coding/end`, `/message`, `/restart`) to a plausible-but-unproven
 * guess is the mistake this function exists to never make. The stamp stays authoritative — never a
 * fallback to a genuinely different machine.
 */
export async function getRunnerConnForStampedNode(env: Env, instanceId: string, userId: string, stampedNode: string | null | undefined): Promise<RunnerConn | null> {
	const node = normalizeRunnerNode(stampedNode);
	if (!node) return getRunnerConn(env, instanceId, userId, stampedNode);
	const resolved = machineNamesFor(node, await ownerNodeRegistrations(env, userId));
	if (!resolved.ok && resolved.reason === "ambiguous") return null;
	const direct = await getRunnerConn(env, instanceId, userId, node);
	if (direct) return direct;
	const aliases = resolved.ok ? resolved.names.filter((n) => n !== node) : [];
	for (const alias of aliases) {
		const conn = await getRunnerConn(env, instanceId, userId, alias);
		if (conn) return conn;
	}
	return null;
}

/**
 * Does `answeredBy` prove to be the SAME physical machine as `stamped` (#1541)?
 *
 * Exact string equality is trusted ONLY when nothing recorded contradicts it: `stamped` has no
 * machine id at all (a legacy row or an old CLI), so there is nothing to disprove the string's own
 * claim. A `stamped` name the fleet's history shows is AMBIGUOUS — two different machine ids
 * recorded under it — is refused even when `answeredBy` is the identical string: two real machines
 * have answered to that name, so which one is live right now proves nothing about which one this
 * record meant. Anything else is proof only through the SAME owner-wide, fail-closed resolution
 * {@link getRunnerConnForStampedNode} used to pick who to ask in the first place, asked again here
 * independently before a lock is released on the answer — a caller that found a connection some
 * other way is not trusted on its say alone.
 */
export async function sameMachine(env: Env, userId: string, stamped: string | null | undefined, answeredBy: string | null | undefined): Promise<boolean> {
	const s = normalizeRunnerNode(stamped);
	const a = normalizeRunnerNode(answeredBy);
	if (!s || !a) return false;
	const resolved = machineNamesFor(s, await ownerNodeRegistrations(env, userId));
	if (resolved.ok) return resolved.names.includes(a);
	return resolved.reason === "unknown" && s === a;
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
 * A VERIFIED online check (#1401): waits for an actual pong, unlike {@link relayConnected}'s
 * fire-a-ping-and-judge-on-the-last-one. `nodeOnline` could read `true` off a round trip from
 * before the runner froze, with nothing short of a second poll — which may never come, if nobody is
 * driving that instance — to notice. Pink-laptop's "Pink Laptop Terminal" showed `nodeOnline: true`
 * while its terminal tool calls timed out; this is the bounded wait that makes a status READ say so.
 *
 * For a status/dashboard read ONLY — `relayConnected` stays the one the hot per-tool-call loop and
 * chat context builder use, for the latency reason its own docstring states.
 */
export async function verifyRunnerResponsive(env: Env, instanceId: string, runnerNode?: string | null): Promise<boolean> {
	try {
		if (!env.RELAY) return false;
		const stub = env.RELAY.get(env.RELAY.idFromName(relayNameForInstance(instanceId, runnerNode)));
		const res = await stub.fetch(new Request("https://relay/status?verify=1"));
		if (!res.ok) return false;
		const data = (await res.json()) as { connected?: boolean };
		return data.connected === true;
	} catch {
		return false;
	}
}

/**
 * Free one agent's relay slot on one machine of a socket nobody answers behind (#856).
 *
 * The relay's own ping probe decides, so a live socket is never touched — `alive: true` means the
 * agent IS attached there. `evicted` sockets were stale: a frozen or duplicate runner's, holding the
 * slot so the machine's own `pags up` was refused with 4409. Never throws; no relay reads as empty.
 */
export async function evictStaleRunnerSocket(env: Env, instanceId: string, runnerNode: string): Promise<StaleSocketVerdict> {
	const none: StaleSocketVerdict = { sockets: 0, alive: false, evicted: 0 };
	try {
		if (!env.RELAY) return none;
		const stub = env.RELAY.get(env.RELAY.idFromName(relayNameForInstance(instanceId, runnerNode)));
		const res = await stub.fetch(new Request("https://relay/evict-stale", { method: "POST" }));
		if (!res.ok) return none;
		// Read field by field: a relay that answers another shape must not turn a count into NaN.
		const v = (await res.json().catch(() => ({}))) as Partial<StaleSocketVerdict>;
		return { sockets: Number(v.sockets) || 0, alive: v.alive === true, evicted: Number(v.evicted) || 0 };
	} catch {
		return none;
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
export { READ_TIMEOUT_MS };

/**
 * The timeout to send for a route the caller named none for (#1358): the route's own when it is SHORTER than the relay's default
 * (a quick read fails fast), else none — the relay applies its default, which keeps the wire as it was for every other command.
 */
function routeTimeoutMs(path: string): number | undefined {
	const t = routeFor(path).timeoutMs;
	return t < RELAY_DEFAULT_TIMEOUT_MS ? t : undefined;
}

/** Send a command to the runner via the WebSocket relay DO. `opts.timeoutMs` caps how long
 *  the relay waits for the runner's reply (defaults to the DO's 120s); pass READ_TIMEOUT_MS
 *  for reads so a hung runner can't wedge the UI. */
/** Preserve workflow evidence without allowing a failed diagnostic pull to replay an action. */
export async function callRunner<T = unknown>(conn: RunnerConn, path: string, body?: unknown, opts?: { timeoutMs?: number; frozenScreenshotPolicy?: BrowserScreenshotsSetting }): Promise<T> {
 try { return await callRunnerUnrecorded<T>(conn, path, body, opts); }
 finally {
  const taskId = body && typeof body === "object" && "taskId" in body && typeof body.taskId === "string" ? body.taskId : null;
  if (taskId && ["/browser/act", "/browser/snapshot", "/browser/complete"].includes(path)) {
   await refreshBrowserEvidence(conn.env, { userId: conn.userId, instanceId: conn.instanceId, subjectKind: "runtime_task", subjectId: taskId }, async (diagnosticPath, diagnosticBody) => {
    const stub = conn.env.RELAY.get(conn.env.RELAY.idFromName(conn.relayName || conn.instanceId));
    return stub.fetch(new Request("https://relay/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "POST", path: diagnosticPath, body: diagnosticBody, timeoutMs: BROWSER_EVIDENCE_TIMEOUT_MS }) }));
   }).catch(() => undefined);
  }
 }
}

async function callRunnerUnrecorded<T = unknown>(conn: RunnerConn, path: string, body?: unknown, opts?: { timeoutMs?: number; frozenScreenshotPolicy?: BrowserScreenshotsSetting }): Promise<T> {
	if (!conn.env.RELAY) throw new Error("RELAY binding not configured");
	body = opts?.frozenScreenshotPolicy
		? { ...(body as Record<string, unknown>), screenshot: opts.frozenScreenshotPolicy.enabled, blurFormFields: opts.frozenScreenshotPolicy.blurFormFields }
		: await withBrowserCaptureSettings(conn.env, conn.instanceId, conn.userId, path, body);
	const browserSettings = await browserSettingsForDispatch(conn.env, conn.instanceId, conn.userId, path, conn.runnerNode, undefined, body);
	const stub = conn.env.RELAY.get(conn.env.RELAY.idFromName(conn.relayName || conn.instanceId));
	const res = await stub.fetch(new Request("https://relay/command", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ method: "POST", path, body, ...browserSettings, timeoutMs: opts?.timeoutMs ?? routeTimeoutMs(path) }),
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
			// A socket can still exist in the DO while the runner event loop is frozen. RelayDO
			// verifies that with a bounded ping before accepting a command (#846); retain that
			// distinction here so a coding-start failure says what actually needs attention.
			const code = relayWireCode(detail) ?? (res.status === 503 ? "NO_SOCKET" : "DROPPED");
			const unresponsive = code === "UNRESPONSIVE";
			if (unresponsive) await recordUnresponsive(conn, path);
			throw new RunnerUnreachableError(
				(unresponsive
					? `Runner relay is ${UNRESPONSIVE_MARKER} — its socket is up, but the runner did not answer the relay's ping in time. A busy or reconnecting machine usually recovers on its own.`
					: `No runner connected — ${NO_SOCKET_MARKER} for this agent.`) + runnerErrorTag(code, true, path),
				{ code, dispatched: res.status !== 503, path },
			);
		}
		// The runner draining for an update refused the command BEFORE it ran (#1344): retryable, and nothing was sent to the
		// runtime — but it is a connected runner, so it says so instead of "no live socket".
		if (res.status === 503 && detail.includes(DRAINING_MARKER)) {
			throw new RunnerUnreachableError(`Runner ${path} → 503: the runner is draining for an automatic update and is ${UNRESPONSIVE_MARKER} to new work until it restarts.${runnerErrorTag("DRAINING", true, path)}`, { code: "DRAINING", dispatched: false, path });
		}
		// A QUICK READ that timed out at the relay (a capture, `/health`, `/capabilities`: `TIMED_OUT_READ_PATHS`) is a runner connected but
		// not answering (#1341) — the same state as the 503 above, met one step later. Typed the same way so the runner guard waits for it
		// instead of ending a long run as `unknown`. Re-sending it cannot duplicate an act. Nor does it lose records any more (#1358): a
		// capture that names a cursor reads the runner's usage/act records without deleting them, so a timed-out one that DID run only
		// causes a re-send (an older runner still drains, and loses that one batch as it always did). Every other path keeps the plain
		// error: a mutating command that timed out may have run (#1015).
		// A relay that predates its codes (a deploy rolling) is read by its words — only on its own 504, never a runner's body.
		const code = relayWireCode(detail) ?? (res.status === 504 ? runnerErrorCode(detail) : null) ?? "RUNNER_HTTP";
		if (res.status === 504 && code === "RELAY_TIMEOUT" && TIMED_OUT_READ_PATHS.has(path.split("?")[0] ?? path)) {
			await recordUnresponsive(conn, path);
			throw new RunnerUnreachableError(`Runner ${path} → 504: Relay command timed out — the runner is ${UNRESPONSIVE_MARKER}.${runnerErrorTag(code, true, path)}`, { code, dispatched: true, path });
		}
		throw new RunnerError(`Runner ${path} → ${res.status}: ${detail.slice(0, 200)}${runnerErrorTag(code, false, path)}`, code, { path });
	}
	return (await res.json()) as T;
}

/**
 * Stamp a "connected but not responding" dispatch with what the machine was doing (#924).
 *
 * The failure ends Pilot runs (#913) and its cause is usually the machine, not the network — a
 * runner too loaded to answer its relay ping in time. Recording the machine's latest heartbeat
 * sample beside the failure makes that checkable in a postmortem (MCP `list_errors`) instead of
 * inferred. Only on this failure path, and never throws: it must not change what the caller sees.
 */
async function recordUnresponsive(conn: RunnerConn, path: string): Promise<void> {
	try {
		const node = conn.runnerNode ?? "";
		const sample = node ? await latestResourceSample(conn.env, conn.userId, [node]) : null;
		const view = resourcesView(sample, null);
		// The ten minutes before the failure, from the dense history (#924): one sample says what the
		// machine looked like 0–30s before; the series says whether it had been climbing.
		const now = Date.now();
		const recent = node ? await resourceHistory(conn.env, conn.userId, [node], "dense", now - 10 * 60 * 1000, now).catch(() => []) : [];
		await logError(conn.env, {
			source: "runner",
			level: "warn",
			userId: conn.userId,
			message: `Runner relay connected but not responding on ${node || "the default machine"} (${path}).${view ? ` Machine at last heartbeat: load ${view.load1} on ${view.cpus} cores, ${view.memUsedPct}% memory in use.` : " The machine reports no resource sample (CLI before 0.4.71)."}`,
			context: { instanceId: conn.instanceId, runnerNode: node || null, path, resources: view, recent: recent.map(({ at, load1, loadPerCpu, memUsedPct, diskUsedPct, relayRttMs }) => ({ at, load1, loadPerCpu, memUsedPct, diskUsedPct, relayRttMs })) },
		});
	} catch {
		/* best-effort */
	}
}
