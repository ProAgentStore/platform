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
 * `maxBytes` is honoured by every runner already in the wild, which is what lets the whole of this
 * work cloud-side with no CLI release: the slicing happens here, on text the machine already sent.
 * The residual cost is real and stated rather than hidden — up to 128KB crosses the relay for a
 * window of 20,000 characters. Pushing the range down to the runner is the follow-up, and it is
 * detectable by an absent `linesShown` field rather than by a version probe.
 */
export const READ_FETCH_BYTES = 128 * 1024;

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
	/** Override the character budget (the Co-pilot's reader keeps its own, smaller one). */
	maxChars?: number;
	maxLines?: number;
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
export function renderRepoFileWindow(input: RepoFileWindowInput): { content: string; success: boolean } {
	const { path } = input;
	const maxChars = input.maxChars ?? READ_MAX_CHARS;
	const maxLines = input.maxLines ?? READ_MAX_LINES;
	const fetchTruncated = Boolean(input.fetchTruncated);
	const raw = input.content ?? "";

	// An empty file is an answer, not a failure — and saying so plainly stops a model reading the
	// blank result as "the read failed" and trying three more spellings of the path.
	if (raw === "") return { content: `--- ${path} — this file is empty (0 lines) ---`, success: true };

	const lines = raw.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	if (raw.endsWith("\n")) {
		// The empty element after a file's final newline is not a line.
		lines.pop();
	} else if (fetchTruncated && lines.length > 1) {
		// A byte cap stops mid-line. Showing that fragment as if it were a whole line is the small
		// dishonesty this whole change is against; the fetch note below says why it is missing.
		lines.pop();
	}
	const available = lines.length;

	const start = parseLineArg(input.startLine);
	const end = parseLineArg(input.endLine);
	if (Number.isNaN(start) || Number.isNaN(end)) {
		return { content: "`startLine` and `endLine` must be whole line numbers, 1-based and inclusive (e.g. startLine=480, endLine=540).", success: false };
	}

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
	if (from > available) {
		// Refuse with the number, rather than return an empty window that reads like "this part of
		// the file is blank".
		const reach = fetchTruncated
			? `only its first ${num(available)} lines could be read from this machine (the runner returns at most ${num(READ_FETCH_BYTES)} bytes of the file's ${num(input.size ?? 0)})`
			: `${path} has ${num(available)} lines`;
		return { content: `\`startLine\` ${num(from)} is past the end of what this tool can read: ${reach}. Ask for a startLine within that, or use repo_grep to find the line you actually want.`, success: false };
	}

	const wantedTo = end === null ? available : Math.min(end, available);
	const body: string[] = [];
	let used = 0;
	let budgetBound = false;
	for (let n = from; n <= wantedTo; n++) {
		let text = lines[n - 1] ?? "";
		if (text.length > MAX_LINE_CHARS) text = `${text.slice(0, MAX_LINE_CHARS)} … [line truncated: it is ${num(text.length)} characters long]`;
		const rendered = `${n}: ${text}`;
		if (body.length >= maxLines || (body.length > 0 && used + rendered.length + 1 > maxChars)) {
			budgetBound = true;
			break;
		}
		body.push(rendered);
		used += rendered.length + 1;
	}
	const shownTo = from + body.length - 1;

	const whole = !fetchTruncated && from === 1 && shownTo === available;
	const total = fetchTruncated ? `at least ${num(available)}` : num(available);
	const head = `--- ${path} — lines ${num(from)}-${num(shownTo)} of ${total}${whole ? " (the whole file)" : ""} ---`;

	if (shownTo < available) {
		const why = budgetBound ? ` (this window holds about ${num(maxChars)} characters or ${num(maxLines)} lines, whichever comes first)` : "";
		notes.push(
			`This is a WINDOW, not the whole file: lines ${num(shownTo + 1)}-${num(available)} were NOT returned${why}.` +
				` To continue, call repo_read_file again with path="${path}" startLine=${num(shownTo + 1)}.` +
				" To jump straight to something instead of paging, use repo_grep and read a window around the line it reports.",
		);
	}
	if (fetchTruncated) {
		const ofSize = typeof input.size === "number" && input.size > 0 ? ` of this file's ${num(input.size)}` : "";
		notes.push(
			`This machine's runner stopped reading at its own byte cap${ofSize}, so lines past ${num(available)} cannot be reached through this tool at all` +
				" — use repo_grep to find the line you need. Do NOT state or imply that the file ends here.",
		);
	}

	const tail = shownTo < available ? `\n\n(continues — repo_read_file path="${path}" startLine=${num(shownTo + 1)})` : "";
	return { content: `${head}${notes.length ? `\n${notes.join("\n")}` : ""}\n\n${body.join("\n")}${tail}`, success: true };
}
