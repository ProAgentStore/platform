/**
 * The owner's coding history across every instance (#1335): what the picker chose and passed over, what was queued, admitted,
 * refused or deferred, and which of that became a real run — one filterable, pageable read.
 *
 * It is a READ MODEL over the records that already exist, not a ledger of its own (#1017 built the ledger):
 *
 *   attempt   a queue entry (`instance_objective_queue`) — an ATTEMPT to start work. It may never become a run.
 *   run       a run (`agent_loop_runs`) that no queue entry led to — a direct start.
 *   picker    an auto-pickup decision with no entry of its own (`auto_pickup_log`): passed over, nothing eligible, capped, gated, busy.
 *   request   a start request (`loop_start_receipts`) that made neither entry nor run: a duplicate, a refusal, an unknown outcome.
 *
 * An attempt that became a run is ONE item carrying both; it is not counted twice. So "98 attempts" and "0 runs" are
 * different numbers, and an admission that failed before any run existed is an attempt with `run: null`, never a run.
 *
 * ── What a reader can rely on
 *
 *  • Paging is keyset: newest first, `(at DESC, sk DESC)`, the cursor names the last item seen. Items inserted while a reader
 *    pages sort above the cursor and never shift or repeat a later page.
 *  • The SUMMARY and the COVERAGE are computed over the whole requested range with the same filters — never over the page.
 *  • Nothing is reconstructed. A row older than the lifecycle ledger (0212) says its transitions were not recorded; a row with no
 *    recorded issue cannot be matched by an issue filter and is COUNTED as such; a deployment is not recorded per run and the
 *    response says so instead of leaving a null that reads as "none".
 *  • Isolation is the `user_id` of every source row. Text that came from a driver or a caller (stop reasons, picker detail) is
 *    redacted and clipped; an objective's own text is never returned.
 */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { instanceListName } from "./instance-config.js";
import { keysetCursor, olderThan, type Keyset } from "./keyset-cursor.js";
import { redactText } from "./redact.js";

export const FLEET_HISTORY_PAGE_DEFAULT = 25;
export const FLEET_HISTORY_PAGE_MAX = 100;
/** Instances itemised in the summary and the coverage. Past it the response says so; the totals still count every instance. */
export const FLEET_HISTORY_INSTANCES_MAX = 200;
const REASON_MAX = 300;

export const FLEET_KINDS = ["attempt", "run", "picker", "request"] as const;
export type FleetKind = (typeof FLEET_KINDS)[number];

/** Every outcome a filter may name. Run states, queue states of an attempt with no run, the picker's decisions, a request's fate. */
export const FLEET_OUTCOMES = [
	"running", "completed", "failed", "needs_human", "cancelled",
	"queued", "deferred", "claimed", "queue_cancelled", "admission_failed",
	"started", "none_eligible", "skipped_failed", "capped", "skipped_gate", "skipped_busy", "error", "passed_over", "closed_done", "flagged_review",
	"duplicate", "not_started", "outcome_unknown",
] as const;
export type FleetOutcome = (typeof FLEET_OUTCOMES)[number];

export interface FleetFilter {
	userId: string;
	instanceId?: string;
	/** `owner/name`, as the repo is imported from GitHub. */
	repo?: string;
	issue?: number;
	/** Inclusive, ms epoch. */
	since?: number;
	/** Inclusive, ms epoch. */
	until?: number;
	outcome?: FleetOutcome;
	kind?: FleetKind;
}

// Metadata is caller-owned JSON and may not be JSON at all; `json_extract` on text that is not JSON raises, so it is guarded.
const META = (path: string) => `(CASE WHEN json_valid(q.metadata) THEN json_extract(q.metadata, '${path}') END)`;
const DUPLICATE = "(json_valid(rc.response_json) AND json_extract(rc.response_json, '$.duplicate_of') IS NOT NULL)";

