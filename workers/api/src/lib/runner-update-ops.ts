/**
 * The durable record of a runner update (#990) — what made the operation knowable.
 *
 * ── The live failure
 *
 * `runner_update` on an idle `Macmini.modem` answered `outcome: "unknown"`,
 * `confirmation.reason: "deadline-exceeded"` on two consecutive attempts, and the node stayed
 * connected, idle and on `0.4.84`. There was no outcome to read and no error to read: the only
 * statement the platform ever made about the operation was the HTTP response that never arrived.
 *
 * The cause is structural, not a flake. {@link updateRunnerNode} can block for ~205s — a 115s relay
 * command, then a 90s wait for every agent to re-attach — while the MCP seam's confirmation deadline
 * is 20s, and on expiry it aborts the request. Aborting the client request cancels the Worker, so
 * the work died somewhere in the middle, having written nothing. The `poll: list_runner_nodes` hint
 * the tool offers could not help either: there was no operation state anywhere to poll.
 *
 * ── What this module is
 *
 * One row per attempt, written BEFORE the machine is contacted and advanced at every phase, so a
 * terminal outcome is always recorded even when nobody is listening for the reply. A lost reply is
 * then an inconvenience rather than an unknown.
 *
 * `running` is the only non-terminal state and it is also the SINGLE-FLIGHT CLAIM: the partial
 * unique index makes at most one live operation per (owner, machine), so a retried call after a
 * timeout joins the operation already in flight instead of starting a second npm install on
 * somebody's laptop.
 */
import { normalizeRunnerNode } from "./runtime-nodes.js";
import { clipMarked } from "./clip-marked.js";
import { cliAtLeast } from "./runner-upgrade.js";
import type { Env } from "../types.js";

/** `running` is in flight; everything else is terminal. */
export const RUNNER_UPDATE_STATES = ["running", "scheduled", "expired", "restarting", "restarted", "up_to_date", "would_update", "refused", "unsupported", "unreachable", "failed"] as const;
export type RunnerUpdateState = (typeof RUNNER_UPDATE_STATES)[number];

/** The last durable control-plane checkpoint; it never pretends to observe an unreported machine step. */
export const RUNNER_UPDATE_PHASES = ["claimed", "queued", "dispatching", "installing", "deferred", "restarting", "reattaching"] as const;
export type RunnerUpdatePhase = (typeof RUNNER_UPDATE_PHASES)[number];

export const isTerminalUpdateState = (state: string): boolean => state !== "running";

/**
 * The bounded busy-deferral lease (#860): must expire before the stale-operation sweep, so a
 * terminal `scheduled` row cannot hide a local retry. Owned here (not `runner-update.ts`, which
 * imports it) because {@link expireScheduledUpdateOps} needs it too, for a legacy row written
 * before `deferred_until` existed (#1456).
 */
export const DEFERRED_UPDATE_LEASE_MS = 5 * 60_000;

/** `update` installs the latest release and restarts; `restart` restarts on the CLI it has (#1032). */
export type RunnerOpKind = "update" | "restart";

/** The `action` vocabulary {@link RunnerUpdateResult} speaks, mapped onto the stored state. */
export const UPDATE_STATE_FOR_ACTION: Readonly<Record<string, RunnerUpdateState>> = {
	"up-to-date": "up_to_date",
	"would-update": "would_update",
	scheduled: "scheduled",
	restarting: "restarting",
	restarted: "restarted",
	refused: "refused",
	unsupported: "unsupported",
	unreachable: "unreachable",
	failed: "failed",
};

export interface RunnerUpdateOp {
	id: string;
	/** What was asked of the machine (#1032). */
	kind: RunnerOpKind;
	node: string;
	/** Stable physical identity when the caller had one; null for pre-identity runners. */
	machineId: string | null;
	state: RunnerUpdateState;
	phase: RunnerUpdatePhase;
	currentVersion: string | null;
	latestVersion: string | null;
	/** The version the platform recorded for the machine after it came back. */
	finalVersion: string | null;
	detail: string | null;
	reason: string | null;
	held: string[];
	reattached: string[];
	missing: Array<{ instanceId: string; detail: string }>;
	waitingFor: string[];
	restartedBy: string | null;
	supervisor: string | null;
	reconciliation: string | null;
	reconciledAt: string | null;
	/** The durable executor responsible for this operation, never the request lifetime. */
	executionOwner: string | null;
	workflowId: string | null;
	workflowQueuedAt: string | null;
	/** Bounded machine-side deferral deadline, if the runner was busy. */
	deferredUntil: string | null;
	dryRun: boolean;
	createdAt: string;
	updatedAt: string;
	endedAt: string | null;
}

