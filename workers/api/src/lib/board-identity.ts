/**
 * Card identity for the per-instance board and the All Agents view (#1698, first slice): ONE function that says which card a
 * record of actual execution is, so no reader has to derive it from a job URL, a GitHub issue or an applicant again.
 *
 * WHY. `buildInstanceBoard` groups mirrored tasks by `jobKeyForTask` (a normalized job URL), so two attempts at the same job
 * collapse into one card and a retry looks like the same execution. Identity belongs to the EXECUTION:
 *
 *   coding-session       `csess-<sessionId>`       one card per resumable session; parking and resuming keep it (`codingCardId`).
 *   scan                 `scan-<runId>`            one card per scan run (`scanCardId`).
 *   application-attempt  `app-attempt-<kind>-<id>` one card per EXECUTION of an application: a Runner fill run
 *                        (`local_apply_runs.id`) or a Tailor run (`local_artifact_runs.id`), the `runId` that
 *                        `applicationRunsForCards` already returns. The application itself stays data; `applicationId` is
 *                        metadata on the card and is NOT part of its identity, so a second attempt at the same application,
 *                        job or issue is a second card. `kind` is in the id so the two tables can never collide.
 *   queued-objective     `objective:<entryId>`     an accepted objective with no session yet (`objectiveJobKey`), pending and
 *                        distinct from any session card. It carries `linkedSessionCardId` once its session is known.
 *
 * A GitHub issue, a job URL or an applicant is never an input to a card id. That is the whole point.
 *
 * SCOPING. Every call takes the owner and the instance (`scope`), both non-empty, and refuses a record that carries a different
 * instance or owner. The function is pure and reads nothing, so isolation here means: it will not name a card for a record that does
 * not belong to the scope it was asked in. The database reads that produce the records stay owner-scoped where they are today.
 *
 * ── The queue-to-session link (found in the schema, and its gap)
 * `instance_objective_queue.run_id` is "the run this entry became" and is written when the entry `started`
 * (migration 0149); `agent_loop_runs.queue_entry_id` is the reverse link (0212); a coding run's `agent_loop_runs.session_id`
 * (0116) names its session, and is NULL for a non-coding run. So an entry reaches its session card by TWO hops, entry -> run ->
 * session, which this pure module cannot make: the caller resolves the session id and passes it as `sessionId`. Gaps, stated:
 *   - no session id is passed -> `linkedSessionCardId` is undefined (the entry may not have started, or its run is not a coding run);
 *   - between the drain claiming an entry (`running`) and its session card existing, `listQueue` returns only `pending` entries, so
 *     the objective card is not listed in that window. That is a property of the current queue read, not of this module, and it is
 *     the "disappearing card" the cutover must close (see below).
 *
 * ── CALLERS TO WIRE IN LATER (none is changed by this slice)
 *   workers/api/src/lib/board.ts            `buildInstanceBoard` (grouping by `jobKeyForTask`, `byKey`, `objectiveCards`) and `jobKeyForTask`
 *   workers/api/src/lib/board-order.ts      `objectiveCards`, `sortBoardItems`, `markRunQueue`
 *   workers/api/src/lib/board-reorder.ts    `buildInstanceBoard` x2 (place a card by its job key)
 *   workers/api/src/lib/ticket-queue.ts     `buildInstanceBoard` (the ticket queue reads the board)
 *   workers/api/src/lib/applications/application-board.ts   `applicationCardId`, `upsertApplicationRunCard`, `syncApplicationCard`
 *   workers/api/src/lib/applications/application-runs.ts    `applicationRunsForCards`, `reconcileApplicationCard`
 *   workers/api/src/lib/coding-board.ts, board-runs.ts      `codingCardId`, `codingSessionIdFromCardId`, `reconcileCodingCard`
 *   workers/api/src/lib/local-browser/scan-board.ts         `scanCardId`, `syncScanCard`
 *   workers/api/src/routes/instances-tasks.ts   GET /:id/board, POST /:id/board/status, GET/PUT /:id/board-config, board item github-issue routes
 *   workers/api/src/routes/board-order-routes.ts            POST /:id/board/order
 *   workers/mcp/src/instance-tools/board.ts and src/index.ts   instance_board, set_board_item_status, reorder_board_item, get/update_agent_board_config
 *   store/console  tabs/BoardTab.tsx, lib/boardLanes.ts, lib/boardOrder.ts, components/BoardLanes.tsx and the Application/Scan/Issue faces
 *   ios/PAGS/Views/BoardView.swift
 *
 * ── DELIBERATELY NOT DONE HERE
 *   - No database change or migration, and no data is written, moved or deleted.
 *   - No route, MCP, console or iOS change; `buildInstanceBoard` is not imported or modified.
 *   - No lane change: the four lanes (Queued, In Progress, Blocked, Done), the Needs You badge and Waiting to Resume are not
 *     implemented. `nativeStatus` is passed through untouched so a lane rule can be built on it.
 *   - No change to the queue, scheduling, the engine, settings, or any running or parked work. Question triage is #1697.
 *
 * ── REMAINING CUTOVER
 *   1. `buildInstanceBoard` keys cards by `cardIdentityForRecord` instead of `jobKeyForTask`, keeping the job URL and the GitHub issue
 *      as display metadata (`githubIssue`, `url`).
 *   2. Application cards: write one card per run attempt (today `app-<applicationId>` is one row forever, `upsertWorkCard` is
 *      `ON CONFLICT(id)`), and decide whether a Tailor run is its own card or folds into the fill attempt that follows it.
 *   3. Queued objectives: resolve entry -> run -> session and replace the objective card with the session card exactly once, and close
 *      the `running`-claim window in which `listQueue` lists nothing.
 *   4. Move `board_items` overlays (position, user status, linked issue), tickets and `attempts` onto the new keys, without wiping history.
 *   5. Replace the seven issue lanes and the customizable `boardColumns` with the four shared lanes, after the caller audit, and document
 *      the effect on configured columns; retire the superseded projection code rather than keeping a parallel path.
 *   6. Expose the one projection to the All Agents view; update the MCP tools and the console.
 */
