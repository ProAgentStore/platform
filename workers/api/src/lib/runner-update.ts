/**
 * `runner_update` — update a machine's `pags` CLI and restart it, entirely over MCP (#859).
 *
 * The machine does the work (`packages/cli/src/commands/runner/self-update.ts`): it refuses when
 * nothing would restart it, WAITS while any engine is mid-turn, then installs the latest release and
 * exits for its `pags up` to respawn it from the new files. This half makes the promise checkable:
 *
 *   1. it records which agents hold a live socket on that machine BEFORE the restart;
 *   2. it asks, over the first of this owner's sockets there that answers;
 *   3. after a restart it waits for every one of those agents to come back, and re-attaches any that
 *      did not through #856's attach path (`attachAgentOnNode`), clearing a stale socket if one holds
 *      the slot — then reports who came back, who was re-attached, and anyone still missing.
 *
 * A coding run on that machine is not lost across the gap: the workflow's runner guard parks it while
 * the runner is away and resumes it — engine conversation included (`--resume`) — once it is back.
 */
import { aliasNodesFor } from "./machine-identity.js";
import { advanceUpdateOp, claimUpdateOp, type RunnerUpdateOp, UPDATE_STATE_FOR_ACTION } from "./runner-update-ops.js";
import { callRunner, relayConnected } from "./runner-client.js";
import { attachAgentOnNode, liveCarriers, nodeRegistrations, type RepinDeps } from "./runner-repin.js";
import { RunnerUnreachableError } from "./runner-unreachable.js";
import { normalizeRunnerNode } from "./runtime-nodes.js";
import type { Env } from "../types.js";

/** The CLI answers this path itself (`self-update.ts`'s RUNNER_UPDATE_PATH); change both. */
export const RUNNER_UPDATE_PATH = "/pags/runner/update";
/** npm install inside the relay's two-minute command ceiling. */
const UPDATE_TIMEOUT_MS = 115_000;
/** How long the restarted runner gets to re-attach every agent on its own before we step in. */
const REATTACH_WAIT_MS = 90_000;

/** What the machine answered — `self-update.ts`'s plan, or `restarting`. */
interface MachineReply {
	action?: "up-to-date" | "refused" | "wait" | "restarting";
	current?: string;
	latest?: string;
	reason?: string;
	waitingFor?: string[];
	detail?: string;
	dryRun?: boolean;
	/** What starts it again (#860) — `self-update.ts`'s `Restarter`. Absent from a CLI older than #860. */
	restartedBy?: string;
	/** What the update did not reach, when something (#860). */
	supervisor?: string;
}

/**
 * Said when the `pags up` supervising the runner stays on its old code (#860). A CLI older than #860
 * does not say how it restarts, and its `pags up` is necessarily one that respawns only the runner.
 */
const LEGACY_SUPERVISOR_NOTE =
	"The `pags up` on this machine predates supervisor restarts (#860): the runner comes back on the new release, but the `pags up` window keeps running its own older code until it is restarted there once.";

export interface RunnerUpdateResult {
	node: string;
	action: "up-to-date" | "refused" | "scheduled" | "restarted" | "would-update" | "unsupported" | "unreachable" | "failed";
	current?: string;
	latest?: string;
	/** The version the machine registers after the restart, as the platform now records it. */
	version?: string | null;
	/** Agents holding a live socket on the machine when the update was asked for. */
	held: string[];
	/** Of those, the ones #856's attach path had to bring back after the restart. */
	reattached?: string[];
	/** Of those, the ones still without a socket — with each one's reason. */
	missing?: Array<{ instanceId: string; detail: string }>;
	waitingFor?: string[];
	/** How the machine brought itself back (#860): `pags-up`, `pags-up-child-only`, `service` or `command`. */
	restartedBy?: string;
	/** Set when the machine's `pags up` supervisor did NOT move onto the new release (#860). */
	supervisor?: string;
	detail?: string;
}

