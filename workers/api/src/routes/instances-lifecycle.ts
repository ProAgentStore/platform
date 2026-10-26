// Pause and resume one instance (#825) — the reversible lifecycle beside `POST /:id/cancel`.
//
// A helper module for the reason `instances-guide.ts` and `loop-continue-routes.ts` are: the
// composing file is pinned by the #302 ratchet, so what lands there is the two lines that register
// this. Why pause exists at all, what it stops, and what it deliberately leaves running is
// `lib/instance-pause.ts`.
//
// ── Both routes are POSTs that may write nothing
//
// Pausing an already-paused instance answers 200 with `changed: false`. The alternative — 409 on a
// no-op — punishes the one caller most likely to make it: a model retrying after a dropped
// response, or an owner clicking twice. The state it asked for is the state that holds, so it
// succeeded.
//
// ── The subscription is not touched, and that is the whole feature
//
// `cancel` writes two rows: the instance status AND the shared `subscriptions` row when it takes
// the last live instance of that agent (`lib/subscription-standing.ts`). Pause writes ONE. The
// subscription, the config, the repos, the documents, the timeline and the run history all stay
// exactly as they are, which is what makes this reversible and cancel not.

import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { listActiveRuns, requestCancel } from "../lib/agent-loop-store.js";
import { drainPendingQueues } from "../lib/objective-queue-start.js";
import { PAUSED_INSTANCE_STATUS, pauseVerdict, resumeVerdict, type LifecycleVerdict } from "../lib/instance-pause.js";
import { ACTIVE_INSTANCE_STATUS } from "../lib/trigger-eligibility.js";
import type { Env } from "../types.js";

interface StatusRow {
	id: string;
	status: string | null;
}

/**
 * Load the row this transition is about, scoped to the caller.
 *
 * Its own read rather than `requireOwnedInstance`'s: that helper selects a wider row for callers
 * that need the config, and these two routes need the id and the status. Same ownership predicate,
 * same 404 for an instance that is not yours — which is the half that must not drift.
 */
async function ownedStatusRow(env: Env, instanceId: string, userId: string): Promise<StatusRow> {
	const row = await env.DB.prepare("SELECT id, status FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<StatusRow>();
	if (!row) throw new HttpError(404, "Instance not found");
	return row;
}

function refuse(verdict: LifecycleVerdict): asserts verdict is { ok: true; changed: boolean; status: string } {
	if (!verdict.ok) throw new HttpError(verdict.httpStatus, verdict.error);
}

/**
 * The two writes, with the status as a LITERAL in each statement rather than one helper taking it
 * as a bind.
 *
 * A bound `SET status = ?2` is invisible to `status-domain-guard.ts`, which scans for literals to
 * prove a declared value really has a writer — it would have forced `paused` to be marked `app?`,
 * the provenance whose own docstring warns it "could otherwise be used to wave the guard through".
 * Two statements cost one extra line and make the writer greppable, which is the property that
 * whole table exists to defend. It is also how `cancel` writes its own literal.
 */
async function writePaused(env: Env, instanceId: string): Promise<void> {
	await env.DB.prepare("UPDATE agent_instances SET status = 'paused', updated_at = datetime('now') WHERE id = ?1")
		.bind(instanceId)
		.run();
}

/**
 * An instance that is active carries no disabled record (#1383): enabling — and a plain resume — clear all three columns in the same
 * statement that flips the status, so the two can never disagree. Nothing else on the row is touched, which is what makes a disable→enable
 * round trip restore the pins, repos, queue and schedules exactly (they live in `config` and other tables, none of which is written here).
 */
async function writeActive(env: Env, instanceId: string): Promise<void> {
	await env.DB.prepare("UPDATE agent_instances SET status = 'active', disabled_at = NULL, disabled_by = NULL, disabled_reason = NULL, updated_at = datetime('now') WHERE id = ?1")
		.bind(instanceId)
		.run();
}

/**
 * Disable = pause + the record of the decision (#1383). The status is the same literal `'paused'` the pause writer uses, so every gate that
 * refuses work for a paused instance refuses it for a disabled one. Repeating it keeps the ORIGINAL time and actor (COALESCE) and only
 * replaces the reason when a new one is given, so a retry after a dropped response cannot rewrite who disabled it, or when.
 */
async function writeDisabled(env: Env, instanceId: string, by: string, reason: string | null): Promise<void> {
	await env.DB.prepare(
		`UPDATE agent_instances SET status = 'paused', disabled_at = COALESCE(disabled_at, datetime('now')), disabled_by = COALESCE(disabled_by, ?2),
		        disabled_reason = COALESCE(?3, disabled_reason), updated_at = datetime('now') WHERE id = ?1`,
	)
		.bind(instanceId, by, reason)
		.run();
}

const REASON_MAX = 500;

/** The optional `reason` of a disable: absent or blank is none; a non-string, or one past the bound, is a 400 rather than a quiet clip. */
async function reasonOf(c: { req: { json(): Promise<unknown> } }): Promise<string | null> {
	const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
	const raw = body?.reason;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "string") throw new HttpError(400, "reason must be a string");
	const reason = raw.trim();
	if (reason.length > REASON_MAX) throw new HttpError(400, `reason must be at most ${REASON_MAX} characters`);
	return reason || null;
}

interface DisabledRow {
	id: string;
	status: string | null;
	disabled_at: string | null;
	disabled_reason: string | null;
}

