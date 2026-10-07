/**
 * The line WINDOW a repo file read returns, and the header that discloses it (#534).
 *
 * ── What was wrong
 *
 * `repo_read_file` asked the runner for 8KB and its schema was `path` only, so once a file passed
 * 8KB **its remainder was unreachable through the tool by any argument the model could pass**. Live,
 * on the owner's Heartfull Repo Coder: "the rules file was truncated at 8192 bytes and the
 * `eventCalls` rule is at line 511 — well past the cut-off". It recovered by using `repo_grep` to
 * locate `firestore.rules:511`, which is a search tool doing a read tool's job, on every large file,
 * every time. Measured on this repo, 36.9% of 1,366 text files are over 8KB.
 *
 * ── Lines, not bytes
 *
 * Every tool in the field with a range primitive addresses LINES (Claude Code, Gemini CLI, Cline,
 * Continue, Cursor, Windsurf, Lovable, Anthropic's own text-editor tool); not one uses a byte
 * offset. Three reasons, in order of force:
 *
 *   1. It composes with search. `repo_grep` already answers in `path:line` — a grep hit plus a line
 *      range is one thought, a grep hit plus a byte offset is arithmetic nobody has the input for.
 *   2. It is the model's own vocabulary: the sentence that produced this ticket says "line 511".
 *   3. A byte boundary is not a safe boundary — `buf.subarray(0, cap).toString("utf-8")` in the
 *      runner can split a multi-byte code point and emit U+FFFD at the cut.
 *
 * `startLine`/`endLine`, 1-based inclusive, over `offset`/`limit`: the half of the field that reads
 * straight off a `repo_grep` hit with no arithmetic.
 *
 * ── The disclosure is a HEADER, deliberately
 *
 * `capToolResult` (lib/tool-result-cap.ts) keeps the HEAD of an oversized tool result. The note this
 * replaces sat at the TAIL (`… (truncated at 8192 bytes of 53000)`), so the notice explaining the cut
 * is the first thing a second cut would remove. Harmless while 8KB could never reach 24,000 chars,
 * and a landmine the moment the window is widened — which is exactly what this change does. So
 * everything the model needs in order to ask again (which lines it got, how many there are, the
 * literal next call) goes ABOVE the body, and only a short reminder is repeated below it.
 *
 * Keeping the cut DISCLOSED at all is the constraint from #534: the agent noticed it had been cut,
 * which is the only reason it recovered. That behaviour has to survive, and it is now stated in
 * numbers the model can act on rather than a byte count it cannot.
 */
import type { RegistryToolResult } from "./connectors/types.js";

/**
 * The window's character budget — counted on the RENDERED text (line numbers included), so the
 * result cannot exceed it by the width of the prefixes.
 *
 * 20,000 is chosen to sit under `TOOL_RESULT_MAX_CHARS = 24_000` (lib/tool-result-cap.ts) with room
 * for the header: above that seam `agent-think.ts` head-cuts the result and replaces this file's
 * exact "lines X–Y of N, next call startLine=…" with its own generic notice. The whole point of the
 * header is that the disclosure is precise and belongs to the tool, so it must fit.
 */
export const READ_MAX_CHARS = 20_000;

/**
 * The window's line budget. The field's convergent number — Cline `MAX_READ_LINES = 2_000`, Gemini
 * CLI `DEFAULT_MAX_LINES_TEXT_FILE = 2000`. At this repo's median 46 bytes/line the CHARACTER budget
 * binds first (~430 lines); this one only bites on files of very short lines, which is its job.
 */
export const READ_MAX_LINES = 2_000;

/**
 * The per-line cap. Same number and same reason in both open-source implementations — Cline's
 * comment is "defangs minified files". Without it a single 200KB bundle line spends the entire
 * budget and a "1-line" read returns nothing usable. Measured on this repo: exactly 2 of 1,366 text
 * files have any line over 2,000 characters, so it is invisible except where it is needed.
 */
export const MAX_LINE_CHARS = 2_000;