export async function updateRunnerNode(env: Env, userId: string, rawNode: string, opts: RepinDeps & { dryRun?: boolean } = {}): Promise<RunnerUpdateResult> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = opts.now ?? Date.now;
	const node = normalizeRunnerNode(rawNode);
	const rows = await nodeRegistrations(env, userId);
	const names = new Set([node, ...aliasNodesFor(node, rows)]);
	const socketOn = async (instanceId: string) => {
		for (const n of names) if (await relayConnected(env, instanceId, n)) return true;
		return false;
	};

	// 1. Who is attached there now — the set the restart must give back.
	const held: string[] = [];
	for (const id of new Set(rows.filter((r) => r.instanceId && names.has(normalizeRunnerNode(r.node))).map((r) => r.instanceId as string))) {
		if (await socketOn(id)) held.push(id);
	}

	// 2. Ask the machine, over a socket that answers.
	const carriers = await liveCarriers(env, userId, rows, names);
	if (carriers.length === 0) {
		return { node, action: "unreachable", held, detail: `No \`pags up\` is connected on ${node}, so nothing there can be asked to update. It has to be started at the machine.` };
	}
	let reply: MachineReply | null = null;
	for (const carrier of carriers) {
		try {
			reply = (await callRunner<MachineReply>(carrier, RUNNER_UPDATE_PATH, { dryRun: opts.dryRun === true }, { timeoutMs: UPDATE_TIMEOUT_MS })) ?? {};
			break;
		} catch (e) {
			if (e instanceof RunnerUnreachableError) continue;
			const message = e instanceof Error ? e.message : String(e);
			if (/→ 404/.test(message)) {
				return {
					node,
					action: "unsupported",
					held,
					detail: `The \`pags\` CLI on ${node} predates runner_update, so it cannot update itself. Update it once at the machine — \`npm i -g @proagentstore/cli\` — and restart \`pags up\` there; that installs the self-updating stub (#862), so it is the last update anyone does by hand: every \`pags up\` then moves onto the latest release by itself, and runner_update does it remotely.`,
				};
			}
			if (/→ 504:.*Relay command timed out/.test(message)) {
				return { node, action: "failed", held, detail: `${node}'s relay is connected but the update command timed out. The update may still be in flight; poll list_runner_nodes before retrying. If coding_diagnostics still reports an unresponsive runner, try force_runner_attach for an affected instance on this node to recover a stale agent socket, then check coding_diagnostics again. If remote recovery fails, restart \`pags up\` at the machine.` };
			}
			return { node, action: "failed", held, detail: `${node} could not update: ${message.replace(/^Runner \/pags\/runner\/update → \d+: /, "").slice(0, 400)}` };
		}
	}
	if (!reply) {
		return { node, action: "unreachable", held, detail: `Every relay socket on ${node} is connected but not answering, so the update could not be confirmed. A stale agent socket may be recoverable: try force_runner_attach for an affected instance on this node, then check coding_diagnostics and list_runner_nodes before deciding whether to retry the update. If remote attachment cannot recover it, restart \`pags up\` at the machine.` };
	}

	const base = { node, held, current: reply.current, latest: reply.latest };
	if (reply.action === "up-to-date") return { ...base, action: "up-to-date", detail: `${node} already runs ${reply.current}, the latest release.` };
	if (reply.action === "refused") return { ...base, action: "refused", detail: reply.reason };
	if (reply.action === "wait") {
		return opts.dryRun
			? { ...base, action: "would-update", waitingFor: reply.waitingFor, detail: `Would update ${reply.current} → ${reply.latest} once ${reply.waitingFor?.length ?? 0} engine(s) finish their turns.` }
			: {
					...base,
					action: "scheduled",
					waitingFor: reply.waitingFor,
					detail: `${node} will update ${reply.current} → ${reply.latest} and restart as soon as these engines finish their turns — no run is cut off. Call runner_update again afterwards to confirm every agent re-attached.`,
				};
	}
	if (reply.action !== "restarting") {
		return { ...base, action: "would-update", detail: `Would update ${reply.current} → ${reply.latest}, restart, and re-attach ${held.length} agent(s).` };
	}

	// 3. The machine is restarting on the new version. Wait for every held agent to come back.
	const until = now() + REATTACH_WAIT_MS;
	let away = held;
	while (away.length > 0 && now() < until) {
		await sleep(2_000);
		const still: string[] = [];
		for (const id of away) if (!(await socketOn(id))) still.push(id);
		away = still;
	}
	// …and bring back any that did not, through #856's attach path.
	const reattached: string[] = [];
	const missing: Array<{ instanceId: string; detail: string }> = [];
	for (const id of away) {
		const attempt = await attachAgentOnNode(env, id, userId, node, { force: false, rows, sleep, now });
		if (attempt.attached) reattached.push(id);
		else missing.push({ instanceId: id, detail: attempt.detail ?? "not attached" });
	}
	const version = await env.DB.prepare(
		`SELECT runner_version FROM instance_runtime_nodes WHERE user_id = ?1 AND runner_node IN (${[...names].map((_, i) => `?${i + 2}`).join(",")}) ORDER BY updated_at DESC LIMIT 1`,
	)
		.bind(userId, ...names)
		.first<{ runner_version: string | null }>()
		.then((r) => r?.runner_version ?? null)
		.catch(() => null);
	const supervisor = reply.restartedBy ? reply.supervisor : LEGACY_SUPERVISOR_NOTE;
	const outcome =
		missing.length === 0
			? `${node} updated ${reply.current} → ${reply.latest} and restarted; all ${held.length} agent(s) it held are attached again.`
			: `${node} updated ${reply.current} → ${reply.latest} and restarted, but ${missing.length} of ${held.length} agent(s) did not re-attach — see missing; force_runner_attach takes a slot over.`;
	return {
		...base,
		action: "restarted",
		version,
		reattached,
		missing,
		...(reply.restartedBy ? { restartedBy: reply.restartedBy } : {}),
		...(supervisor ? { supervisor } : {}),
		detail: supervisor ? `${outcome} ${supervisor}` : outcome,
	};
}

