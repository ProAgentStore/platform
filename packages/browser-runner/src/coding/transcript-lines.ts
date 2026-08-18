/**
 * How an engine event becomes a line in the pane — the runner's half of #700.
 *
 * ── The defect this file exists to remove
 *
 * `headless.ts` rendered every `tool_result` through a four-line helper that did two things before
 * the pane existed: it collapsed `\s+` to a single space, and it cut the text to 240 characters.
 * Both losses were total and neither was disclosed beyond a trailing ellipsis.
 *
 * The consequence is not "results are short". It is that **the shape of a result no longer depends
 * on the command that produced it.** `cat`, `sed -n '1,50p'`, `cat -n | head -60` and "print every
 * character" all arrive at the same size, on one line, with the indentation gone. A Pilot that
 * cannot see a file therefore has no move: every rephrasing it can reach is the same request with
 * the same bound. One live run spent twelve of its sixteen decisions searching that empty space and
 * concluded — reasonably, on the evidence in front of it — that "the CLI is summarizing file
 * contents". It was not; the evidence had been destroyed upstream.
 *
 * Measured across 20 sessions of one instance: **150 of 251 stored tool-result lines (59.8%) hit
 * the 240-character cap** — 102 `Bash`, 43 `Read` — with a maximum line length of 246. The cap was
 * the common case, and it fired hardest on `Read`, the tool whose entire job is returning file
 * contents.
 *
 * ── What replaces it, and what it costs
 *
 * Three changes, and the reason each is separate:
 *
 *  1. **Line structure survives.** Newlines are kept and continuation lines carry
 *     {@link RESULT_CONT_PREFIX}. This is the half that matters most and it costs almost nothing:
 *     `cat -n` output is unreadable as one space-joined line at ANY length, so the collapse made
 *     the cap worse than its size alone implies.
 *  2. **The cap is per tool** ({@link toolResultBudget}), not one number. A `Read` result is the
 *     case that needs room; an `Edit`'s "has been updated successfully" is a status string that was
 *     never near 240 anyway. Raising one number for everything would buy file text by spending the
 *     pane on results that carry none.
 *  3. **A cut states its own size** (`…[cut: 1,500 of 18,432 chars]`), so the reader learns there
 *     is more AND how much — which is what makes "ask for a slice that fits" a strategy rather than
 *     a guess. Same disclosure discipline as `repo_read_file`'s window header and `repo_git`'s
 *     TRUNCATED note on the cloud side.
 *
 * **The cost is real and it is the pane.** A `terminal` row stores the last 8,000 characters
 * (`TERMINAL_SNAPSHOT_CHARS`) and one Pilot decision reads the last 6,000 (`PILOT_PANE_CHARS`), so
 * every character bought for file text is bought by evicting history — including the `⚙`/`↳`
 * framing `engine-tool-calls.ts` parses back out and the engine-error lines #580 exists to keep
 * visible. {@link RESULT_CAP_CONTENT_CHARS} is therefore derived from that window rather than
 * chosen from it — see {@link RESULT_CAP_CONTENT_CHARS} and {@link RESULT_RENDERED_MAX}, which
 * state the content budget and what it actually costs the pane once framing is paid for.
 *
 * ── Old runners, and why nothing gates on a version
 *
 * A machine that has not upgraded keeps the 240-char single-line behaviour, so every cloud reader
 * must go on tolerating short, structureless results — `engine-tool-calls.ts` already models that
 * (`outputCut`) and continues to. Continuation lines are read by their PREFIX, not by a version
 * probe: a pane is judged by what it contains, the way the `↳✓` outcome marker is.
 */

/**
 * The prefix every line of a result after the first carries.
 *
 * It exists for two reasons and the second is the load-bearing one:
 *
 *  - the pane stays readable as a transcript rather than as an unindented dump, and
 *  - a result can no longer FORGE the framing. `parseEngineToolCalls` decides what a line is from
 *    its first characters, so a file containing a line that begins `⚙ ` or `↳` would, once
 *    newlines survived, parse as a tool call the engine never made. Every continuation line begins
 *    with this prefix instead, so a result's own text can never start a line that the parser reads
 *    as anything else.
 *
 * `│` (U+2502), not `|`: a markdown table in an engine's reply uses the ASCII pipe, and the point
 * of the character is that transcript prose does not use it.
 */
export const RESULT_CONT_PREFIX = "  │ ";

/**
 * How much of a CONTENT tool's result — its own characters, framing excluded — reaches the pane.
 *
 * Derived, not picked: the Pilot reads the last 6,000 characters of the pane
 * (`PILOT_PANE_CHARS`, `workers/api/src/lib/coding-repetition.ts`), and no single result may take
 * more than a QUARTER of that in content, which is ~35 lines of ordinary source — what a bounded
 * slice request actually asks for. What that costs the pane in full is {@link RESULT_RENDERED_MAX},
 * and it is the larger number, because framing is not free.
 *
 * The two constants are separate declarations in separate packages for the reason `RESULT_ARROW` is
 * (a Worker must not import the runner's Node package); the derivation is stated here so that
 * moving one without the other is at least a visible mistake.
 *
 * `used` and `total` in the cut notice are BOTH content characters, deliberately: the number is
 * only actionable if the model can compare it against the file it is asking for.
 */
export const RESULT_CAP_CONTENT_CHARS = 1500;

/**
 * A ceiling on LINES as well as characters, because the prefix is charged per line.
 *
 * A result of 1,500 one-character lines would pay {@link RESULT_CONT_PREFIX} 1,500 times — 6,000
 * characters of framing for 1,500 of content, i.e. the whole of the Pilot's window spent on
 * indentation. 60 lines bounds that overhead at 240 characters.
 */
export const RESULT_CAP_CONTENT_LINES = 60;