/** Every source as one row shape. Parameter `?1` is the owner; everything else is filtered by the caller of this CTE. */
const ITEMS_CTE = `WITH items AS (
	SELECT 'attempt' AS kind, q.id AS id, 'attempt.' || q.id AS sk, q.created_at AS at, q.instance_id AS instance_id,
	       COALESCE(${META("$.autoPickup.repo")}, cr.github_repo) AS repo,
	       COALESCE(q.issue_number, CAST(${META("$.autoPickup.issue")} AS INTEGER)) AS issue,
	       CASE WHEN r.run_id IS NOT NULL THEN r.status
	            WHEN q.status = 'pending' THEN CASE WHEN COALESCE(q.deferral_count, 0) > 0 THEN 'deferred' ELSE 'queued' END
	            WHEN q.status = 'running' THEN 'claimed'
	            WHEN q.status = 'cancelled' THEN 'queue_cancelled'
	            WHEN q.status = 'failed' THEN 'admission_failed'
	            ELSE q.status END AS outcome,
	       r.run_id AS run_id
	  FROM instance_objective_queue q
	  LEFT JOIN coding_repos cr ON cr.id = q.repo_id
	  LEFT JOIN agent_loop_runs r ON r.run_id = q.run_id
	 WHERE q.user_id = ?1
	UNION ALL
	SELECT 'run', r.run_id, 'run.' || r.run_id, r.started_at, r.instance_id, cr.github_repo, r.issue_number, r.status, r.run_id
	  FROM agent_loop_runs r
	  LEFT JOIN coding_sessions s ON s.id = r.session_id
	  LEFT JOIN coding_repos cr ON cr.id = s.repo_id
	 WHERE r.user_id = ?1 AND NOT EXISTS (SELECT 1 FROM instance_objective_queue q2 WHERE q2.run_id = r.run_id AND q2.user_id = ?1)
	UNION ALL
	SELECT 'picker', l.id, 'picker.' || l.id, l.created_at, l.instance_id, l.repo, l.issue_number, l.outcome, NULL
	  FROM auto_pickup_log l
	 WHERE l.user_id = ?1 AND l.reserved = 0
	   AND NOT (l.outcome = 'started' AND EXISTS (SELECT 1 FROM instance_objective_queue q3 WHERE q3.id = l.entry_id AND q3.user_id = ?1))
	UNION ALL
	SELECT 'request', CAST(rc.rowid AS TEXT), 'request.' || rc.rowid, rc.created_at, rc.instance_id, NULL, NULL,
	       CASE WHEN ${DUPLICATE} THEN 'duplicate' WHEN rc.state = 'not_started' THEN 'not_started' ELSE 'outcome_unknown' END, NULL
	  FROM loop_start_receipts rc
	 WHERE rc.user_id = ?1 AND (${DUPLICATE} OR rc.state IN ('not_started', 'unknown'))
)`;

/** `WHERE` for a filter: the conditions and the binds that follow `?1`. `skipIssueRepo` counts what those two filters cannot see. */
function whereOf(f: FleetFilter, opts: { skipIssueRepo?: boolean; keyset?: Keyset | null; p?: string } = {}): { sql: string; binds: unknown[] } {
	const p = opts.p ?? "";
	const binds: unknown[] = [];
	const conds: string[] = [];
	const add = (cond: (n: number) => string, ...values: unknown[]) => {
		conds.push(cond(binds.length + 2));
		binds.push(...values);
	};
	if (f.instanceId) add((n) => `${p}instance_id = ?${n}`, f.instanceId);
	if (f.kind) add((n) => `${p}kind = ?${n}`, f.kind);
	if (f.outcome) add((n) => `${p}outcome = ?${n}`, f.outcome);
	if (f.since !== undefined) add((n) => `${p}at >= ?${n}`, f.since);
	if (f.until !== undefined) add((n) => `${p}at <= ?${n}`, f.until);
	if (!opts.skipIssueRepo) {
		if (f.repo) add((n) => `${p}repo = ?${n}`, f.repo);
		if (f.issue !== undefined) add((n) => `${p}issue = ?${n}`, f.issue);
	}
	if (opts.keyset) {
		const n = binds.length + 2;
		conds.push(olderThan(`${p}at`, `${p}sk`, n));
		binds.push(opts.keyset.at, opts.keyset.id);
	}
	return { sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "", binds };
}

