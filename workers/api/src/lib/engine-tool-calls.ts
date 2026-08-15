/**
 * The per-tool-call record — each call, its argument and its result (#581 AC7).
 *
 * ── The half `da4bcec` could not close, and why it needs no new writes
 *
 * #581 shipped as a reader over `coding_timeline` and stated plainly what it did not answer:
 * *"show me every tool call this iteration made, with its inputs and outputs"*. `content` is free
 * text, and the only STRUCTURED record was `agent_events` `act.consequential` — which by design
 * holds the consequential acts alone. An ordinary read, grep or file open produced no row at all.
 *
 * The write-side work that seemed to imply turns out not to be needed, and the reason was measured
 * rather than assumed. `headless.ts:670` already pushes EVERY `tool_use` into the transcript as
 * `⚙ <name> <input>`, and `:676` pushes every `tool_result` as `  ↳ <result>`. That transcript is
 * the pane, the pane is what a `terminal` row stores, and those rows are already in D1.
 *
 * Sampled from production D1 on 2026-08-15:
 *
 *   · **883 of 914** `terminal` rows (96.6%) carry `⚙` call markers AND `↳` result markers.
 *   · One 86-row session held **1,036 call lines, a mean of 12.05 per row**.
 *   · The feed showed at most ONE of those twelve: {@link FEED_TERMINAL_CHARS} keeps a 400-char
 *     tail of an 8,000-char pane, so ~95% of the record the owner asked for was being cut away by
 *     a size bound rather than being absent.
 *
 * So the record belongs HERE, derived at read time, and that is a decision with four reasons:
 *
 *   1. it covers every run **already recorded**, where a runner change covers only runs made after
 *      a CLI publish AND a user upgrade;
 *   2. it adds no D1 writes — a write-side record would be ~12 rows per snapshot, ~10k rows for the
 *      corpus that already exists, for information the same corpus already carries;
 *   3. it stays behind the ONE place the platform already treats the runner's report as evidence
 *      rather than as truth (`engine-acts.ts`), so nothing new has to be trusted;
 *   4. its fidelity ceiling is the runner's own DISPLAY caps — 160 chars of input
 *      (`headless.ts:899`) and 240 of result (`:910`) — which is a separate and much smaller
 *      decision than inventing a second record, and one this module reports rather than hides.
 *
 * ── What it deliberately does NOT carry
 *
 * **Whether the call SUCCEEDED.** `settleAct` reads `block.is_error` (`headless.ts:750`) but
 * `toolResult()` never writes it into the transcript, so the pane does not contain it. Recording an
 * `ok` here would mean deriving it from the result text, which is the guess `describeEngineAct`
 * refuses on the same data ("outcome not observed" is a different claim from "it worked"). A
 * pending call reports `output: null` — the result had not come back when the snapshot was taken,
 * which is a REAL and live state — and a failed call reports its error text as its output, like any
 * other. Closing that gap is a runner change, and it is named on the issue rather than faked here.
 *
 * ── Only the structured engine has this record at all
 *
 * `⚙`/`↳` framing exists solely on the `stream-json` path (Claude Code). A Codex/Grok session is a
 * raw spawn whose stdout is captured verbatim, so it yields zero calls — the same "not observed,
 * never nothing happened" rule `takeActs` states for a raw engine.
 */

/** The line prefix `headless.ts` writes for a `tool_use` block. */
const CALL_MARK = "⚙ ";
/** The line prefix it writes for the matching `tool_result`. */
const RESULT_MARK = "↳ ";

/** One call the engine made, as the transcript recorded it. */
export interface EngineToolCall {
	/** The tool's name — `Bash`, `Read`, `Edit`, … */
	tool: string;
	/** The argument, as the engine emitted it: JSON text, cut by the runner at 160 chars. */
	input: string;
	/**
	 * The result text, or `null` when none had come back yet.
	 *
	 * `null` is a live state, not a missing value: a snapshot taken mid-call shows the call without
	 * its result, and the NEXT snapshot shows both. See {@link toolCallsForSnapshot} for why that is
	 * also what makes the cursor safe.
	 */
	output: string | null;
	/** The runner's 160-char input cap fired — the argument shown is not the whole one. */
	inputCut?: true;
	/** The runner's 240-char result cap fired. */
	outputCut?: true;
}

/**
 * Read the tool calls out of one terminal snapshot.
 *
 * Line-based and total: a line that is not a call or a result is ignored, and a result with no call
 * before it is dropped. Both are expected rather than exceptional — a stored row is `pane.slice(-8000)`
 * (`terminal-snapshot.ts:61`), a RAW character cut, so the first line of every long snapshot is a
 * fragment. A fragment does not carry the `⚙` marker, so it parses to nothing, which is the
 * conservative direction: a half-read argument is never reported as a whole one.
 */