interface Row {
	id: string;
	kind: string | null;
	node: string;
	machine_id: string | null;
	state: string;
	phase: string;
	current_version: string | null;
	latest_version: string | null;
	final_version: string | null;
	detail: string | null;
	reason: string | null;
	held: string;
	reattached: string;
	missing: string;
	waiting_for: string;
	restarted_by: string | null;
	supervisor: string | null;
	reconciliation: string | null;
	reconciled_at: number | null;
	execution_owner: string | null;
	workflow_id: string | null;
	workflow_queued_at: number | null;
	deferred_until: number | null;
	dry_run: number;
	created_at: number;
	updated_at: number;
	ended_at: number | null;
}

const iso = (ms: number | null): string | null => (ms ? new Date(ms).toISOString() : null);
const list = (raw: string | null): string[] => {
	try {
		const v = JSON.parse(raw ?? "[]");
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
};
const missingList = (raw: string | null): Array<{ instanceId: string; detail: string }> => {
	try {
		const v = JSON.parse(raw ?? "[]");
		return Array.isArray(v) ? v.filter((x): x is { instanceId: string; detail: string } => !!x && typeof x === "object" && typeof (x as { instanceId?: unknown }).instanceId === "string") : [];
	} catch {
		return [];
	}
};

const present = (r: Row): RunnerUpdateOp => ({
	id: r.id,
	kind: r.kind === "restart" ? "restart" : "update",
	node: r.node,
	state: (RUNNER_UPDATE_STATES as readonly string[]).includes(r.state) ? (r.state as RunnerUpdateState) : "failed",
	phase: (RUNNER_UPDATE_PHASES as readonly string[]).includes(r.phase) ? (r.phase as RunnerUpdatePhase) : "claimed",
	machineId: r.machine_id,
	currentVersion: r.current_version,
	latestVersion: r.latest_version,
	finalVersion: r.final_version,
	detail: r.detail,
	reason: r.reason,
	held: list(r.held),
	reattached: list(r.reattached),
	missing: missingList(r.missing),
	waitingFor: list(r.waiting_for),
	restartedBy: r.restarted_by,
	supervisor: r.supervisor,
	reconciliation: r.reconciliation,
	reconciledAt: iso(r.reconciled_at),
	executionOwner: r.execution_owner,
	workflowId: r.workflow_id,
	workflowQueuedAt: iso(r.workflow_queued_at),
	deferredUntil: iso(r.deferred_until),
	dryRun: r.dry_run === 1,
	createdAt: iso(r.created_at) ?? "",
	updatedAt: iso(r.updated_at) ?? "",
	endedAt: iso(r.ended_at),
});

const SELECT = `SELECT id, kind, node, machine_id, state, phase, current_version, latest_version, final_version, detail, reason,
 held, reattached, missing, waiting_for, restarted_by, supervisor, reconciliation, reconciled_at, execution_owner, workflow_id, workflow_queued_at, deferred_until, dry_run, created_at, updated_at, ended_at
 FROM runner_update_ops`;

/** The live operation on this machine, when one is in flight. */
export async function liveUpdateOp(env: Pick<Env, "DB">, userId: string, node: string, machineId?: string | null): Promise<RunnerUpdateOp | null> {
	const byMachine = !!machineId;
	const row = await env.DB.prepare(`${SELECT} WHERE user_id = ?1 AND ${byMachine ? "machine_id" : "node"} = ?2 AND state = 'running'`)
		.bind(userId, byMachine ? machineId : normalizeRunnerNode(node))
		.first<Row>()
		.catch(() => null);
	return row ? present(row) : null;
}

/** The most recent operation on this machine, live or finished — what a poll reads. */
export async function latestUpdateOp(env: Pick<Env, "DB">, userId: string, node: string, machineId?: string | null): Promise<RunnerUpdateOp | null> {
	const byMachine = !!machineId;
	const row = await env.DB.prepare(`${SELECT} WHERE user_id = ?1 AND ${byMachine ? "machine_id" : "node"} = ?2 ORDER BY created_at DESC LIMIT 1`)
		.bind(userId, byMachine ? machineId : normalizeRunnerNode(node))
		.first<Row>()
		.catch(() => null);
	return row ? present(row) : null;
}

/** The latest operation per machine, for every machine named — the Console's and the node list's read. */
export async function latestUpdateOps(env: Pick<Env, "DB">, userId: string, nodes: readonly string[]): Promise<Map<string, RunnerUpdateOp>> {
	const out = new Map<string, RunnerUpdateOp>();
	const names = [...new Set(nodes.map((n) => normalizeRunnerNode(n)).filter(Boolean))].slice(0, 100);
	if (!names.length) return out;
	const placeholders = names.map((_, i) => `?${i + 2}`).join(",");
	const { results } = await env.DB.prepare(`${SELECT} WHERE user_id = ?1 AND node IN (${placeholders}) ORDER BY created_at DESC`)
		.bind(userId, ...names)
		.all<Row>()
		.catch(() => ({ results: [] as Row[] }));
	// Ordered newest first, so the first row seen for a node IS its latest.
	for (const r of results ?? []) if (!out.has(r.node)) out.set(r.node, present(r));
	return out;
}

/**
 * Claim the operation, or report the one already in flight.
 *
 * The claim is the INSERT: the partial unique index on `state = 'running'` means a second attempt
 * while one is live fails the insert rather than racing it, and the caller gets the live operation
 * back. That is what stops a retry after a 20s timeout from starting a second install.
 */
export async function claimUpdateOp(
	env: Pick<Env, "DB">,
	userId: string,
	node: string,
	opts: { dryRun?: boolean; requestedBy?: string; now?: number; id?: string; machineId?: string | null; kind?: RunnerOpKind } = {},
): Promise<{ op: RunnerUpdateOp; claimed: boolean }> {
	const name = normalizeRunnerNode(node);
	const now = opts.now ?? Date.now();
	const id = opts.id ?? crypto.randomUUID();
	const inserted = await env.DB.prepare(
		`INSERT INTO runner_update_ops (id, user_id, node, machine_id, state, phase, execution_owner, dry_run, requested_by, detail, created_at, updated_at, kind)
		 VALUES (?1, ?2, ?3, ?4, 'running', 'claimed', 'workflow', ?5, ?6, ?7, ?8, ?8, ?9)
		 ON CONFLICT DO NOTHING`,
	)
		.bind(
			id,
			userId,
			name,
			opts.machineId ?? null,
			opts.dryRun ? 1 : 0,
			opts.requestedBy ?? "owner",
			opts.kind === "restart" ? `Asking ${name} to restart its \`pags\` runner.` : `Asking ${name} to update its \`pags\` CLI and restart.`,
			now,
			opts.kind ?? "update",
		)
		.run()
		.then((r) => (r.meta?.changes ?? 0) > 0)
		.catch(() => false);
	if (inserted) {
		const op = await latestUpdateOp(env, userId, name, opts.machineId);
		if (op) return { op, claimed: true };
	}
	const live = await liveUpdateOp(env, userId, name, opts.machineId);
	if (live) return { op: live, claimed: false };
	// Neither inserted nor live: the insert failed for a reason that is not the claim (a lost D1
	// write). Reported as a failed operation rather than silently doing the work unrecorded — an
	// unrecorded update is the whole defect this module exists to end.
	return {
		op: {
			id,
			kind: opts.kind ?? "update",
			node: name,
			machineId: opts.machineId ?? null,
			state: "failed",
			phase: "claimed",
			currentVersion: null,
			latestVersion: null,
			finalVersion: null,
			detail: `The update could not be recorded, so it was not started. Nothing was installed on ${name}; retry.`,
			reason: "not_recorded",
			held: [],
			reattached: [],
			missing: [],
			waitingFor: [],
			restartedBy: null,
			supervisor: null,
			reconciliation: null,
			reconciledAt: null,
			executionOwner: "workflow",
			workflowId: null,
			workflowQueuedAt: null,
			deferredUntil: null,
			dryRun: opts.dryRun === true,
			createdAt: new Date(now).toISOString(),
			updatedAt: new Date(now).toISOString(),
			endedAt: new Date(now).toISOString(),
		},
		claimed: false,
	};
}

/** Mark a claimed row for durable Workflow execution before the Workflow is created. */
export async function queueUpdateWorkflow(env: Pick<Env, "DB">, userId: string, id: string, workflowId: string, now = Date.now()): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE runner_update_ops
		    SET phase = 'queued', execution_owner = 'workflow', workflow_id = ?1, workflow_queued_at = ?2,
		        detail = 'Queued for durable runner-update workflow execution.', updated_at = ?2
		  WHERE id = ?3 AND user_id = ?4 AND state = 'running' AND phase = 'claimed'`,
	)
		.bind(workflowId, now, id, userId)
		.run()
		.catch(() => null);
	return (res?.meta?.changes ?? 0) > 0;
}

/**
 * The one-way dispatch claim. Once this succeeds a machine command may be attempted. A resumed
 * workflow must never take this claim again: the machine may have seen the first command.
 */
export async function claimWorkflowDispatch(env: Pick<Env, "DB">, userId: string, id: string, now = Date.now()): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE runner_update_ops
		    SET phase = 'dispatching', detail = 'Dispatching the update request to the runner; no machine result has been observed yet.', updated_at = ?1
		  WHERE id = ?2 AND user_id = ?3 AND state = 'running' AND execution_owner = 'workflow' AND phase IN ('claimed', 'queued')`,
	)
		.bind(now, id, userId)
		.run()
		.catch(() => null);
	return (res?.meta?.changes ?? 0) > 0;
}