const clip = (v: string | null | undefined): string | null => (v ? clipMarked(redactText(v), REASON_MAX) : null);
const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());

type Actor = { kind: "owner"; uid: string; verified: true; clientClaimed: string | null } | { kind: "platform"; via: string } | { kind: "unknown"; legacy: true };

export interface FleetItem {
	kind: FleetKind;
	id: string;
	at: number;
	instanceId: string;
	instanceName: string | null;
	repo: string | null;
	issue: number | null;
	outcome: string;
	/** The handles that join this item to the lifecycle ledger, `coding_loop_lifecycle`, `coding_loop_status` and the run. */
	correlation: { requestId: string | null; queueEntryId: string | null; runId: string | null; sessionId: string | null };
	machine: string | null;
	actor: Actor;
	/** The queue entry, when this item is an attempt: how it was admitted, deferred or refused. */
	attempt: { status: string; deferrals: number | null; reason: string | null; nextRetryAt: number | null; startedAt: number | null; finishedAt: number | null } | null;
	/** The real run, if there is one. `null` on an attempt that never got one — an admission failure is not a run. */
	run: { id: string; status: string; stopReason: string | null; startedAt: number; finishedAt: number | null } | null;
	/** The picker's decision behind this item: the selection that created the entry, or the skip itself. */
	picker: { outcome: string; detail: string | null; at: number } | null;
	/** `recorded`: the lifecycle ledger holds this objective's transitions. `predates_ledger`: it began before the ledger did. `not_recorded`: after it began, with none. */
	transitions: { events: number; history: "recorded" | "predates_ledger" | "not_recorded" | "not_applicable" };
	deployment: null;
}

interface Slim {
	kind: FleetKind;
	id: string;
	sk: string;
	at: number;
	instance_id: string;
	repo: string | null;
	issue: number | null;
	outcome: string;
	run_id: string | null;
}

const inList = (n: number, start: number) => Array.from({ length: n }, (_, i) => `?${start + i}`).join(",");

/** D1 allows 100 bound parameters a statement: an `IN (...)` over a full page is read in chunks, never as one oversized statement. */
const IN_CHUNK = 80;
async function readIn<T>(env: Env, userId: string, ids: readonly string[] | readonly number[], sql: (list: string) => string): Promise<T[]> {
	const out: T[] = [];
	for (let i = 0; i < ids.length; i += IN_CHUNK) {
		const part = ids.slice(i, i + IN_CHUNK);
		const res = await env.DB.prepare(sql(inList(part.length, 2))).bind(userId, ...part).all<T>();
		out.push(...(res.results ?? []));
	}
	return out;
}