/** Every other tool keeps the historical 240 characters — see {@link CONTENT_TOOLS}. */
export const RESULT_CAP_DEFAULT_CHARS = 240;

/** …and at most six lines of it, so a status string cannot spend six prefixes to say nothing. */
export const RESULT_CAP_DEFAULT_LINES = 6;

/** The longest cut notice the renderer can emit — `…[cut: 999,999,999 of 999,999,999 chars]`. */
const CUT_NOTICE_MAX = 45;

/**
 * What the WHOLE result block can cost the pane, framing and disclosure included.
 *
 * Stated because the content budget alone is not the honest figure and pretending otherwise is how
 * a cap gets quietly exceeded: the arrow prefix, one `RESULT_CONT_PREFIX` and one newline per
 * continuation line, and the cut notice are all pane characters too. At the current numbers that is
 * ~1,840 — under a THIRD of the Pilot's 6,000-character window, so three consecutive content
 * results still coexist with the narrative and the `⚙`/`↳` framing rather than evicting them.
 *
 * If someone widens {@link RESULT_CAP_CONTENT_CHARS}, this is the number that says what it costs.
 */
export const RESULT_RENDERED_MAX =
	"  ↳✓ ".length + RESULT_CAP_CONTENT_CHARS + (RESULT_CAP_CONTENT_LINES - 1) * (RESULT_CONT_PREFIX.length + 1) + CUT_NOTICE_MAX;

/**
 * The tools whose RESULT is the answer, rather than a receipt for an action.
 *
 * `Read`/`Bash` are the two the measurement names (43 and 102 of the 150 truncated lines).
 * `Grep`/`Glob`/`BashOutput`/`NotebookRead` are here because their results are line-structured
 * listings — the same content, arriving through a different tool name — and a Pilot that asked for
 * a grep instead of a cat should not be punished for it.
 *
 * `Edit`, `Write`, `MultiEdit` and `TodoWrite` are deliberately absent: their results are status
 * strings ("has been updated successfully…", 176-214 characters in the sampled sessions) that the
 * old cap barely touched, so widening them would spend the pane and buy nothing.
 */
export const CONTENT_TOOLS = new Set(["Read", "Bash", "BashOutput", "Grep", "Glob", "NotebookRead"]);

/** The budget for one tool's result. An unknown or unnamed tool gets the conservative one. */
export function toolResultBudget(tool: string): { chars: number; lines: number } {
	return CONTENT_TOOLS.has(tool)
		? { chars: RESULT_CAP_CONTENT_CHARS, lines: RESULT_CAP_CONTENT_LINES }
		: { chars: RESULT_CAP_DEFAULT_CHARS, lines: RESULT_CAP_DEFAULT_LINES };
}

/** Strip ANSI/VT escape sequences so a raw CLI's coloured output reads as plain text. */
export function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape/control codes from terminal output.
	return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][AB0-2]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** Compact a tool_use input object to a single readable line. */
export function shortInput(input: unknown): string {
	if (input == null) return "";
	try {
		const s = typeof input === "string" ? input : JSON.stringify(input);
		return s.length > 160 ? `${s.slice(0, 160)}…` : s;
	} catch {
		return "";
	}
}

/** Render a tool_result's content (string, or array of `{type:text,text}`) to raw text. */
export function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	// Joined with a NEWLINE, not a space: separate content blocks are separate pieces of output,
	// and the whole point of this module is that the difference is preserved.
	return content
		.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
		.filter((t) => t !== "")
		.join("\n");
}

/**
 * Normalise a result's text to display lines: no CR, no escape codes, no trailing whitespace, and
 * no runs of blank lines. Every one of those is pane budget spent on nothing.
 */
function tidyLines(text: string): string[] {
	const out: string[] = [];
	for (const raw of stripAnsi(text.replace(/\r\n?/g, "\n")).split("\n")) {
		const line = raw.trimEnd();
		// Drop a leading blank, and collapse a run of blanks to one.
		if (!line && (out.length === 0 || out[out.length - 1] === "")) continue;
		out.push(line);
	}
	while (out.length && out[out.length - 1] === "") out.pop();
	return out;
}

/**
 * The full transcript entry for one `tool_result` — the arrow line plus any continuation lines.
 *
 * The head is cut rather than the tail, unchanged from the old helper: a file, a listing and a
 * grep all answer from their beginning, and a test run's tail is recoverable from the engine's own
 * reply text, which is never truncated. Changing that is a separate decision and is not made here.
 */
export function renderToolResult(mark: string, content: unknown, tool: string): string {
	const lines = tidyLines(toolResultText(content));
	const budget = toolResultBudget(tool);
	const total = lines.join("\n").length;

	const kept: string[] = [];
	let used = 0;
	let cut = false;
	for (const line of lines) {
		if (kept.length >= budget.lines) {
			cut = true;
			break;
		}
		const room = budget.chars - used;
		if (room <= 0) {
			cut = true;
			break;
		}
		if (line.length > room) {
			kept.push(line.slice(0, room));
			used += room;
			cut = true;
			break;
		}
		kept.push(line);
		used += line.length;
	}
	if (cut && kept.length) {
		// The figures, not just the ellipsis: "there was more" tells the reader to give up, "1,500
		// of 18,432" tells it how narrow a slice would arrive whole. The ellipsis stays because it
		// is what every runner ever written has used to mark a cut, and readers key on it.
		kept[kept.length - 1] = `${kept[kept.length - 1]}…[cut: ${used.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} chars]`;
	}

	const head = `  ↳${mark} ${kept[0] ?? ""}`.trimEnd();
	if (kept.length < 2) return head;
	return [head, ...kept.slice(1).map((l) => `${RESULT_CONT_PREFIX}${l}`)].join("\n");
}