export interface QueuedUpdateWorkflow {
	id: string;
	kind: RunnerOpKind;
	userId: string;
	node: string;
	machineId: string | null;
	workflowId: string | null;
}

/** Rows which were claimed but whose Workflow create may have been interrupted with the request. */
export async function queuedUpdateWorkflows(env: Pick<Env, "DB">, limit = 20): Promise<QueuedUpdateWorkflow[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, CASE WHEN kind = 'restart' THEN 'restart' ELSE 'update' END AS kind, user_id AS userId, node, machine_id AS machineId, workflow_id AS workflowId FROM runner_update_ops
		  WHERE state = 'running' AND execution_owner = 'workflow' AND phase IN ('claimed', 'queued')
		  ORDER BY created_at ASC LIMIT ?1`,
	)
		.bind(limit)
		.all<QueuedUpdateWorkflow>()
		.catch(() => ({ results: [] as QueuedUpdateWorkflow[] }));
	return results ?? [];
}

export interface UpdateOpPatch {
	state: RunnerUpdateState;
	phase?: RunnerUpdatePhase;
	currentVersion?: string | null;
	latestVersion?: string | null;
	finalVersion?: string | null;
	detail?: string | null;
	reason?: string | null;
	held?: readonly string[];
	reattached?: readonly string[];
	missing?: ReadonlyArray<{ instanceId: string; detail: string }>;
	waitingFor?: readonly string[];
	restartedBy?: string | null;
	supervisor?: string | null;
	deferredUntil?: string | null;
}

/**
 * Advance one operation. Terminal states stamp `ended_at`, so "is it still going" is a fact.
 *
 * Guarded on `state = 'running'`: a terminal outcome is written once and cannot be overwritten by a
 * late phase of the same attempt, which is the same rule `closeWorkCards`'s `openOnly` applies for
 * the same reason — whoever recorded the verdict first had the authority to.
 */
export async function advanceUpdateOp(env: Pick<Env, "DB">, userId: string, id: string, patch: UpdateOpPatch, now = Date.now()): Promise<boolean> {
	const terminal = isTerminalUpdateState(patch.state);
	return env.DB.prepare(
		`UPDATE runner_update_ops
		    SET state = ?1,
		        phase = COALESCE(?2, phase),
		        current_version = COALESCE(?3, current_version),
		        latest_version = COALESCE(?4, latest_version),
		        final_version = COALESCE(?5, final_version),
		        detail = COALESCE(?6, detail),
		        reason = COALESCE(?7, reason),
		        held = COALESCE(?8, held),
		        reattached = COALESCE(?9, reattached),
		        missing = COALESCE(?10, missing),
		        waiting_for = COALESCE(?11, waiting_for),
		        restarted_by = COALESCE(?12, restarted_by),
		        supervisor = COALESCE(?13, supervisor),
			        deferred_until = COALESCE(?14, deferred_until),
			        updated_at = ?15,
			        ended_at = CASE WHEN ?16 = 1 THEN ?15 ELSE ended_at END
		  WHERE id = ?17 AND user_id = ?18 AND state = 'running'`,
	)
		.bind(
			patch.state,
			patch.phase ?? null,
			patch.currentVersion ?? null,
			patch.latestVersion ?? null,
			patch.finalVersion ?? null,
			patch.detail ?? null,
			patch.reason ?? null,
			patch.held ? JSON.stringify([...patch.held]) : null,
			patch.reattached ? JSON.stringify([...patch.reattached]) : null,
			patch.missing ? JSON.stringify([...patch.missing]) : null,
			patch.waitingFor ? JSON.stringify([...patch.waitingFor]) : null,
			patch.restartedBy ?? null,
			patch.supervisor ?? null,
			patch.deferredUntil ? Date.parse(patch.deferredUntil) : null,
			now,
			terminal ? 1 : 0,
			id,
			userId,
		)
		.run()
		.then((r) => (r.meta?.changes ?? 0) > 0)
		.catch(() => false);
}

/**
 * The machine can finish after its control-plane owner was interrupted and the stale sweep closed
 * the attempt. Preserve that late observation without reopening the operation or allowing a second
 * install to overwrite its original terminal verdict.
 */
export async function reconcileLateUpdateOp(env: Pick<Env, "DB">, userId: string, id: string, reconciliation: string, now = Date.now()): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE runner_update_ops
		    SET reconciliation = ?1, reconciled_at = ?2, updated_at = ?2
		  WHERE id = ?3 AND user_id = ?4 AND state != 'running'`,
	)
		.bind(clipMarked(reconciliation, 800, { within: true, what: "diagnostic characters" }), now, id, userId)
		.run()
		.catch(() => null);
	return (res?.meta?.changes ?? 0) > 0;
}