async function enrich(env: Env, userId: string, rows: Slim[]): Promise<FleetItem[]> {
	const by = (k: FleetKind) => rows.filter((r) => r.kind === k).map((r) => r.id);
	const attemptIds = by("attempt");
	const runIds = [...by("run"), ...rows.filter((r) => r.kind === "attempt" && r.run_id).map((r) => r.run_id as string)];
	const pickerIds = by("picker");
	const requestRowids = by("request").map(Number);

	type Q = { id: string; status: string; stop_reason: string | null; defer_reason: string | null; next_retry_at: number | null; deferral_count: number | null; request_id: string | null; actor_uid: string | null; client_claimed: string | null; autopick: number; started_at: number | null; finished_at: number | null };
	const queue = new Map<string, Q>();
	for (const q of await readIn<Q>(env, userId, attemptIds, (list) =>
		`SELECT id, status, stop_reason, defer_reason, next_retry_at, deferral_count, request_id, actor_uid, client_claimed, started_at, finished_at,
		        CASE WHEN json_valid(metadata) AND json_extract(metadata, '$.autoPickup') IS NOT NULL THEN 1 ELSE 0 END AS autopick
		   FROM instance_objective_queue WHERE user_id = ?1 AND id IN (${list})`,
	)) queue.set(q.id, q);
	type R = { run_id: string; status: string; stop_reason: string | null; started_at: number; finished_at: number | null; session_id: string | null; request_id: string | null; queue_entry_id: string | null; delegated_by: string | null; runner_node: string | null };
	const runs = new Map<string, R>();
	for (const r of await readIn<R>(env, userId, runIds, (list) =>
		`SELECT r.run_id, r.status, r.stop_reason, r.started_at, r.finished_at, r.session_id, r.request_id, r.queue_entry_id, r.delegated_by, s.runner_node
		   FROM agent_loop_runs r LEFT JOIN coding_sessions s ON s.id = r.session_id WHERE r.user_id = ?1 AND r.run_id IN (${list})`,
	)) runs.set(r.run_id, r);
	type P = { id: string; entry_id: string | null; outcome: string; detail: string | null; created_at: number };
	const pickerByEntry = new Map<string, P>();
	const pickerById = new Map<string, P>();
	for (const p of await readIn<P>(env, userId, attemptIds, (list) => `SELECT id, entry_id, outcome, detail, created_at FROM auto_pickup_log WHERE user_id = ?1 AND entry_id IN (${list})`)) if (p.entry_id) pickerByEntry.set(p.entry_id, p);
	for (const p of await readIn<P>(env, userId, pickerIds, (list) => `SELECT id, entry_id, outcome, detail, created_at FROM auto_pickup_log WHERE user_id = ?1 AND id IN (${list})`)) pickerById.set(p.id, p);
	type Rc = { rid: number; request_id: string; state: string; actor_uid: string | null; client_claimed: string | null; dup: string | null };
	const requests = new Map<string, Rc>();
	for (const r of await readIn<Rc>(env, userId, requestRowids, (list) =>
		`SELECT rc.rowid AS rid, rc.request_id, rc.state, rc.actor_uid, rc.client_claimed,
		        CASE WHEN json_valid(rc.response_json) THEN json_extract(rc.response_json, '$.duplicate_of') END AS dup
		   FROM loop_start_receipts rc WHERE rc.user_id = ?1 AND rc.rowid IN (${list})`,
	)) requests.set(String(r.rid), r);

	// Lifecycle events per handle, and where each instance's ledger starts (the 0212 line a row can predate).
	const events = new Map<string, number>();
	for (const [col, ids] of [["queue_entry_id", attemptIds], ["run_id", runIds]] as const) {
		for (const e of await readIn<{ h: string; n: number }>(env, userId, ids, (list) => `SELECT ${col} AS h, COUNT(*) AS n FROM objective_lifecycle_events WHERE user_id = ?1 AND ${col} IN (${list}) GROUP BY ${col}`)) events.set(`${col}.${e.h}`, e.n);
	}
	const instanceIds = [...new Set(rows.map((r) => r.instance_id))];
	const ledgerStart = new Map<string, number>();
	for (const l of await readIn<{ instance_id: string; at: number }>(env, userId, instanceIds, (list) => `SELECT instance_id, MIN(created_at) AS at FROM objective_lifecycle_events WHERE user_id = ?1 AND instance_id IN (${list}) GROUP BY instance_id`)) ledgerStart.set(l.instance_id, l.at);
	const names = await instanceNames(env, userId);

	return rows.map((row): FleetItem => {
		const q = row.kind === "attempt" ? (queue.get(row.id) ?? null) : null;
		const run = runs.get(row.kind === "run" ? row.id : (row.run_id ?? "")) ?? null;
		const picker = row.kind === "attempt" ? (pickerByEntry.get(row.id) ?? null) : row.kind === "picker" ? (pickerById.get(row.id) ?? null) : null;
		const rc = row.kind === "request" ? (requests.get(row.id) ?? null) : null;
		const count = (row.kind === "attempt" ? events.get(`queue_entry_id.${row.id}`) : row.kind === "run" ? events.get(`run_id.${row.id}`) : undefined) ?? 0;
		const runEvents = row.kind === "attempt" && row.run_id ? (events.get(`run_id.${row.run_id}`) ?? 0) : 0;
		const n = count + runEvents;
		const start = ledgerStart.get(row.instance_id);
		const history: FleetItem["transitions"]["history"] = row.kind === "picker" || row.kind === "request" ? "not_applicable" : n > 0 ? "recorded" : start === undefined || row.at < start ? "predates_ledger" : "not_recorded";
		const actor: Actor =
			q?.actor_uid ? { kind: "owner", uid: q.actor_uid, verified: true, clientClaimed: q.client_claimed }
			: rc?.actor_uid ? { kind: "owner", uid: rc.actor_uid, verified: true, clientClaimed: rc.client_claimed }
			: q?.autopick ? { kind: "platform", via: "auto_pickup" }
			: row.kind === "picker" ? { kind: "platform", via: "auto_pickup" }
			: { kind: "unknown", legacy: true };
		return {
			kind: row.kind,
			id: row.id,
			at: row.at,
			instanceId: row.instance_id,
			instanceName: names.get(row.instance_id) ?? null,
			repo: row.repo,
			issue: row.issue,
			outcome: row.outcome,
			correlation: {
				requestId: q?.request_id ?? run?.request_id ?? rc?.request_id ?? null,
				queueEntryId: row.kind === "attempt" ? row.id : (run?.queue_entry_id ?? null),
				runId: run?.run_id ?? null,
				sessionId: run?.session_id ?? null,
			},
			machine: run?.runner_node ?? null,
			actor,
			attempt: q ? { status: q.status, deferrals: q.deferral_count, reason: clip(q.defer_reason ?? q.stop_reason), nextRetryAt: q.next_retry_at, startedAt: q.started_at, finishedAt: q.finished_at } : null,
			run: run ? { id: run.run_id, status: run.status, stopReason: clip(run.stop_reason), startedAt: run.started_at, finishedAt: run.finished_at } : null,
			picker: picker ? { outcome: picker.outcome, detail: clip(picker.detail), at: picker.created_at } : null,
			transitions: { events: n, history },
			deployment: null,
		};
	});
}