/**
 * What to ask the runner for.
 *
 * Equal to the runner's own `HARD_MAX_FILE_BYTES` (packages/browser-runner/src/coding/inspect.ts) —
 * ask for the most any runner will ever give and never more, because `readRepoFile` clamps with
 * `Math.min(maxBytes ?? DEFAULT, HARD_MAX)` and a larger number is silently the same request.
 *
 * Since #954 the runner also starts at `startLine`/`startColumn`, so this is a cap on one FETCH, not
 * on how far into a file a read can reach. A runner that does is detected by the `firstLine` it
 * reports; an older one ignores the range, starts at the top, and is told to update (runner_update).
 * Up to 128KB still crosses the relay for a window of 20,000 characters — the slicing is here.
 */
export const READ_FETCH_BYTES = 128 * 1024;

/** What `/coding/read-file` answers — `firstLine`/`totalLines` only from a runner that honours the range (#954). */
export interface RunnerFileRead {
	content?: string;
	binary?: boolean;
	truncated?: boolean;
	size?: number;
	firstLine?: number;
	totalLines?: number;
}

/**
 * The range to ask the runner for (#954): the window's first line and column. A value the renderer
 * would refuse or clamp is sent as-is — the runner clamps to line 1 — and the refusal is the renderer's.
 */
export function runnerRange(args: { startLine?: unknown; startColumn?: unknown }): { startLine?: number; startColumn?: number } {
	const line = parseLineArg(args.startLine);
	const column = parseLineArg(args.startColumn);
	return {
		...(line !== null && Number.isFinite(line) && line > 1 ? { startLine: line } : {}),
		...(column !== null && Number.isFinite(column) && column > 1 ? { startColumn: column } : {}),
	};
}

export interface RepoFileWindowInput {
	/** The path as the caller asked for it — quoted back in the header and the next-call hint. */
	path: string;
	/** What the runner returned: the file's first `READ_FETCH_BYTES`, decoded as UTF-8. */
	content: string;
	/** The runner's `truncated` — the FETCH stopped at the byte cap, so `content` is a prefix. */
	fetchTruncated?: boolean;
	/** The runner's `size` — the file's real length in bytes, whatever was fetched. */
	size?: number;
	startLine?: unknown;
	endLine?: unknown;
	/** Read the window's FIRST line from this 1-based column — the rest of a line too long to show (#954). */
	startColumn?: unknown;
	/**
	 * The line `content` begins at, as a runner that honours `startLine` reports it (#954). Absent
	 * means an older runner, whose `content` always begins at line 1 and stops at its byte cap.
	 */
	firstLine?: number;
	/** The whole file's line count — reported alongside `firstLine`. */
	totalLines?: number;
	/** Override the character budget (the Co-pilot's reader keeps its own, smaller one). */
	maxChars?: number;
	maxLines?: number;
	/**
	 * The literal call the model repeats to continue, minus `startLine` (#781). Default is this
	 * file's own reader, `repo_read_file path="…"`; a second reader over the same window — a
	 * GitHub Actions job log — names its own tool and arguments, or the hint sends the model to a
	 * tool that cannot reach what it just read.
	 */
	nextCall?: string;
	/**
	 * The sentence about jumping instead of paging. Default names `repo_grep`, which is the right
	 * advice for a file on a checkout and wrong for anything else; `""` omits it.
	 */
	jumpHint?: string;
}

/**
 * Where a window must START for it to run to the END of the text and still fit (#781).
 *
 * A log is read from its end — the failure is the last thing a job printed — while a file is
 * read from its start. The renderer only walks forwards, so this is the pure inverse: walk back
 * from the last line, spending the same budget the renderer will, and return the first line that
 * fits. `renderRepoFileWindow({startLine: tailWindowStart(lines)})` then shows exactly the tail.
 *
 * Takes the lines the renderer will see (split on `\n`, the empty element after a final newline
 * already dropped), and mirrors its per-line rendering — number prefix and the long-line cut —
 * so the two budgets agree.
 */
