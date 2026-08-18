/**
 * Two things the Pilot cannot work out for itself: that it is repeating, and that it is blind (#522).
 *
 * Pure, so both are decided over recorded data rather than over a live run. Extracted rather than
 * added to coding-loop.ts because that file already carries the loop; this is the arithmetic the
 * loop consults, and it is the half worth pinning with fixtures from real runs.
 *
 * ── The two production failures this is measured against
 *
 * CAUSE A — a refusal answered by repetition. Run 3c83b0e9: eight of fifteen steps were the same
 * instruction, escalating, and steps 12 and 13 carried a byte-identical ```bash block while their
 * prose moved. Step 10 said out loud "The CLI has been refusing to run the full E2E suite against
 * production" — to the engine — and steps 11-13 went straight back to it. `coding-loop.ts`'s prompt
 * rule ("if the CLI objects you may NOT simply repeat it", #505) was live for the second such run
 * and did not hold it. Prose is not a bound.
 *
 * CAUSE B — an instruction the engine ANSWERED, which the Pilot could not see. Three escalating
 * "show me the full contents of this file" steps while the capture shows the engine complying every
 * time.
 *
 * CORRECTION (#700). This paragraph used to attribute B to {@link PILOT_PANE_CHARS}: "the Pilot
 * reads 6,000 characters of terminal while instructing a dump of roughly twice that, so its own
 * instruction is unverifiable by construction". That is the wrong limit, and a later run is the
 * disproof — the dump was never in the pane at all, in any form, truncated or otherwise.
 *
 * The BINDING limit was in the runner, not here: `toolResult()` in
 * `packages/browser-runner/src/coding/headless.ts` cut every `tool_result` to **240 characters**
 * and collapsed `\s+` to a single space, before the pane was ever assembled. Measured across 20
 * sessions of one instance, 150 of 251 stored tool-result lines (59.8%) hit that cap — 102 `Bash`,
 * 43 `Read` — with a maximum line length of 246 (`"  ↳✓ "` + 240). Because the cap was applied to
 * the RESULT and not to the request, `cat`, `sed -n '1,50p'`, `head -60` and `grep` produced
 * byte-identical size and shape, so no rephrasing could widen it. The run that filed #700 spent
 * twelve of its sixteen decisions on exactly that empty search space.
 *
 * That half is now fixed at its source: `packages/browser-runner/src/coding/transcript-lines.ts`
 * keeps line structure and caps per tool — 1,500 characters over 60 lines for `Read`/`Bash`/`Grep`
 * and their kin, 240 for status-string tools — and a cut states its own figures. **But only from
 * `RESULT_LINES_MIN_CLI` on**: a machine that has not upgraded still cuts at 240 on one line, and
 * the cloud cannot tell which machine it is talking to. That is why the prompt states the mechanism
 * (a cut result says it was cut, and by how much) instead of a number, and why every reader here
 * must keep tolerating a short, structureless result.
 *
 * {@link PILOT_PANE_CHARS} is the SECONDARY limit: real, and the reason a long narrative scrolls
 * away, but not the one that stopped a file arriving. It is also what BOUNDS the new cap — 1,500 is
 * a quarter of it, so four consecutive content results coexist with the framing rather than
 * evicting it, which is the trade a flat raise would have lost. The channel that is wide enough
 * regardless is the engine's own assistant text, which `headless.ts` pushes to the transcript
 * untruncated — pinned by "how much of a file reaches the pane (#700)" in `headless.test.ts`, which
 * measures both routes against the same ~4,000-character file.
 *
 * {@link repetitionVerdict} bounds A (and any repeat whose payload recurs). It does NOT catch B as
 * observed: those instructions are paraphrases, not repeats, and no honest normalisation of our own
 * prose unifies "read the full contents of X and Y" with "show me the full contents of X — all 366
 * lines". B is addressed at its cause instead: {@link renderPaneForPilot} states the measurement,
 * and the prompt states the bound that actually binds.
 */

/**
 * How much of the terminal one Pilot decision reads.
 *
 * Was an inline `pane.slice(-6000)` in `decideCodingAction`. It is a constant with a consequence —
 * it is the exact size of the Pilot's blind spot — so it is named, exported, and stated to the
 * Pilot in its own prompt rather than being a number only the code knows.
 */
