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
 *   4. its fidelity ceiling is the runner's own DISPLAY caps — 160 chars of input and, for a
 *      result, whatever `transcript-lines.ts` allowed that tool (#700: 1,500 chars over 60 lines
 *      for `Read`/`Bash`/`Grep`/…, 240 for the rest, 240 flat on an older machine) — which is a
 *      separate and much smaller decision than inventing a second record, and one this module
 *      reports rather than hides.
 *
 * ── Whether the call SUCCEEDED, and the three answers to it (#597)
 *
 * This module used to state that the outcome was unobtainable: `settleAct` read `block.is_error`
 * (`headless.ts:750`) and the transcript line was written without it, so the pane did not carry it.
 * The runner now welds the verdict onto the arrow — `↳✓` succeeded, `↳✗` failed — and it is read
 * from the character at a FIXED offset, never derived from the result text. Deriving is the guess
 * `describeEngineAct` refuses on the same data, and it stays refused.
 *
 * So {@link EngineToolCall.ok} has exactly three states and they are three different claims:
 *
 *   · `true` / `false` — the engine's own verdict, as the runner recorded it.
 *   · `null` — **not observed.** The call had no result yet (`output: null`, a real and live state:
 *     the snapshot was taken mid-call and the next one carries both), OR the row was written by a
 *     runner predating the marker, which is most rows already in D1 and every row from a machine
 *     that has not upgraded.
 *
 * `null` is emitted EXPLICITLY rather than omitted, and that is the point of the field. #594's
 * supervision legend tells a model that `ok: null` "was not observed to succeed" — a reader told to
 * check a key that is simply absent reads absence as *fine*, which inverts the default for exactly
 * the calls whose outcome is unknown. An old-runner row must not read as a pass.
 *
 * ── Only the structured engine has this record at all
 *
 * `⚙`/`↳` framing exists solely on the `stream-json` path (Claude Code). A Codex/Grok session is a
 * raw spawn whose stdout is captured verbatim, so it yields zero calls — the same "not observed,
 * never nothing happened" rule `takeActs` states for a raw engine.
 */

/** The line prefix `headless.ts` writes for a `tool_use` block. */
const CALL_MARK = "⚙ ";
/**
 * The arrow `headless.ts` writes for the matching `tool_result`, WITHOUT the character after it.
 *
 * What follows the arrow is the outcome (#597): `✓`, `✗`, or — from any runner predating the
 * marker — the space this constant used to include. Mirrors `toolResultMark` in
 * `packages/browser-runner/src/coding/engine-acts.ts`; the two are separate declarations because a
 * Worker must not import the runner's Node package (see `lib/engine-acts.ts`), so they are pinned
 * by the fixtures below rather than by a shared constant.
 */
const RESULT_ARROW = "↳";
/** The runner's marker for a call the engine reported as successful. */
const OK_MARK = "✓";
/** The runner's marker for a call the engine reported as failed (`is_error: true`). */
const FAIL_MARK = "✗";
/**
 * The prefix a result's SECOND and later lines carry, from {@link RESULT_LINES_MIN_CLI} on (#700).
 *
 * A result used to be one line by construction — the runner collapsed `\s+` to a single space
 * before writing it — so `output` and "the arrow line" were the same thing. Now that line structure
 * survives, reading only the arrow line would report the first line of a 40-line file read as the
 * whole result, which is a smaller lie than the old one but still a lie. Mirrors
 * `RESULT_CONT_PREFIX` in `packages/browser-runner/src/coding/transcript-lines.ts`; separate
 * declarations for the same reason {@link RESULT_ARROW} is one, pinned by the fixtures below.
 */
const CONT_MARK = "  │ ";
/**
 * The runner's cut markers: a bare ellipsis from any runner, optionally followed by the figures the
 * current one states. Anchored at the end, so an ellipsis inside a result's own prose is not a cut.
 */
const RESULT_CUT = /…(\[cut: [\d,]+ of [\d,]+ chars\])?$/;

/**
 * The CLI release that first writes the outcome marker (#597).
 *
 * Named rather than "update the CLI", the pattern `TURN_REPORT_MIN_CLI`, `SWITCH_BRANCH_MIN_CLI`
 * and `REPO_SEARCH_MIN_CLI` set — a version without a number is one somebody has to go and find.
 * Nothing gates on it: the marker is read per LINE, out of panes already stored, so a row is judged
 * by what it contains rather than by what its machine claimed at the time. This is the number to
 * quote when someone asks why every `ok` on their machine is `null`.
 */
export const TOOL_OUTCOME_MIN_CLI = "0.4.52";

/**
 * The CLI release that first keeps a result's line structure and caps it per tool (#700).
 *
 * Nothing gates on it either — {@link CONT_MARK} is read per line, so a pane is judged by what it
 * contains and an older machine's single-line results parse exactly as they always did. This is the
 * number to quote when someone asks why their `Read` results are still 240 characters on one line.
 */
export const RESULT_LINES_MIN_CLI = "0.4.55";

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
	/**
	 * Whether the engine reported the call as succeeding — `null` when it was NOT OBSERVED (#597).
	 *
	 * Never omitted, and never guessed from the result text. `null` covers both a call still in
	 * flight and a snapshot written by a runner older than the marker; see the header for why
	 * absence would read as success and must not.
	 */
	ok: boolean | null;
	/** The runner's 160-char input cap fired — the argument shown is not the whole one. */
	inputCut?: true;
	/**
	 * The runner's result cap fired — the output shown is a head, not the whole of it.
	 *
	 * The cap is per tool since #700 (1,500 characters for `Read`/`Bash`/`Grep`/…, 240 for
	 * everything else) and 240 flat on any runner below {@link RESULT_LINES_MIN_CLI}, so this flag
	 * says THAT it was cut and never how much was lost. A current runner puts the figures in the
	 * text itself.
	 */
	outputCut?: true;
}