/**
 * An `unreachable` row is an acknowledgement GAP, not a confirmed failure (#1432): the install or
 * restart command may have landed on the machine with its reply lost, and the machine re-registers
 * on its own moments later. How long after the row went terminal a later registration may still
 * retroactively verify it — generous next to the ~70s a real restart took in #1432's own evidence,
 * but well inside {@link UPDATE_OP_STALE_MS} so it can never race the stale-operation sweep.
 */
export const RUNNER_UPDATE_RECONCILE_GRACE_MS = 10 * 60_000;

/**
 * A machine that re-registers with a newer CLI version shortly after its update operation ended
 * `unreachable` gets that success reconciled passively (#1432) — no new install/restart command is
 * sent, and the busy-run single-flight claim is untouched because this only ever writes a row that
 * is already TERMINAL (`state = 'unreachable'`), never the live `running` row.
 *
 * Reconciliation requires the op's own pre-attempt version (`current_version`, recorded even when
 * the machine was never reached) to show the observed version as genuine forward progress — a bare
 * "some registration arrived" is not enough, and a `restart` (which keeps its version) will never
 * satisfy `cliAtLeast` in both directions at once, so it is excluded without a separate check. When
 * the pre-attempt version was never captured, or the newer version never arrives in time, the row
 * is left exactly as `unreachable` — clearly unverified, never guessed into success or failure.
 */
