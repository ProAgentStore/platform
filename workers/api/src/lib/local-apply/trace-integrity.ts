import { parseLocalApplyEvent } from "./contract.js";
import type { ApplyTraceEvent } from "./store.js";

export const MAX_APPLY_TRACE = 500;
const cursor = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Preserve the runner's sequence identity without bypassing event sanitization. A malformed
 * batch cannot advance the cursor past evidence we could not retain. Supported runners have
 * always sent sequence numbers; unsequenced cloud events use updateApplyRun directly instead. */
export function parseApplyRunnerBatch(raw: unknown, lastSeq: unknown, afterSeq: number): { events: ApplyTraceEvent[]; lastSeq: number } | null {
	if (!cursor(lastSeq) || lastSeq < afterSeq || !Array.isArray(raw) || raw.length > MAX_APPLY_TRACE) return null;
	const events: ApplyTraceEvent[] = [];
	let previous = afterSeq;
	for (const value of raw) {
		const seq: unknown = value && typeof value === "object" ? value.seq : undefined;
		const parsed = parseLocalApplyEvent(value);
		if (!parsed || !cursor(seq) || seq !== previous + 1 || seq > lastSeq) return null;
		events.push({ ...parsed, seq });
		previous = seq;
	}
	return previous === lastSeq ? { events, lastSeq } : null;
}

/** Validate every stored sequence/cursor pair, including callers other than runner polling. */
export function validTraceAppend(events: ApplyTraceEvent[], runnerSeq?: number): boolean {
	if (runnerSeq !== undefined && !cursor(runnerSeq)) return false;
	let previous = 0;
	for (const event of events) {
		if (event.seq === undefined) continue;
		if (!cursor(event.seq) || event.seq <= previous || runnerSeq === undefined || event.seq > runnerSeq) return false;
		previous = event.seq;
	}
	return true;
}

/** Evaluated inside the UPDATE against the current row, never a caller's old trace. Two UNION
 * terms, no per-event bind parameters: normally at most 500 stored + 500 incoming events.
 * Keep append order (timestamps can collide), then retain the newest 500. json(value) prevents
 * aggregation from turning event objects into JSON strings. Existing legacy events need no seq.
 * ?9 is this writer's events; ?10 is its cursor. WHERE on the UPDATE rejects older responses. */
export const APPEND_APPLY_TRACE_SQL = `(WITH events AS (
	SELECT value, 0 AS part, CAST(key AS INTEGER) AS position FROM json_each(
		CASE WHEN json_valid(trace) THEN CASE WHEN json_type(trace) = 'array' THEN trace ELSE '[]' END ELSE '[]' END)
	UNION ALL
	SELECT value, 1 AS part, CAST(key AS INTEGER) AS position FROM json_each(?9)
	WHERE json_extract(value, '$.seq') IS NULL OR json_extract(value, '$.seq') > runner_seq
), retained AS (
	SELECT value, part, position FROM events ORDER BY part DESC, position DESC LIMIT ${MAX_APPLY_TRACE}
)
SELECT json_group_array(json(value)) FROM (SELECT value FROM retained ORDER BY part, position))`;
