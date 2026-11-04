/** Compact fixtures specify relevant events only; supply the omitted note events so the fake
 * runner still honors its real contiguous, afterSeq-filtered transport contract (#1524). */
export function completeRunnerBatch(raw: unknown, after: unknown): unknown {
	const body = raw as { events?: Array<{ seq: number }>; lastSeq: number };
	const afterSeq = typeof after === "number" ? after : 0;
	const events = new Map((body.events ?? []).map((event) => [event.seq, event]));
	return { ...body, events: Array.from({ length: Math.max(0, body.lastSeq - afterSeq) }, (_, i) => {
		const seq = afterSeq + i + 1;
		return events.get(seq) ?? { seq, type: "note", at: "2026-10-07T00:00:00Z", detail: { reason: "fixture event" } };
	}) };
}