export function parseEngineToolCalls(pane: string): EngineToolCall[] {
	const out: EngineToolCall[] = [];
	for (const raw of String(pane ?? "").split("\n")) {
		if (raw.startsWith(CALL_MARK)) {
			const rest = raw.slice(CALL_MARK.length);
			const sp = rest.indexOf(" ");
			const tool = (sp < 0 ? rest : rest.slice(0, sp)).trim();
			if (!tool) continue;
			const input = sp < 0 ? "" : rest.slice(sp + 1).trim();
			const call: EngineToolCall = { tool, input, output: null };
			// The ellipsis is the runner's own cut marker (`shortInput`), not ours. Reporting it as a
			// flag rather than leaving the character in place is what lets a reader tell "the argument
			// was this" from "the argument started like this".
			if (input.endsWith("…")) call.inputCut = true;
			out.push(call);
			continue;
		}
		const line = raw.trimStart();
		if (!line.startsWith(RESULT_MARK)) continue;
		// A result belongs to the call immediately above it and to nothing else — the engine emits
		// them paired and in order. An already-answered call is left alone rather than overwritten,
		// so a stray marker inside a result's own text cannot rewrite history.
		const last = out[out.length - 1];
		if (!last || last.output !== null) continue;
		const text = line.slice(RESULT_MARK.length).trim();
		last.output = text;
		if (text.endsWith("…")) last.outputCut = true;
	}
	return out;
}

/** Two calls are the same occurrence when their name, argument and result all match. */
function sameCall(a: EngineToolCall, b: EngineToolCall): boolean {
	return a.tool === b.tool && a.input === b.input && a.output === b.output;
}

export interface SnapshotToolCalls {
	/** The calls this snapshot adds that the previous one had not already delivered. */
	calls: EngineToolCall[];
	/** Carry this into the next snapshot's call. `null` when nothing settled yet. */
	anchor: EngineToolCall | null;
	/**
	 * Continuity with the previous snapshot could not be established.
	 *
	 * The engine did more than one snapshot's worth of work between two rows, so the anchor had
	 * scrolled out of the 8,000-char window. Some of these calls may repeat and some that happened
	 * are not in this record at all. Measured at **35 of 86 rows** on the sampled session, which is
	 * exactly why it is reported rather than assumed away.
	 */
	gap?: true;
}

/**
 * The calls a snapshot adds, given the one before it — the cursor property, at call granularity.
 *
 * ── Why de-duplication is not optional
 *
 * Consecutive `terminal` rows are tails of ONE growing transcript, so they overlap heavily —
 * `coding-timeline.ts:372` states it and production confirms it: on the sampled 86-row session,
 * **1,036 parsed call lines reduce to 610 occurrences, 41.1% duplication**. Emitting the raw parse
 * would hand a poller the same twelve calls every three seconds and break, at call granularity,
 * exactly the "never re-delivers or skips" property #581 AC2 established for events.
 *
 * ── Why the anchor must be a SETTLED call
 *
 * The obvious anchor is "the last call of the previous snapshot", and it is wrong. That call is
 * usually the one still in flight — recorded with `output: null` because its result had not come
 * back — and anchoring on the call's IDENTITY would mark it delivered, so the result, when it
 * arrived one snapshot later, would never reach the reader. The very tool call a live watcher most
 * wants is the one this would silently drop.
 *
 * So the anchor is the last call that HAS a result, and the in-flight call is re-emitted next time
 * with its answer. That costs at most one repeated call per poll and buys the guarantee that every
 * result is delivered exactly once it exists.
 *
 * The anchor is matched at its LAST occurrence, not its first: a genuinely repeated command (`git
 * status` twice) is two occurrences, and resuming from the first would replay the second.
 */
export function toolCallsForSnapshot(pane: string, anchor: EngineToolCall | null): SnapshotToolCalls {
	const cur = parseEngineToolCalls(pane);
	// A snapshot with no calls (a bare prompt line) says nothing about continuity, so it must not
	// clear the anchor — doing so would report a gap on the next row that carries one.
	if (!cur.length) return { calls: [], anchor };
	const settled = [...cur].reverse().find((c) => c.output !== null) ?? anchor;
	if (!anchor) return { calls: cur, anchor: settled };
	let at = -1;
	for (let i = cur.length - 1; i >= 0; i--) {
		if (sameCall(cur[i], anchor)) {
			at = i;
			break;
		}
	}
	if (at < 0) return { calls: cur, anchor: settled, gap: true };
	return { calls: cur.slice(at + 1), anchor: settled };
}

/**
 * Keep the NEWEST calls that fit a byte budget, and say how many were dropped.
 *
 * Newest rather than oldest for the same reason a `terminal` row keeps its TAIL: the live end of
 * the pane is the part a watcher is asking about. The count of what was dropped is returned rather
 * than implied, following this feed's standing rule that a reader is never told a truncation was
 * the whole thing.
 *
 * Measured on `JSON.stringify` of the call itself, so escaping and multi-byte characters are inside
 * the measurement — the #569 lesson, applied at the row level as well as the page level.
 */
export function capToolCalls(calls: EngineToolCall[], budgetBytes: number): { calls: EngineToolCall[]; omitted: number } {
	const encoder = new TextEncoder();
	const kept: EngineToolCall[] = [];
	let bytes = 0;
	for (let i = calls.length - 1; i >= 0; i--) {
		const cost = encoder.encode(JSON.stringify(calls[i])).length + 1;
		if (kept.length > 0 && bytes + cost > budgetBytes) break;
		bytes += cost;
		kept.unshift(calls[i]);
	}
	return { calls: kept, omitted: calls.length - kept.length };
}