async function instanceNames(env: Env, userId: string): Promise<Map<string, string | null>> {
	const res = await env.DB.prepare("SELECT i.id, i.config, a.name FROM agent_instances i JOIN agents a ON a.id = i.agent_id WHERE i.user_id = ?1").bind(userId).all<{ id: string; config: string | null; name: string | null }>();
	return new Map((res.results ?? []).map((r) => [r.id, instanceListName(r.config, r.name)] as const));
}

export interface FleetSummary {
	/** Always `full_range`: these numbers are over every item the filters select, not the page. */
	scope: "full_range";
	/** Queue entries — tries to start work. */
	attempts: number;
	/** Real runs: attempts that got one, plus runs started directly. */
	runs: number;
	/** Attempts that failed admission before any run existed. They are attempts, not runs. */
	admissionFailuresWithoutRun: number;
	/** Attempts with no run: still queued, deferred or claimed, cancelled in the queue, or failed admission (which these include). */
	attemptsWithoutRun: number;
	pickerDecisions: number;
	requests: number;
	byOutcome: Record<string, number>;
	byKind: Record<FleetKind, number>;
	byInstance: Array<{ instanceId: string; instanceName: string | null; attempts: number; runs: number; admissionFailuresWithoutRun: number; pickerDecisions: number; requests: number }>;
	instancesTruncated: boolean;
}

