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

/**
 * The other cap, on the other reader (#517).
 *
 * Everything above is about the MODEL's copy. The tool log is the OWNER's: each entry is persisted
 * as a `system` message and rendered as a pill under the turn, and it was cut at a flat 120
 * characters regardless of what the entry was.
 *
 * 120 is a reasonable preview of DATA — a file listing, a pane capture, a row count — where the
 * pill exists to say "this ran, and roughly this came back" and the answer above it carries the
 * meaning. It is the wrong number for a FAILURE, because a failure's text is not data: every
 * refusal `runRegistryTool` can emit is a sentence the platform wrote FOR the owner, and the part
 * that tells them what to do is at the END of it. The reported case is exact — the capability
 * constraint refusal is 405 characters and 120 lands here:
 *
 *     "…could not be resolved — this call names no subscribed instance "
 *
 * four characters into the word that begins the remedy, and for the `terminal` variant mid-word.
 * So the owner read an invented remedy from the model and the true one was on the same screen,
 * off the end of the string. The model's copy was never truncated (24,000), which is what makes
 * this purely a display defect and worth exactly one number.
 *
 * 600 bounds the only failure text nobody authored: the passthrough at `tool-registry.ts`'s outer
 * catch (`Error: ${err.message}`), which can carry an upstream body. Every platform-authored
 * refusal is far shorter and now arrives whole.
 */
export const TOOL_LOG_MAX_CHARS = 120;

/** What a FAILED tool result may show. Wider because it is prose written for the owner. */
export const TOOL_LOG_FAILURE_MAX_CHARS = 600;

/**
 * One entry of the tool log: the outcome icon, the tool's name, and as much of its result as that
 * outcome's budget allows.
 *
 * A success is cut EXACTLY as before, with no ellipsis, because a pill that has always read this
 * way is not worth changing to fix a failure's problem — and #517's acceptance criteria say so.
 * A failure marks its cut, because the sentence it is cutting is an instruction and a silently
 * truncated instruction is how this started.
 */
export function toolLogLine(name: string, content: string, success: boolean): string {
	const text = String(content ?? "");
	if (success) return `✅ **${name}** ${text.slice(0, TOOL_LOG_MAX_CHARS)}`;
	const shown = text.length <= TOOL_LOG_FAILURE_MAX_CHARS ? text : `${text.slice(0, TOOL_LOG_FAILURE_MAX_CHARS)}…`;
	return `❌ **${name}** ${shown}`;
}