export const PILOT_PANE_CHARS = 6000;

/**
 * How many instructions back a repeat still counts as a repeat.
 *
 * A NAIVE consecutive-equality counter is wrong, and the evidence says so: session csess_e80b6a21
 * ran 26 steps correctly with steps 13, 21 and 23 carrying the same `gh issue list` instruction —
 * it re-listed the GitHub backlog between finishing one issue and starting the next, and the steps
 * in between each did real work off the answer. A whole-run count kills that run at step 21. Nor
 * does "reset on any differently-keyed instruction" work: the stuck run's repeats are separated by
 * one, and then several, differently-worded attempts at the same thing, so a reset never fires.
 *
 * What separates them is DENSITY, not equality and not adjacency. Three sends of one command in a
 * short stretch of instructions is a stall; three sends spread across a longer stretch with other
 * work in between is a loop body. The two runs, at the resolution the surviving records support:
 *
 *     stuck   (3c83b0e9)  same command at steps 6, 12, 13   -> third one 8 instructions after the first
 *     healthy (e80b6a21)  same command at steps 13, 21, 23  -> third one 11 after the first, 8 after the second
 *
 * Stopping the stuck run at step 13 needs a window of at least 8; sparing the healthy run at step
 * 23 needs at most 10. So the band is [8, 10] — a band, not a knife edge — and 8 is its low end,
 * which is the one that stops the stall soonest and warns the healthy run least (once, at step 23).
 *
 * The step numbers are as good as the record gets, and that is worth saying: `coding_timeline`
 * holds every instruction verbatim, but the only reachable copy is the 120-character prefix
 * `describe()` posts to chat. Steps 6, 12 and 13 are the occurrences that prefix and the issue's
 * own byte-comparison establish. Steps 4 and 8 read as though they carry the same fenced command
 * too; if they do, this bound fires at step 8 instead, which is strictly better. The constant is
 * chosen so the case that is PROVEN is caught, and the unprovable extra only makes it earlier.
 */
export const REPEAT_WINDOW = 8;

/** Occurrences in the window (including the one being decided) that earn a warning in the step log. */
export const REPEAT_NOTE_AT = 2;

/**
 * Occurrences in the window that end the run.
 *
 * Three, matching MAX_REFUSALS and MAX_EMPTY_INSTRUCTIONS in coding-loop.ts: enough for the brain
 * to genuinely change course after reading the warning in its own step log, small enough that a
 * false positive costs a stopped run with a clear reason rather than a long silent one.
 */
export const REPEAT_STOP_AT = 3;

/**
 * The part of an instruction that identifies it.
 *
 * Prefers the fenced code block when there is one, because that is the part that actually executes
 * and it is exactly what was byte-identical in run 3c83b0e9's steps 12 and 13 while the prose around
 * it escalated. Whitespace is normalised; nothing else is. Case is preserved (`E2E_FULL=1` is not
 * `e2e_full=1`) and no fuzzy similarity is computed — the evidence in both traces is byte equality,
 * and a similarity threshold over the Pilot's own prose would collide "run the tests for module A"
 * with "run the tests for module B", which is two pieces of real work.
 */
export function instructionKey(text: string): string {
	const fenced: string[] = [];
	for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) fenced.push(m[1] ?? "");
	const joined = normalise(fenced.join("\n"));
	return joined || normalise(text);
}

