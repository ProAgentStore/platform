/**
 * A backstop on what a tool result may add to the next round's prompt (#427).
 *
 * ── What this is, and what it deliberately is not
 *
 * Most tools already cap themselves, and well: `github_read_issue` cuts a body at 8KB,
 * `repo_read_file` and `repo_git` at 8KB and 12KB, `fetch_url` at 4,000 characters, an MCP resource
 * read at `RESOURCE_MAX_CHARS`. Each of those is a per-tool judgement about that tool's data and
 * none of them should be overridden from here — which is why this ceiling sits ABOVE the largest of
 * them. It is not a policy about how much context a tool deserves. It is the answer to "what happens
 * when a tool that caps NOTHING returns something enormous", and today the answer is that it goes
 * into round 2's prompt verbatim, unbounded, with nothing between it and the model.
 *
 * ── Why it goes where the result RE-ENTERS the prompt
 *
 * `agent-think.ts` records each outcome twice — once as prose for the flattened path, once keyed by
 * `tool_use` id for the structured protocol — and both feed the next round. Capping at that single
 * seam covers every tool at once, including the connector written next month; capping in each
 * handler is the arrangement that already leaves gaps.
 *
 * ── Truncate visibly, always
 *
 * #427's regression note: a cap can hide what the model needed. So keep the HEAD, say exactly how
 * much was dropped, and say what to do about it — a model told "you received 24,000 of 91,000
 * characters" can ask for a narrower slice, whereas a model handed a silent fragment reasons
 * confidently over it and sounds exactly as sure. Same rule `truncateVisibly` follows for MCP
 * resources and `hitOutputCap` follows for a truncated reply (#397): the platform knows, so it says.
 */

/**
 * The ceiling, in characters (~6,000 tokens).
 *
 * Chosen to sit above every deliberate per-tool cap in the codebase — the largest is the 20,000 of
 * `RESOURCE_MAX_CHARS` — so this can only ever fire on a result nobody bounded. Below that it would
 * silently second-guess a judgement someone made on purpose, which is a worse bug than the one it
 * is here to prevent.
 */
export const TOOL_RESULT_MAX_CHARS = 24_000;

/**
 * Cut a tool result to the ceiling, keeping the head and naming both numbers.
 *
 * Returns the input unchanged when it fits — the overwhelming majority of the time — so this is a
 * length check on the hot path and nothing more.
 */
export function capToolResult(content: string, max = TOOL_RESULT_MAX_CHARS): string {
	const text = String(content ?? "");
	if (text.length <= max) return text;
	return (
		`${text.slice(0, max)}\n\n[truncated: this tool returned ${text.length.toLocaleString("en-US")} characters and the` +
		` first ${max.toLocaleString("en-US")} are shown. The rest was NOT read — ask for a narrower slice (one file, one` +
		" page, one field) rather than answering from this fragment.]"
	);
}