/**
 * The same update, as a DURABLE operation (#990).
 *
 * ── What was wrong with calling {@link updateRunnerNode} from the route
 *
 * It can block for ~205s (a 115s relay command, then a 90s re-attach wait) and the MCP seam's
 * confirmation deadline is 20s. On expiry that seam ABORTS the request, which cancels the Worker —
 * so the work stopped somewhere in the middle having written nothing at all, and the live attempts
 * on `Macmini.modem` left a node that was idle, connected, on 0.4.84, with no outcome and no error
 * to read. A timed-out reply made the operation unknowable, and the tool's own `poll` hint had
 * nothing to resolve against.
 *
 * ── The shape now
 *
 * 1. CLAIM the operation in D1 (single-flight per machine) and hand the caller its id immediately,
 *    well inside any client deadline;
 * 2. run the work in the background through `waitUntil`, so the client going away cannot kill it;
 * 3. write the terminal outcome to the row whatever happens — including a thrown error, which
 *    previously vanished with the request.
 *
 * The caller therefore always leaves with something to poll, and every attempt ends in a state
 * somebody can read. `startRunnerUpdate` returns the claimed operation; the result of the work
 * itself is read back through `latestUpdateOp` (the route's GET, `list_runner_nodes`, the Console).
 */
export interface StartRunnerUpdate {
	op: RunnerUpdateOp;
	/** False when an update was already in flight on this machine — this call joined it. */
	started: boolean;
}

export async function startRunnerUpdate(
	env: Env,
	userId: string,
	rawNode: string,
	opts: RepinDeps & { dryRun?: boolean; background?: (p: Promise<unknown>) => void; machineId?: string | null } = {},
): Promise<StartRunnerUpdate> {
	const node = normalizeRunnerNode(rawNode);
	const { op, claimed } = await claimUpdateOp(env, userId, node, { dryRun: opts.dryRun === true, now: opts.now?.(), machineId: opts.machineId });
	// Already in flight, or the claim could not be recorded: either way nothing new is started, and
	// the operation the caller gets back is the one that actually exists.
	if (!claimed) return { op, started: false };

	const run = (async () => {
		try {
			const result = await updateRunnerNode(env, userId, node, opts);
			await advanceUpdateOp(env, userId, op.id, {
				state: UPDATE_STATE_FOR_ACTION[result.action] ?? "failed",
				currentVersion: result.current ?? null,
				latestVersion: result.latest ?? null,
				finalVersion: result.version ?? null,
				detail: result.detail ?? null,
				reason: result.action,
				held: result.held,
				reattached: result.reattached ?? [],
				missing: result.missing ?? [],
				waitingFor: result.waitingFor ?? [],
				restartedBy: result.restartedBy ?? null,
				supervisor: result.supervisor ?? null,
			}, opts.now?.());
			return result;
		} catch (e) {
			// The one path that used to lose everything: a throw inside a request nobody is waiting
			// for. It is now the operation's recorded outcome, with the reason on it.
			await advanceUpdateOp(env, userId, op.id, {
				state: "failed",
				reason: "error",
				detail: `The update on ${node} failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 400)}`,
			}, opts.now?.());
			return null;
		}
	})();
	if (opts.background) opts.background(run);
	else await run;
	return { op, started: true };
}