export function tailWindowStart(lines: readonly string[], maxChars = READ_MAX_CHARS, maxLines = READ_MAX_LINES): number {
	let used = 0;
	let count = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const text = lines[i] ?? "";
		const cut = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)} … [line truncated: it is ${num(text.length)} characters long]` : text;
		const rendered = `${i + 1}: ${cut}`;
		if (count >= maxLines || (count > 0 && used + rendered.length + 1 > maxChars)) return i + 2;
		used += rendered.length + 1;
		count++;
	}
	return 1;
}

/** `undefined`/absent → null; a real number → floored; anything else → NaN, which is refused. */
function parseLineArg(v: unknown): number | null {
	if (v === undefined || v === null || v === "") return null;
	const n = typeof v === "number" ? v : Number.parseInt(String(v).trim(), 10);
	return Number.isFinite(n) ? Math.floor(n) : Number.NaN;
}

const num = (n: number): string => n.toLocaleString("en-US");

/**
 * Render one window of a file, with its disclosure above it. Pure — no runner, no env — so every
 * boundary below can be asserted directly, including what survives `capToolResult`.
 */
export function renderRepoFileWindow(input: RepoFileWindowInput): RegistryToolResult {
	const { path } = input;
	const maxChars = input.maxChars ?? READ_MAX_CHARS;
	const maxLines = input.maxLines ?? READ_MAX_LINES;
	const nextCall = input.nextCall ?? `repo_read_file path="${path}"`;
	const jumpHint = input.jumpHint ?? " To jump straight to something instead of paging, use repo_grep and read a window around the line it reports.";
	const fetchTruncated = Boolean(input.fetchTruncated);
	const raw = input.content ?? "";
	// A runner that honours the range (#954) says where its bytes begin and how long the file is, so
	// every line is reachable. An older one always starts at line 1 and stops at its byte cap.
	const ranged = typeof input.firstLine === "number";
	const base = ranged ? (input.firstLine as number) : 1;
	const fileLines = ranged ? (input.totalLines ?? 0) : null;

	// An empty file is an answer, not a failure — and saying so plainly stops a model reading the
	// blank result as "the read failed" and trying three more spellings of the path.
	// Entirely our own sentence about an empty file — `head` with no body, so nothing is fenced.
	if (ranged ? fileLines === 0 : raw === "") return { head: `--- ${path} — this file is empty (0 lines) ---`, content: "", success: true };

	const start = parseLineArg(input.startLine);
	const end = parseLineArg(input.endLine);
	const column = parseLineArg(input.startColumn);
	if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(column)) {
		return { content: "`startLine`, `endLine` and `startColumn` must be whole numbers, 1-based (e.g. startLine=480, endLine=540).", success: false };
	}
	const fromColumn = column !== null && column > 1 ? column : 1;
	if (fromColumn > 1 && !ranged) {
		return { content: "Reading from a `startColumn` needs a newer `pags` CLI on this machine than the one connected. Call runner_update for this machine, then read again.", success: false };
	}

	const lines = raw.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	if (raw.endsWith("\n")) {
		// The empty element after a file's final newline is not a line.
		lines.pop();
	} else if (fetchTruncated && lines.length > 1) {
		// A byte cap stops mid-line. Showing that fragment as if it were a whole line is the small
		// dishonesty this whole change is against; the next window starts on that line instead.
		lines.pop();
	}
	/** The last line number this fetch holds — not the file's last line when the fetch was cut. */
	const available = base + lines.length - 1;
	/** The last line the model could ask for next: the whole file on a ranged runner. */
	const reachable = fileLines ?? available;

	const notes: string[] = [];
	let from = start ?? 1;
	if (from < 1) {
		// Clamped, and SAID — #508's lesson: a bound applied silently is one the model keeps
		// tripping over, because from its side nothing happened.
		notes.push(`(\`startLine\` ${num(from)} is not a line number — the first line of a file is 1, and that is where this window starts.)`);
		from = 1;
	}
	if (end !== null && end < from) {
		return { content: `\`endLine\` ${num(end)} is before \`startLine\` ${num(from)} — a range reads forwards. Ask for startLine=${num(end)} and endLine=${num(from)} if that is what you meant.`, success: false };
	}
	if (from > available || from < base || (fileLines !== null && from > fileLines)) {
		// Refuse with the number, rather than return an empty window that reads like "this part of
		// the file is blank".
		const reach = ranged
			? `${path} has ${num(fileLines ?? 0)} lines`
			: fetchTruncated
				? `this machine's \`pags\` CLI reads only the first ${num(READ_FETCH_BYTES)} bytes of the file's ${num(input.size ?? 0)}, which is ${num(available)} lines — call runner_update for this machine and it reads any part of a file`
				: `${path} has ${num(available)} lines`;
		return { content: `\`startLine\` ${num(from)} is past the end of what this tool can read: ${reach}. Ask for a startLine within that${input.jumpHint === undefined ? ", or use repo_grep to find the line you actually want" : ""}.`, success: false };
	}

	const wantedTo = end === null ? available : Math.min(end, available);
	const body: string[] = [];
	let used = 0;
	let budgetBound = false;
	for (let n = from; n <= wantedTo; n++) {
		let text = lines[n - base] ?? "";
		// The window's first line, read from a column, is the rest of a line too long to have been
		// shown — so it gets the window's budget rather than the per-line cap, or a 200KB line would
		// take a hundred reads.
		const col = n === from ? fromColumn : 1;
		const lineCap = col > 1 ? Math.max(MAX_LINE_CHARS, maxChars - 200) : MAX_LINE_CHARS;
		if (text.length > lineCap) {
			const partial = fetchTruncated && n === available && lines.length === 1;
			const length = col - 1 + text.length;
			// Only a ranged runner can resume mid-line; anything else (a job log) keeps the plain marker,
			// which `tailWindowStart` mirrors.
			const resume = ranged ? ` — read on with ${nextCall} startLine=${n} startColumn=${col + lineCap}` : "";
			text = `${text.slice(0, lineCap)} … [line truncated: it is ${partial ? "at least " : ""}${num(length)} characters long${resume}]`;
		}
		const rendered = `${n}: ${col > 1 ? `[from column ${num(col)}] ` : ""}${text}`;
		if (body.length >= maxLines || (body.length > 0 && used + rendered.length + 1 > maxChars)) {
			budgetBound = true;
			break;
		}
		body.push(rendered);
		used += rendered.length + 1;
	}
	const shownTo = from + body.length - 1;

	const whole = from === 1 && fromColumn === 1 && shownTo === reachable && (ranged || !fetchTruncated);
	const total = ranged || !fetchTruncated ? num(reachable) : `at least ${num(available)}`;
	const head = `--- ${path} — lines ${num(from)}-${num(shownTo)} of ${total}${whole ? " (the whole file)" : ""} ---`;

	if (shownTo < reachable) {
		const why = budgetBound ? ` (this window holds about ${num(maxChars)} characters or ${num(maxLines)} lines, whichever comes first)` : "";
		notes.push(
			`This is a WINDOW, not the whole file: lines ${num(shownTo + 1)}-${num(reachable)} were NOT returned${why}.` +
				` To continue, call ${nextCall} startLine=${num(shownTo + 1)}.${jumpHint}`,
		);
	}
	if (fetchTruncated && !ranged) {
		const ofSize = typeof input.size === "number" && input.size > 0 ? ` of this file's ${num(input.size)}` : "";
		notes.push(
			`This machine's runner stopped reading at its own byte cap${ofSize}, so lines past ${num(available)} cannot be reached until its \`pags\` CLI is updated (runner_update) — until then use repo_grep to find the line you need. Do NOT state or imply that the file ends here.`,
		);
	}

	const tail = shownTo < reachable ? `(continues — ${nextCall} startLine=${num(shownTo + 1)})` : "";
	// The disclosure and the continuation reminder are the PLATFORM's, and the file's lines are not.
	// Returned as `head`/`content`/`tail` so `runRegistryTool` can fence the middle and leave ours
	// outside it (#752, ADR 0006 F2) — a "call again with startLine=…" instruction inside a block
	// the model is told never to obey is worse than no instruction. The head keeps its position for
	// the reason this module already gives: `capToolResult` keeps the HEAD, so a note explaining a
	// cut must not be the first thing a second cut removes.
	return {
		head: `${head}${notes.length ? `\n${notes.join("\n")}` : ""}`,
		content: body.join("\n"),
		success: true,
		...(tail ? { tail } : {}),
	};
}