export async function reconcileUnreachableUpdateOp(
	env: Pick<Env, "DB">,
	userId: string,
	node: string,
	machineId: string | null | undefined,
	observedVersion: string,
	now = Date.now(),
): Promise<boolean> {
	if (!observedVersion) return false;
	const op = await latestUpdateOp(env, userId, node, machineId);
	if (op?.state !== "unreachable" || !op.currentVersion) return false;
	if (!cliAtLeast(observedVersion, op.currentVersion) || cliAtLeast(op.currentVersion, observedVersion)) return false;
	const endedAtMs = op.endedAt ? Date.parse(op.endedAt) : NaN;
	if (!Number.isFinite(endedAtMs) || now - endedAtMs > RUNNER_UPDATE_RECONCILE_GRACE_MS) return false;
	const res = await env.DB.prepare(
		`UPDATE runner_update_ops
		    SET state = 'restarted', final_version = ?1,
		        detail = ?2, reconciliation = ?2, reconciled_at = ?3, updated_at = ?3
		  WHERE id = ?4 AND user_id = ?5 AND state = 'unreachable'`,
	)
		.bind(
			observedVersion,
			clipMarked(
				`${node} re-registered on ${observedVersion} (was ${op.currentVersion}) within the restart grace window after the update could not be confirmed live; passively reconciled as a successful restart. Re-attachment of any held agent was not re-checked by this reconciliation.`,
				800,
				{ within: true, what: "diagnostic characters" },
			),
			now,
			op.id,
			userId,
		)
		.run()
		.catch(() => null);
	return (res?.meta?.changes ?? 0) > 0;
}