import { objectiveJobKey } from "./board-order.js";
import { codingSessionIdFromCardId } from "./board-runs.js";
import { codingCardId } from "./coding-board.js";
import { scanCardId } from "./local-browser/scan-board.js";

/** The owner and instance a card is named for. Both are required. */
export interface BoardIdentityScope {
	instanceId: string;
	userId: string;
}

/** A coding session as the board knows it: the session, and the loop runs behind it. */
export interface CodingSessionRecord {
	kind: "coding-session";
	instanceId: string;
	userId?: string;
	sessionId: string;
	/** The session's own status (`active` | `ended` | `error`), or its card's status. */
	status: string;
	/** Loop run ids behind the session, newest first, when the caller has them. */
	runIds?: readonly string[];
}

/** A scan run (`local_browser_runs`). */
export interface ScanRecord {
	kind: "scan";
	instanceId: string;
	userId?: string;
	runId: string;
	status: string;
}

/**
 * One execution of an application: a Runner fill run or a Tailor artifact run (`ApplicationRunFact`).
 * `applicationId` is metadata and never part of the card id.
 */
export interface ApplicationAttemptRecord {
	kind: "application-attempt";
	instanceId: string;
	userId?: string;
	applicationId: string;
	runKind: "fill" | "tailor";
	runId: string;
	status: string;
}

/** A pending or just-started `instance_objective_queue` entry. */
export interface QueuedObjectiveRecord {
	kind: "queued-objective";
	instanceId: string;
	userId?: string;
	/** `instance_objective_queue.id`. */
	entryId: string;
	/** `pending` | `running` | `started` | `cancelled` | `failed`. */
	status: string;
	/** `instance_objective_queue.run_id`, once started. */
	runId?: string | null;
	/** The coding session this entry became, resolved by the caller from `agent_loop_runs.session_id`. */
	sessionId?: string | null;
}