async function ownedDisabledRow(env: Env, instanceId: string, userId: string): Promise<DisabledRow> {
	const row = await env.DB.prepare("SELECT id, status, disabled_at, disabled_reason FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<DisabledRow>();
	if (!row) throw new HttpError(404, "Instance not found");
	return row;
}

/**
 * Cooperative, and reported as such. `requestCancel` only matches a row still `running`, so this is naturally idempotent and a second call asks
 * nothing of a run that already stopped. It does not reset the clock on a run that is ignoring an earlier request either — `cancel_requested_at`
 * is COALESCEd at the store. Shared by pause and disable: the same stop, with or without the record.
 */
async function askRunsToStop(env: Env, userId: string, instanceId: string): Promise<number> {
	const running = await listActiveRuns(env, userId, instanceId).catch(() => []);
	let asked = 0;
	for (const run of running) {
		if (await requestCancel(env, userId, run.runId).catch(() => false)) asked++;
	}
	return asked;
}

export function registerInstanceLifecycleRoutes(router: Hono<{ Bindings: Env }>): void {
	/**
	 * Stop this instance for now: block new runs, and ask the ones in flight to stop.
	 *
	 * The status is written BEFORE the runs are asked to stop, and the order is load-bearing. A run
	 * that finishes its current iteration between the two writes must find the instance already
	 * paused, so whatever it tries to start next is refused by the admission gate. Asking first and
	 * writing second leaves exactly that window open, and it is the window a busy agent lives in.
	 */
	router.post("/:instanceId/pause", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const row = await ownedStatusRow(c.env, instanceId, session.uid);

		const verdict = pauseVerdict(row.status);
		refuse(verdict);
		if (verdict.changed) await writePaused(c.env, instanceId);

		const asked = await askRunsToStop(c.env, session.uid, instanceId);

		return c.json({
			success: true,
			status: PAUSED_INSTANCE_STATUS,
			changed: verdict.changed,
			/**
			 * How many in-flight runs were ASKED to stop — not how many have stopped. There is no
			 * way to kill a Workflow mid-step; each stops at the top of its next iteration and the
			 * sweeper enforces the ones that do not. `coding_loop_status` is where that is watched.
			 */
			runsAskedToStop: asked,
		});
	});

	/**
	 * Put it back to work. Does NOT restart anything pause stopped.
	 *
	 * A run that was asked to stop has a terminal row and an ending; resurrecting it would mean
	 * re-running an objective whose partial work is already on the record, which is the mistake
	 * #806's resume note exists to prevent from the other direction. `continue_instance_run` is the
	 * deliberate, per-run way to carry one forward, and the response points at it.
	 */
	const resumeHandler = async (c: Context<{ Bindings: Env }>) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId") as string;
		const row = await ownedStatusRow(c.env, instanceId, session.uid);

		const verdict = resumeVerdict(row.status);
		refuse(verdict);
		// Always written, even when the status already reads active: an instance that is active must carry no disabled record, and the
		// clear is a no-op on a row that never had one. `changed` still reports only whether the STATUS moved.
		await writeActive(c.env, instanceId);
		// Queued objectives the pause held back start now (#1015): nothing else would drain them.
		const drained = verdict.changed ? await drainPendingQueues(c.env, instanceId, session.uid) : [];

		return c.json({
			queueStarted: drained.filter((d) => d.drained && d.started).length,
			success: true,
			status: ACTIVE_INSTANCE_STATUS,
			changed: verdict.changed,
			disabled: null,
			note: "Runs stopped by the pause are not restarted — continue one with POST /v1/instances/:id/loop/:runId/continue, or start fresh work as usual.",
		});
	};
	router.post("/:instanceId/resume", resumeHandler);
	/** `enable` is `resume` under the name the Disabled list and the console use (#1383): the same handler, so they cannot drift apart. */
	router.post("/:instanceId/enable", resumeHandler);

	/**
	 * Disable one instance (#1383): pause it, and record when, by whom and why. Idempotent — disabling a disabled instance succeeds and
	 * keeps the original time and actor. Never deletes anything; `enable` reverses it exactly. Only the OWNER's own session can do it
	 * (`disabled_by` is the verified session uid, never anything in the request body).
	 */
	router.post("/:instanceId/disable", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const reason = await reasonOf(c);
		const row = await ownedDisabledRow(c.env, instanceId, session.uid);

		const verdict = pauseVerdict(row.status);
		refuse(verdict);
		const recordChanged = !row.disabled_at || (reason !== null && reason !== row.disabled_reason);
		// Status BEFORE asking runs to stop — the order is load-bearing, exactly as for pause.
		if (verdict.changed || recordChanged) await writeDisabled(c.env, instanceId, session.uid, reason);
		const asked = await askRunsToStop(c.env, session.uid, instanceId);
		const after = await c.env.DB.prepare("SELECT disabled_at, disabled_by, disabled_reason FROM agent_instances WHERE id = ?1 AND user_id = ?2")
			.bind(instanceId, session.uid)
			.first<{ disabled_at: string | null; disabled_by: string | null; disabled_reason: string | null }>();

		return c.json({
			success: true,
			status: PAUSED_INSTANCE_STATUS,
			changed: verdict.changed || recordChanged,
			disabled: { at: after?.disabled_at ?? null, by: after?.disabled_by ?? null, reason: after?.disabled_reason ?? null },
			runsAskedToStop: asked,
		});
	});
}