/**
 * Read the tool calls out of one terminal snapshot.
 *
 * Line-based and total: a line that is not a call, a result or a result's continuation is ignored,
 * and a result with no call before it is dropped. Both are expected rather than exceptional — a
 * stored row is `pane.slice(-8000)` (`terminal-snapshot.ts:61`), a RAW character cut, so the first
 * line of every long snapshot is a fragment. A fragment does not carry the `⚙` marker, so it parses
 * to nothing, which is the conservative direction: a half-read argument is never reported as a whole
 * one. A continuation whose own arrow line was cut away is dropped for the same reason — it would
 * otherwise attach a stranded tail to whatever call happened to precede it.
 */
export function parseEngineToolCalls(pane: string): EngineToolCall[] {
	const out: EngineToolCall[] = [];
	// Whether the PREVIOUS line was this result's own, which is what makes a `│` line safe to
	// append: a continuation is only ever read as one when it directly follows the result it
	// belongs to, never after arbitrary narrative that happens to start with the same character.
	let inResult = false;
	for (const raw of String(pane ?? "").split("\n")) {
		if (raw.startsWith(CONT_MARK)) {
			const last = out[out.length - 1];
			if (inResult && last && last.output !== null) last.output = `${last.output}\n${raw.slice(CONT_MARK.length)}`;
			continue;
		}
		if (raw.startsWith(CALL_MARK)) {
			inResult = false;
			const rest = raw.slice(CALL_MARK.length);
			const sp = rest.indexOf(" ");
			const tool = (sp < 0 ? rest : rest.slice(0, sp)).trim();
			if (!tool) continue;
			const input = sp < 0 ? "" : rest.slice(sp + 1).trim();
			const call: EngineToolCall = { tool, input, output: null, ok: null };
			// The ellipsis is the runner's own cut marker (`shortInput`), not ours. Reporting it as a
			// flag rather than leaving the character in place is what lets a reader tell "the argument
			// was this" from "the argument started like this".
			if (input.endsWith("…")) call.inputCut = true;
			out.push(call);
			continue;
		}
		inResult = false;
		const line = raw.trimStart();
		if (!line.startsWith(RESULT_ARROW)) continue;
		// The character AFTER the arrow is the outcome, and its position is what makes the reading
		// unambiguous (#597): a runner predating the marker always wrote a space there, so an old
		// row is `null` — not observed — however its own output happens to begin. Anything else
		// (`↳foo`) is not a runner result line at all and is left alone.
		const after = line.slice(RESULT_ARROW.length);
		const marked = after.startsWith(OK_MARK) ? true : after.startsWith(FAIL_MARK) ? false : null;
		if (marked === null && !after.startsWith(" ")) continue;
		// A result belongs to the call immediately above it and to nothing else — the engine emits
		// them paired and in order. An already-answered call is left alone rather than overwritten,
		// so a stray marker inside a result's own text cannot rewrite history.
		const last = out[out.length - 1];
		if (!last || last.output !== null) continue;
		last.output = after.slice(marked === null ? 0 : marked ? OK_MARK.length : FAIL_MARK.length).trim();
		last.ok = marked;
		inResult = true;
	}
	// After the loop, because a cut is marked on the LAST line of a result and a result may now be
	// many lines long (#700). Both shapes count: a bare `…` from any runner, and the current
	// runner's `…[cut: 1,500 of 18,432 chars]`, which says how much more there was.
	for (const call of out) if (call.output !== null && RESULT_CUT.test(call.output)) call.outputCut = true;
	return out;
}

/**
 * Two calls are the same occurrence when their name, argument, result and outcome all match.
 *
 * The outcome joined the comparison with #597. It cannot make a genuine match miss: consecutive
 * snapshots are tails of ONE append-only transcript, so a line — marker included — is byte-identical
 * in every snapshot that still holds it, and a runner upgrade starts a new process and a new
 * transcript rather than rewriting an old line. What it buys is that a repeated command whose two
 * runs DIFFERED — `npm test` failing then passing, identical text on both sides of `↳` — is two
 * occurrences, which is precisely the case the anchor must not collapse.
 */
function sameCall(a: EngineToolCall, b: EngineToolCall): boolean {
	return a.tool === b.tool && a.input === b.input && a.output === b.output && a.ok === b.ok;
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