export interface FleetCoverage {
	requested: { since: string | null; until: string | null };
	/** `complete` only when no gap below applies. Paging reaching its end says nothing about this. */
	status: "complete" | "partial";
	/** The earliest row each source holds in this scope — what older data does not exist. */
	earliest: { attempts: string | null; runs: string | null; pickerDecisions: string | null; requests: string | null };
	/** Per instance, when the lifecycle ledger (#1017) started recording its transitions. */
	ledgerStartedAt: Array<{ instanceId: string; at: string | null }>;
	/** When the picker began writing a row per candidate it passed over (#1335). Before this its reasons live only in other rows' detail text. */
	passedOverRecordedSince: string | null;
	retention: { queue: string; runs: string; pickerLog: string; lifecycle: string; requests: string; mcpAudit: string };
	deployment: string;
	gaps: string[];
}

async function summarise(env: Env, f: FleetFilter): Promise<{ summary: FleetSummary; preLedger: Map<string, number> }> {
	const w = whereOf(f, { p: "items." });
	// The ledger's start per instance is read once (a grouped CTE) and joined, not re-derived per row.
	const res = await env.DB.prepare(
		`${ITEMS_CTE}, ledger AS (SELECT instance_id, MIN(created_at) AS first_at FROM objective_lifecycle_events WHERE user_id = ?1 GROUP BY instance_id)
		 SELECT items.kind AS kind, items.outcome AS outcome, items.instance_id AS instance_id, COUNT(*) AS n, COUNT(items.run_id) AS runs,
		        SUM(CASE WHEN items.kind IN ('attempt', 'run') AND items.at < COALESCE(ledger.first_at, 9007199254740991) THEN 1 ELSE 0 END) AS pre_ledger
		   FROM items LEFT JOIN ledger ON ledger.instance_id = items.instance_id ${w.sql} GROUP BY items.kind, items.outcome, items.instance_id LIMIT 5001`,
	).bind(f.userId, ...w.binds).all<{ kind: FleetKind; outcome: string; instance_id: string; n: number; runs: number; pre_ledger: number }>();
	const rows = res.results ?? [];
	const names = await instanceNames(env, f.userId);
	const summary: FleetSummary = {
		scope: "full_range",
		attempts: 0, runs: 0, admissionFailuresWithoutRun: 0, attemptsWithoutRun: 0, pickerDecisions: 0, requests: 0,
		byOutcome: {}, byKind: { attempt: 0, run: 0, picker: 0, request: 0 }, byInstance: [], instancesTruncated: rows.length > 5000,
	};
	const per = new Map<string, FleetSummary["byInstance"][number]>();
	const preLedger = new Map<string, number>();
	for (const r of rows.slice(0, 5000)) {
		summary.byKind[r.kind] += r.n;
		summary.byOutcome[r.outcome] = (summary.byOutcome[r.outcome] ?? 0) + r.n;
		const i = per.get(r.instance_id) ?? { instanceId: r.instance_id, instanceName: names.get(r.instance_id) ?? null, attempts: 0, runs: 0, admissionFailuresWithoutRun: 0, pickerDecisions: 0, requests: 0 };
		// A run id appears in exactly one item (an attempt that got it, or a direct run), so per-group distinct counts add up.
		summary.runs += r.runs;
		i.runs += r.runs;
		if (r.kind === "attempt") {
			summary.attempts += r.n;
			i.attempts += r.n;
			if (r.outcome === "admission_failed") {
				summary.admissionFailuresWithoutRun += r.n;
				i.admissionFailuresWithoutRun += r.n;
			}
			summary.attemptsWithoutRun += r.n - r.runs;
		}
		if (r.kind === "picker") {
			summary.pickerDecisions += r.n;
			i.pickerDecisions += r.n;
		}
		if (r.kind === "request") {
			summary.requests += r.n;
			i.requests += r.n;
		}
		per.set(r.instance_id, i);
		if (r.pre_ledger) preLedger.set(r.instance_id, (preLedger.get(r.instance_id) ?? 0) + r.pre_ledger);
	}
	const all = [...per.values()].sort((a, b) => b.attempts + b.runs - (a.attempts + a.runs) || a.instanceId.localeCompare(b.instanceId));
	summary.byInstance = all.slice(0, FLEET_HISTORY_INSTANCES_MAX);
	summary.instancesTruncated ||= all.length > FLEET_HISTORY_INSTANCES_MAX;
	return { summary, preLedger };
}