export type BoardIdentityRecord = CodingSessionRecord | ScanRecord | ApplicationAttemptRecord | QueuedObjectiveRecord;

export interface BoardCardIdentity {
	/** The stable card id. Never derived from a job URL, a GitHub issue or an applicant. */
	cardId: string;
	kind: BoardIdentityRecord["kind"];
	/** The record's own status, untouched: lanes are built on it later, not here. */
	nativeStatus: string;
	/** The instance the card is named for. */
	instanceId: string;
	/** The native executions behind this card, when the record names them. */
	attempts?: string[];
	/** Queued objectives only: the session card this entry became, when the caller could resolve it. */
	linkedSessionCardId?: string;
}

/** The application-attempt card id: one per execution, with the run kind in it so the two run tables cannot collide. */
export const applicationAttemptCardId = (runKind: "fill" | "tailor", runId: string): string => `app-attempt-${runKind}-${runId}`;

function required(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`board identity: ${what} is required`);
	return value;
}

function assertScope(scope: BoardIdentityScope): void {
	required(scope?.instanceId, "scope.instanceId");
	required(scope?.userId, "scope.userId");
}

/**
 * The identity of one record, for this owner and instance. Pure: it reads and writes nothing.
 *
 * Throws on an empty id or scope, and on a record that carries another instance or owner than `scope`: a record that is not in the
 * scope it is asked about gets no card, rather than a card that looks as if it belonged.
 */
export function cardIdentityForRecord(record: BoardIdentityRecord, scope: BoardIdentityScope): BoardCardIdentity {
	assertScope(scope);
	if (record.instanceId !== scope.instanceId) throw new Error("board identity: record belongs to a different instance");
	if (record.userId !== undefined && record.userId !== scope.userId) throw new Error("board identity: record belongs to a different owner");
	const base = { instanceId: scope.instanceId, kind: record.kind, nativeStatus: String(record.status ?? "") };
	switch (record.kind) {
		case "coding-session": {
			const sessionId = required(record.sessionId, "sessionId");
			return { cardId: codingCardId(sessionId), ...base, ...(record.runIds?.length ? { attempts: [...record.runIds] } : {}) };
		}
		case "scan": {
			const runId = required(record.runId, "runId");
			return { cardId: scanCardId(runId), ...base, attempts: [runId] };
		}
		case "application-attempt": {
			const runId = required(record.runId, "runId");
			if (record.runKind !== "fill" && record.runKind !== "tailor") throw new Error("board identity: runKind must be fill or tailor");
			// applicationId is required (an attempt is OF an application) but is metadata, never part of the id.
			required(record.applicationId, "applicationId");
			return { cardId: applicationAttemptCardId(record.runKind, runId), ...base, attempts: [runId] };
		}
		case "queued-objective": {
			const entryId = required(record.entryId, "entryId");
			const session = typeof record.sessionId === "string" && record.sessionId.trim() !== "" ? record.sessionId : undefined;
			return { cardId: objectiveJobKey(entryId), ...base, ...(session ? { linkedSessionCardId: codingCardId(session) } : {}) };
		}
	}
}

/**
 * The card an accepted objective becomes once its session exists: `from` is the queued card, `to` the session card. A consumer
 * replaces `from` with `to` exactly once, so the objective is never shown twice and never disappears between the two.
 */
export function queuedToSessionTransition(queueEntry: { id: string }, sessionCardId: string): { from: string; to: string } {
	const from = objectiveJobKey(required(queueEntry?.id, "queueEntry.id"));
	if (!codingSessionIdFromCardId(sessionCardId)) throw new Error("board identity: sessionCardId is not a coding session card id");
	return { from, to: sessionCardId };
}