/**
 * An operation whose Worker died before it recorded anything (#990) — the shape the live failure
 * had. Swept by the per-minute cron so a `running` row cannot outlive a failed executor:
 * without this, the one state that is not terminal would be the new way to be unknowable.
 */
export const UPDATE_OP_STALE_MS = 6 * 60_000;

export async function failStaleUpdateOps(env: Pick<Env, "DB">, now = Date.now()): Promise<number> {
	const cutoff = now - UPDATE_OP_STALE_MS;
	const res = await env.DB.prepare(
		`UPDATE runner_update_ops
		    SET state = 'failed',
		        reason = 'abandoned_' || phase,
		        detail = 'The update stopped reporting during phase ' || phase || ', so its outcome was never recorded. The machine may or may not have installed it — check its version before retrying.',
		        updated_at = ?1, ended_at = ?1
		  WHERE state = 'running' AND phase NOT IN ('claimed', 'queued') AND updated_at < ?2`,
	)
		.bind(now, cutoff)
		.run()
		.catch(() => null);
	return res?.meta?.changes ?? 0;
}

/** Is there a LATER operation recorded for this op's machine? If so, IT is the honest explanation
 *  for any version change since — never this op, whose own lease has already elapsed (#1456). */
async function hasLaterUpdateOp(env: Pick<Env, "DB">, userId: string, op: Pick<RunnerUpdateOp, "node" | "machineId" | "createdAt">): Promise<boolean> {
	const byMachine = !!op.machineId;
	const row = await env.DB.prepare(
		`SELECT 1 FROM runner_update_ops WHERE user_id = ?1 AND ${byMachine ? "machine_id" : "node"} = ?2 AND created_at > ?3 LIMIT 1`,
	)
		.bind(userId, byMachine ? op.machineId : op.node, Date.parse(op.createdAt))
		.first()
		.catch(() => null);
	return !!row;
}

/**
 * How long past a `scheduled` op's own lease (`deferred_until`) a registration may still
 * retroactively confirm it restarted (#1456) — the same idea as
 * {@link RUNNER_UPDATE_RECONCILE_GRACE_MS} gives an `unreachable` op, but anchored to the LEASE
 * rather than when the row went terminal: a `scheduled` row is already terminal at the moment it is
 * written (when the deferral is granted), long before the machine has actually acted on it.
 */
export const SCHEDULED_UPDATE_RECONCILE_GRACE_MS = RUNNER_UPDATE_RECONCILE_GRACE_MS;

/**
 * A machine that registers a newer version while its `scheduled` deferred update's lease is still
 * open, or shortly after (#1456), gets that success reconciled passively — the same passive
 * mechanism {@link reconcileUnreachableUpdateOp} gives an `unreachable` op. Only ever writes a row
 * already terminal (`state = 'scheduled'`), never the live `running` row, so the busy-run
 * single-flight claim is untouched.
 *
 * Reads through {@link latestUpdateOp} — the single newest row for the machine — so a LATER
 * operation (superseding this one) is never at risk of having its version bump misattributed here:
 * it is, by construction, what `latestUpdateOp` would return instead, and this refuses unless THAT
 * row is itself still `scheduled`. "Never infer agent reattachment or restart causality from version
 * alone" holds because there is never more than one candidate row in play.
 */