async function coverageOf(env: Env, f: FleetFilter, summary: FleetSummary, preLedger: Map<string, number>): Promise<FleetCoverage> {
	const scope = f.instanceId ? " AND instance_id = ?2" : "";
	const sb = f.instanceId ? [f.userId, f.instanceId] : [f.userId];
	const min = async (table: string, col: string, extra = "") =>
		(await env.DB.prepare(`SELECT MIN(${col}) AS at FROM ${table} WHERE user_id = ?1${scope}${extra}`).bind(...sb).first<{ at: number | null }>())?.at ?? null;
	const [attempts, runs, picker, requests, passedOver, ledgers] = await Promise.all([
		min("instance_objective_queue", "created_at"),
		min("agent_loop_runs", "started_at"),
		min("auto_pickup_log", "created_at", " AND reserved = 0"),
		min("loop_start_receipts", "created_at"),
		min("auto_pickup_log", "created_at", " AND outcome = 'passed_over'"),
		env.DB.prepare(`SELECT instance_id, MIN(created_at) AS at FROM objective_lifecycle_events WHERE user_id = ?1${scope} GROUP BY instance_id LIMIT ${FLEET_HISTORY_INSTANCES_MAX + 1}`).bind(...sb).all<{ instance_id: string; at: number }>(),
	]);
	const names = await instanceNames(env, f.userId);
	const ledgerRows = ledgers.results ?? [];
	const ledgerAt = new Map(ledgerRows.map((l) => [l.instance_id, l.at] as const));
	const gaps: string[] = [];
	let partial = false;

	for (const [instanceId, n] of preLedger) {
		const start = ledgerAt.get(instanceId);
		const who = names.get(instanceId) ?? instanceId;
		gaps.push(`${n} attempt(s)/run(s) on ${who} began ${start === undefined ? "with no lifecycle ledger for this instance at all" : `before its lifecycle ledger started (${new Date(start).toISOString()})`}: their transitions (queued, admitted, deferred, finished) were not recorded and are not reconstructed. Their attempt and run records are intact.`);
		partial = true;
	}

	const earliestAny = [attempts, runs, picker, requests].filter((v): v is number => v !== null);
	const earliest = earliestAny.length ? Math.min(...earliestAny) : null;
	if (f.since !== undefined && (earliest === null || f.since < earliest)) {
		gaps.push(earliest === null ? "No coding history is recorded in this scope at all." : `Nothing is recorded before ${new Date(earliest).toISOString()} in this scope; the requested range starts earlier (${new Date(f.since).toISOString()}), so any older work is simply not here.`);
		partial = true;
	}

	if (f.issue !== undefined || f.repo) {
		const w = whereOf(f, { skipIssueRepo: true });
		const missing = `(${[f.issue !== undefined ? "issue IS NULL" : "", f.repo ? "repo IS NULL" : ""].filter(Boolean).join(" OR ")})`;
		const unknown = await env.DB.prepare(`${ITEMS_CTE} SELECT kind, COUNT(*) AS n FROM items ${w.sql ? `${w.sql} AND` : "WHERE"} kind IN ('attempt', 'run', 'request') AND ${missing} GROUP BY kind`)
			.bind(f.userId, ...w.binds)
			.all<{ kind: FleetKind; n: number }>();
		for (const u of unknown.results ?? []) {
			if (!u.n) continue;
			const what = f.issue !== undefined && f.repo ? "issue or repo" : f.issue !== undefined ? "issue" : "repo";
			gaps.push(`${u.n} ${u.kind}(s) in this range have no recorded ${what} (created before it was recorded${u.kind === "request" ? ", or a request, which does not index it" : ""}) and cannot be matched by this ${what} filter, so they are NOT in the items or the summary above.`);
			partial = true;
		}
	}

	if (f.kind === undefined || f.kind === "picker") {
		if (passedOver === null) gaps.push("The picker has not yet recorded a candidate it passed over: before that, the reason an issue was skipped is only inside the detail text of the entry it chose or of the none_eligible row.");
		else if (f.since === undefined || f.since < passedOver) gaps.push(`The picker records each candidate it passed over from ${new Date(passedOver).toISOString()}; before that, skip reasons are only inside the detail text of the entry it chose or of the none_eligible row.`);
		if (passedOver === null || f.since === undefined || f.since < passedOver) partial = true;
	}
	if (summary.instancesTruncated) {
		gaps.push(`Only the ${FLEET_HISTORY_INSTANCES_MAX} busiest instances are itemised; the totals still count every instance.`);
		partial = true;
	}

	return {
		requested: { since: iso(f.since), until: iso(f.until) },
		status: partial ? "partial" : "complete",
		earliest: { attempts: iso(attempts), runs: iso(runs), pickerDecisions: iso(picker), requests: iso(requests) },
		ledgerStartedAt: ledgerRows.slice(0, FLEET_HISTORY_INSTANCES_MAX).map((l) => ({ instanceId: l.instance_id, at: iso(l.at) })),
		passedOverRecordedSince: iso(passedOver),
		retention: {
			queue: "kept indefinitely (no sweep deletes queue entries)",
			runs: "kept indefinitely",
			pickerLog: "kept indefinitely; only unfinished reservation rows are deleted",
			lifecycle: "kept indefinitely, from each instance's ledger start (migration 0212)",
			requests: "kept indefinitely",
			mcpAudit: "90 days (the MCP audit log is separate from this history)",
		},
		deployment: "Deployment is not recorded against a run, so no item carries deployment evidence; `deployment` is always null and means unobserved, not none.",
		gaps,
	};
}