function normalise(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

export interface RepetitionVerdict {
	/** Occurrences of this key inside the window, counting the one being decided. */
	occurrences: number;
	/** 1-based instruction ordinals of the earlier occurrences inside the window. */
	priorSteps: number[];
	verdict: "ok" | "note" | "stop";
}

/**
 * Judge one candidate instruction against the ones this run has already sent.
 *
 * `sentKeys` is every key ACTUALLY driven into the engine, in order — refused and empty
 * instructions are not in it, because they never happened as far as the engine is concerned.
 */
export function repetitionVerdict(sentKeys: readonly string[], key: string): RepetitionVerdict {
	const from = Math.max(0, sentKeys.length - (REPEAT_WINDOW - 1));
	const priorSteps: number[] = [];
	for (let i = from; i < sentKeys.length; i++) if (sentKeys[i] === key) priorSteps.push(i + 1);
	const occurrences = priorSteps.length + 1;
	const verdict = occurrences >= REPEAT_STOP_AT ? "stop" : occurrences >= REPEAT_NOTE_AT ? "note" : "ok";
	return { occurrences, priorSteps, verdict };
}

/**
 * What the brain is told about a repeat, in the step log it already reads back.
 *
 * Fed through `actionLog` exactly as a merge refusal and an empty instruction are: the loop already
 * talks to itself through that log and the brain demonstrably reacts to it.
 *
 * Every clause is a fact. It does NOT say the engine failed to answer — in the healthy backlog-relist
 * run the engine answered fine — and it does not say a repeat is pointless, because re-reading a
 * changing list is not. It states the count, the consequence, and the two moves that are available
 * under either cause.
 */
export function repeatNote(v: RepetitionVerdict): string {
	const where = v.priorSteps.length === 1 ? `step ${v.priorSteps[0]}` : `steps ${v.priorSteps.join(", ")}`;
	return [
		`repeat: you have now sent this exact instruction ${v.occurrences} times (also at ${where}).`,
		`A ${REPEAT_STOP_AT}rd close repeat ends the run.`,
		`If the CLI already answered it, use that answer — you only ever see the last ${PILOT_PANE_CHARS} characters of the terminal, and re-sending pushes the answer further out of that window.`,
		"If the CLI declined it, follow its recommendation or call request_human quoting the objection.",
	].join(" ");
}

/**
 * Why the run stopped, for the human the handoff wakes up.
 *
 * Names BOTH causes as alternatives rather than picking one. The loop cannot tell them apart —
 * distinguishing them means reading the engine's prose, which is the class of guess this codebase
 * refuses (see lib/runner-availability.ts) — and the human resolving the takeover can tell at a
 * glance which it is.
 */
export function repeatStopDetail(instruction: string): string {
	const head = normalise(instruction).slice(0, 160);
	return (
		`Stopped: the orchestrator sent the same instruction ${REPEAT_STOP_AT} times within ${REPEAT_WINDOW} steps — "${head}". ` +
		"Either the CLI is declining it, or it is being answered outside the part of the terminal the orchestrator can read. " +
		"Take a look at the session and tell it what to do."
	);
}

/**
 * What a `done` carries when the run repeated itself on the way there (#522, recommendation 3).
 *
 * Run 3c83b0e9 finished `done` with "All safely executable tests were run", which is TRUE and is
 * not what was asked; the five specs the owner wanted sat in a trailing note. The loop cannot
 * rewrite the brain's prose honestly, so it appends the one thing it measured itself — that an
 * instruction was repeated and the brain was told — and leaves the reader to check.
 */
export function repeatCaution(instruction: string): string {
	return (
		`(This run repeated one instruction and was warned about it: "${normalise(instruction).slice(0, 120)}". ` +
		"Check that the part of the objective that instruction was for actually happened.)"
	);
}

/**
 * The terminal as the Pilot should read it: the tail, plus what the tail is a tail OF.
 *
 * This is the whole of the CAUSE B fix. `pane.slice(-PILOT_PANE_CHARS)` handed the brain a string
 * that looks like a complete terminal, so an answer whose start had scrolled past read as an answer
 * that never came — and the only move that reading suggests is to ask again, which makes it worse.
 *
 * The numbers are measured from the pane the runner actually returned (`transcript.join("\n")`, the
 * whole session up to its own 3000-record trim), so the marker states a fact rather than an estimate.
 * Under the limit nothing is added and the Pilot's input is unchanged.
 */
export function renderPaneForPilot(pane: string, limit = PILOT_PANE_CHARS): string {
	if (pane.length <= limit) return pane;
	const hidden = pane.length - limit;
	return (
		`[${hidden.toLocaleString("en-US")} earlier characters of this terminal are NOT shown — you are reading the last ` +
		`${limit.toLocaleString("en-US")} of ${pane.length.toLocaleString("en-US")}. Output longer than that can never be read in full here, ` +
		// NOT "ask for a bounded slice" any more (#700): a narrower shell command changes nothing,
		// because the runner has already cut the tool result to 240 characters. Pointing at the
		// channel that does work keeps this banner from contradicting the system prompt above it.
		"and re-sending the instruction that produced it only pushes it further away. Ask the engine to put what you need in its REPLY instead.]\n" +
		pane.slice(-limit)
	);
}