export async function reconcileScheduledUpdateOp(
	env: Pick<Env, "DB">,
	userId: string,
	node: string,
	machineId: string | null | undefined,
	observedVersion: string,
	now = Date.now(),
): Promise<boolean> {
	if (!observedVersion) return false;
	const op = await latestUpdateOp(env, userId, node, machineId);
	if (op?.state !== "scheduled" || !op.currentVersion || !op.deferredUntil) return false;
	if (!cliAtLeast(observedVersion, op.currentVersion) || cliAtLeast(op.currentVersion, observedVersion)) return false;
	const deferredUntilMs = Date.parse(op.deferredUntil);
	if (!Number.isFinite(deferredUntilMs) || now > deferredUntilMs + SCHEDULED_UPDATE_RECONCILE_GRACE_MS) return false;
	const res = await env.DB.prepare(
		`UPDATE runner_update_ops
		    SET state = 'restarted', final_version = ?1,
		        detail = ?2, reconciliation = ?2, reconciled_at = ?3, updated_at = ?3
		  WHERE id = ?4 AND user_id = ?5 AND state = 'scheduled'`,
	)
		.bind(
			observedVersion,
			clipMarked(
				`${node} re-registered on ${observedVersion} (was ${op.currentVersion}) within the deferred update's lease window; passively reconciled as a successful restart. Re-attachment of any held agent was not re-checked by this reconciliation.`,
				800,
				{ within: true, what: "diagnostic characters" },
			),
			now,
			op.id,
			userId,
		)
		.run()
		.catch(() => null);
	return (res?.meta?.changes ?? 0) > 0;
}

/**
 * `scheduled` rows whose lease has elapsed with no later confirmation (#1456) — the blind spot
 * {@link failStaleUpdateOps} (`running` only) and {@link reconcileUnreachableUpdateOp}
 * (`unreachable` only) both leave. A `scheduled` row is already terminal the moment it is written,
 * so neither sweep ever revisits it, and without this it reports "scheduled" forever even though the
 * runner's own contract (`runner-update.ts`) is that it will never restart once its lease is gone.
 *
 * Pure bookkeeping: it never contacts the machine, and the resulting `expired` state must never be
 * read as authorization to force a restart — exactly the live repro this closes (a stale receipt
 * next to another active coding turn is not permission to interrupt it).
 *
 * Swept by the same per-minute cron as {@link failStaleUpdateOps}. A row already reconciled by
 * {@link reconcileScheduledUpdateOp} is skipped (`reconciliation IS NULL`). A legacy row written
 * before `deferred_until` existed falls back to {@link DEFERRED_UPDATE_LEASE_MS} past `updated_at` —
 * the lease it would have been given under today's contract — so it is not stuck unexpired forever
 * either. Capped per tick so a backlog cannot make one cron invocation unbounded; the next tick picks
 * up whatever is left.
 */
export async function expireScheduledUpdateOps(env: Pick<Env, "DB">, now = Date.now(), limit = 100): Promise<number> {
	const { results } = await env.DB.prepare(
		`SELECT id, user_id AS userId, node, machine_id AS machineId, current_version AS currentVersion, created_at AS createdAtMs
		   FROM runner_update_ops
		  WHERE state = 'scheduled' AND reconciliation IS NULL
		    AND COALESCE(deferred_until, updated_at + ?1) < ?2
		  ORDER BY created_at ASC LIMIT ?3`,
	)
		.bind(DEFERRED_UPDATE_LEASE_MS, now, limit)
		.all<{ id: string; userId: string; node: string; machineId: string | null; currentVersion: string | null; createdAtMs: number }>()
		.catch(() => ({ results: [] }));
	let expired = 0;
	for (const r of results ?? []) {
		const superseded = await hasLaterUpdateOp(env, r.userId, { node: r.node, machineId: r.machineId, createdAt: new Date(r.createdAtMs).toISOString() });
		const detail = superseded
			? `The deferred update's lease expired with no confirmed restart, and a later operation was requested for ${r.node} since — that later operation is the current record, not this one. This is a stale receipt, not authorization to retry or force a restart.`
			: `The deferred update's lease expired with no confirmed restart. The runner's own contract is to never restart after its lease — this is a stale receipt, not authorization to retry or force a restart.`;
		const res = await env.DB.prepare(
			`UPDATE runner_update_ops SET state = 'expired', reason = 'lease_expired', detail = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'scheduled'`,
		)
			.bind(detail, now, r.id)
			.run()
			.catch(() => null);
		if ((res?.meta?.changes ?? 0) > 0) expired++;
	}
	return expired;
}
