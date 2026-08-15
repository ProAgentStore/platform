// Turn a supervisor's raw platform reads into the picture it decides from (#205).
//
// PURE — no D1, no Env, no I/O. All the judgement lives here (bucketing, staleness, the size cap)
// precisely so it is testable without a database stub, matching `supervision-graph.ts` and
// `escalation.ts`.
//
// The hardcoded Overseer opens by assembling exactly this shape one level down — for every repo:
// live? recent output? — then answers from it in ONE model call instead of starting work to find
// out. This is that assembly, over subordinate INSTANCES instead of repos, and built only from
// records every agent family writes.
import { columnForStatus, type BoardColumn } from "./agent-capabilities.js";
import { runHealth, waitClause, type RunHealth } from "./work-report.js";
import type { RunItem, WorkItem } from "./instance-work.js";

/** A board card, plus what the OWNING agent says its status means. */
export interface ObservedWork {
	id: string;
	kind: string;
	/** The agent's own word. Kept raw so a supervisor never has to trust our interpretation. */
	status: string;
	/** That agent's declared title for the column claiming `status` — null if nothing claims it. */
	columnTitle: string | null;
	title: string;
	detail: string;
	updatedAt: string;
}

export interface ObservedRun {
	runId: string;
	objective: string;
	/** A CLOSED platform enum (0062) — passed through, never bucketed through board columns. */
	status: string;
	stopReason: string | null;
	detail: string | null;
	iteration: number;
	maxIterations: number;
	/**
	 * The PLATFORM'S verdict on this run, from `runHealth` — the one implementation (#589).
	 *
	 * Not derived here and deliberately not derivable here: three surfaces answering "is this
	 * alright" independently is the #580 defect, and this file was one of the two that still did.
	 * A supervisor reads THIS, never `status`, to decide whether an agent is working.
	 */
	health: RunHealth;
	/** What a parked run is waiting for and until when. Null unless `health === "waiting"`. */
	waitNote: string | null;
	/**
	 * Minutes since the last recorded ADVANCE, for a run still `running`. Null otherwise.
	 *
	 * A FACT, never a verdict — and the distinction is load-bearing (`work-report.ts:136-141`).
	 * A long healthy engine turn and a deliberate park both produce a large number here, so
	 * reading it as staleness told an owner a run was stuck while the engine was mid-edit. It is
	 * reported so a supervisor can say "no new instruction for 4 hours"; `health` says what that
	 * MEANS, and the two are computed from different columns on purpose.
	 */
	quietForMinutes: number | null;
}

export interface SubordinateSummary {
	instanceId: string;
	name: string;
	/** `active | paused | canceled` — the SUBSCRIPTION lifecycle. Not what it is doing. */
	subscription: string;
	/** Counts by the agent's own column titles, e.g. {"Running": 1, "Needs you": 2}. */
	buckets: Array<{ id: string; title: string; count: number }>;
	work: ObservedWork[];
	runs: ObservedRun[];
	/**
	 * How many older work items the budget dropped from THIS subordinate (#503).
	 *
	 * Present only when something was dropped, and the trim now stops at one item rather than
	 * emptying the list: an empty `work` means IDLE — the legend says so in as many words — so a
	 * subordinate trimmed to nothing was reporting a busy agent as doing nothing, which is the same
	 * defect #259 is about arriving by a different route.
	 */
	workOmitted?: number;
}

export interface SubordinateInput {
	instanceId: string;
	name: string;
	subscription: string;
	/** Resolved per-instance override → agent declaration → per-surface default. */
	columns: BoardColumn[];
}

/**
 * Same ceiling the hardcoded Overseer uses for its own global context (`routes/coding.ts`). A
 * supervisor's picture has to fit in one prompt beside everything else, so this is a budget, not
 * a safety valve.
 */
export const MAX_OBSERVATION_CHARS = 16_000;

const minutesSince = (then: number, now: number) => Math.max(0, Math.round((now - then) / 60_000));

/**
 * Assemble the supervisor's view.
 *
 * Items are trimmed OLDEST-FIRST when the budget is exceeded, and `truncated` says so — dropping
 * the newest would hide exactly the thing a supervisor is asking about.
 */