export interface FleetHistoryPage {
	asOf: number;
	filters: { instanceId: string | null; repo: string | null; issue: number | null; since: string | null; until: string | null; outcome: string | null; kind: string | null };
	items: FleetItem[];
	/** `false` while older items remain: PAGING, not a claim the history is whole — see `coverage`. */
	complete: boolean;
	nextCursor: string | null;
	summary: FleetSummary | null;
	coverage: FleetCoverage | null;
}

export async function listFleetHistory(env: Env, f: FleetFilter, opts: { cursor?: Keyset | null; limit?: number; summary?: boolean; now?: number } = {}): Promise<FleetHistoryPage> {
	const limit = Math.max(1, Math.min(FLEET_HISTORY_PAGE_MAX, Math.trunc(opts.limit ?? FLEET_HISTORY_PAGE_DEFAULT) || FLEET_HISTORY_PAGE_DEFAULT));
	const w = whereOf(f, { keyset: opts.cursor ?? null });
	const res = await env.DB.prepare(`${ITEMS_CTE} SELECT kind, id, sk, at, instance_id, repo, issue, outcome, run_id FROM items ${w.sql} ORDER BY at DESC, sk DESC LIMIT ?${w.binds.length + 2}`)
		.bind(f.userId, ...w.binds, limit + 1)
		.all<Slim>();
	const rows = res.results ?? [];
	const page = rows.slice(0, limit);
	const more = rows.length > limit;
	const items = await enrich(env, f.userId, page);
	let summary: FleetSummary | null = null;
	let coverage: FleetCoverage | null = null;
	if (opts.summary !== false) {
		const s = await summarise(env, f);
		summary = s.summary;
		coverage = await coverageOf(env, f, s.summary, s.preLedger);
	}
	const last = page[page.length - 1];
	return {
		asOf: opts.now ?? Date.now(),
		filters: { instanceId: f.instanceId ?? null, repo: f.repo ?? null, issue: f.issue ?? null, since: iso(f.since), until: iso(f.until), outcome: f.outcome ?? null, kind: f.kind ?? null },
		items,
		complete: !more,
		nextCursor: more && last ? keysetCursor(last.at, last.sk) : null,
		summary,
		coverage,
	};
}