export function summarizeSubordinates(input: {
	now: number;
	subordinates: SubordinateInput[];
	work: WorkItem[];
	runs: RunItem[];
	maxChars?: number;
}): { subordinates: SubordinateSummary[]; truncated: boolean } {
	const { now, subordinates, work, runs } = input;
	const maxChars = input.maxChars ?? MAX_OBSERVATION_CHARS;

	const workBy = new Map<string, WorkItem[]>();
	for (const w of work) {
		const list = workBy.get(w.instanceId) ?? [];
		list.push(w);
		workBy.set(w.instanceId, list);
	}
	// Newest first, established HERE rather than assumed from the caller. The reader happens to
	// return `ORDER BY updated_at DESC`, but the trim below drops from the tail — so relying on
	// the caller's ordering would silently discard the NEWEST items the moment a caller (or a
	// future reader) ordered differently, which is the opposite of what the budget is for.
	const at = (iso: string) => {
		const t = Date.parse(iso);
		return Number.isNaN(t) ? 0 : t;
	};
	for (const list of workBy.values()) list.sort((a, b) => at(b.updatedAt) - at(a.updatedAt));
	const runsBy = new Map<string, RunItem[]>();
	for (const r of runs) {
		const list = runsBy.get(r.instanceId) ?? [];
		list.push(r);
		runsBy.set(r.instanceId, list);
	}

	const out: SubordinateSummary[] = subordinates.map((s) => {
		const items = (workBy.get(s.instanceId) ?? []).map((w): ObservedWork => {
			// Bucketed through the SUBORDINATE'S OWN declaration. Supervision holds no status
			// vocabulary of its own — that is what lets an agent with columns named
			// "Triage / Cooking / Shipped" work here on day one with no platform change.
			const col = columnForStatus(s.columns, w.status);
			return {
				id: w.id,
				kind: w.kind,
				status: w.status,
				columnTitle: col?.title ?? null,
				title: w.title,
				detail: w.detail,
				updatedAt: w.updatedAt,
			};
		});

		const counts = new Map<string, { id: string; title: string; count: number }>();
		for (const w of items) {
			const col = columnForStatus(s.columns, w.status);
			if (!col) continue;
			const cur = counts.get(col.id) ?? { id: col.id, title: col.title, count: 0 };
			cur.count++;
			counts.set(col.id, cur);
		}

		const rs = (runsBy.get(s.instanceId) ?? []).map((r): ObservedRun => {
			// The verdict, from the module that owns it. `RunItem` now carries exactly the four
			// signals `runHealth` reads, so this is a call rather than a second rule (#589) — and
			// everything below that used to test the raw column now reads the verdict instead.
			const health = runHealth(r, now);
			return {
				runId: r.runId,
				objective: r.objective,
				status: r.status,
				stopReason: r.stopReason,
				detail: r.detail,
				iteration: r.iteration,
				maxIterations: r.maxIterations,
				health,
				waitNote: waitClause(r, now),
				// Only meaningful while the run is open. `lastProgressAt` falls back to `startedAt`
				// so a run that has never reported progress reads as quiet since it began — which is
				// the signal, not a gap. A finished run is not "quiet", it is done.
				quietForMinutes: health === "ended" ? null : minutesSince(r.lastProgressAt ?? r.startedAt, now),
			};
		});

		return { instanceId: s.instanceId, name: s.name, subscription: s.subscription, buckets: [...counts.values()], work: items, runs: rs };
	});

	// Trim to budget, oldest work first, across all subordinates.
	let truncated = false;
	const size = () => JSON.stringify(out).length;
	while (size() > maxChars) {
		let victim: SubordinateSummary | null = null;
		let oldest = Number.POSITIVE_INFINITY;
		for (const s of out) {
			// Never below one item. See `workOmitted`: a list trimmed to empty is read as idle.
			if (s.work.length <= 1) continue;
			const last = s.work[s.work.length - 1]; // sorted newest-first, so this is its oldest
			if (!last) continue;
			const ts = at(last.updatedAt);
			if (ts < oldest) {
				oldest = ts;
				victim = s;
			}
		}
		if (!victim) break; // nothing left to drop — runs, identity and one work item always survive
		victim.work.pop();
		victim.workOmitted = (victim.workOmitted ?? 0) + 1;
		truncated = true;
	}

	return { subordinates: out, truncated };
}
