/**
 * Invented tool results (#395) — the model wrote its own `<tool_response>` and the platform
 * believed it.
 *
 * ── What happened
 *
 * On a Repo Coder instance the model emitted BOTH halves of a tool round inside its own reply: a
 * `<tool_call>` for `repo_remote` with a `<tool_response>` saying `pas-platform/chess-academy`,
 * then a `github_list_issues` call and three issues quoted by number and title. The trace records
 * exactly two executions for that turn — `repo_remote` (no git origin remote) and `repo_tree` (no
 * files found) — and no `github_list_issues` at all. The user was told those three were the open
 * tickets and decided what to build next from them.
 *
 * ── Why nothing objected
 *
 * `parseToolCallsFromText` extracted the calls and never removed the spans, so the markup reached
 * the transcript. And the platform had no concept of a model-authored RESULT: a `<tool_response>`
 * block was prose to every layer, so it persisted, became context on the next turn, and was read
 * back as established fact — which is how a later turn with NO tool execution at all still said
 * "as I just fetched".
 *
 * ── The one fact this module stands on
 *
 * The platform NEVER writes tool-result markup into an assistant message. Results reach the model
 * as the PLATFORM's own turn — since #398 a `user` turn of real `tool_result` blocks on the
 * structured path, and the older `[name]: …` prose message on the Workers-AI fallback — and reach
 * the user as the tool log. So a result block in the model's own text is proof by construction,
 * not a heuristic. (#398 strengthens this rather than weakening it: on the structured path a
 * result is now a block type an assistant turn cannot legally contain.) It is
 * `untrusted-fence.ts` pointed the other way: that one fences text coming IN so it is never read
 * as instructions, this one catches text going OUT that claims to be a platform record.
 *
 * ── Why it does not simply delete the invention
 *
 * A silent strip leaves a confident answer with its evidence removed, which is worse than showing
 * nothing: the prose built on the invention survives, and the user cannot tell the difference. So
 * the ladder is — correct and regenerate ONCE against the real record; if the second attempt
 * fabricates too, deliver the platform's own statement of what ran instead of the model's text;
 * and in both cases say so in the tool log, because the user acted on this exact class of answer.
 *
 * Pure: it decides, it never fetches. The correction round is an injected callback, so the whole
 * ladder — including the second fabrication — is unit-tested from the incident's own transcript.
 */

/** A model reply after the JSON walker has lifted its text-embedded calls out (#395 half one). */
export interface ParsedReply {
	/** The text with those call spans already removed. */
	text: string;
	/** The tool names the walker lifted — calls the platform is NOT going to execute here. */
	calls: readonly string[];
}

/**
 * Markup families a model may write.
 *
 * Two vocabularies at once is the normal case, not the edge: the incident's message closed its
 * fabricated blocks with `</parameter>`, which belongs to a different tool syntax than the
 * JSON-in-text form this platform teaches. A stripper that assumed one vocabulary would have left
 * half the invention on screen — which is precisely what the user reported seeing.
 */
const CALL_TAGS = ["tool_call", "tool_calls", "function_calls", "invoke", "parameter"] as const;
const RESULT_TAGS = [
	"tool_response",
	"tool_result",
	"tool_results",
	"function_results",
	"function_result",
	"tool_output",
	"tool_outputs",
] as const;

/** What a strip found. `wroteResult` is the load-bearing one: the platform never writes these. */
export interface StrippedMarkup {
	text: string;
	/** Tool names named by the model's own call markup. */
	names: string[];
	/** The model wrote a tool RESULT block. */
	wroteResult: boolean;
}

const openRe = (tag: string) => new RegExp(`<\\s*${tag}\\b[^>]*>`, "gi");
const closeRe = (tag: string) => new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi");
const pairedRe = (tag: string) => new RegExp(`<\\s*${tag}\\b([^>]*)>([\\s\\S]*?)<\\s*/\\s*${tag}\\s*>`, "gi");

/** The tool name a call block declares — `name="x"` on the tag, or `"name":"x"` in its body. */
function nameFrom(attrs: string, body: string): string | undefined {
	const attr = /\bname\s*=\s*["']([^"']+)["']/.exec(attrs);
	if (attr) return attr[1];
	const json = /"name"\s*:\s*"([^"]+)"/.exec(body);
	return json ? json[1] : undefined;
}

/**
 * Remove every recognised tool-call / tool-result span from a model reply.
 *
 * An UNCLOSED result opener takes the rest of the text with it. That looks aggressive and is the
 * honest reading: there is no legitimate continuation after a result block the model was still in
 * the middle of inventing — whatever follows was written FROM it. Callers never ship this text
 * bare anyway; a fabrication always goes through the correction ladder below.
 */
export function stripToolMarkup(raw: string): StrippedMarkup {
	let text = String(raw ?? "");
	const names: string[] = [];
	let wroteResult = false;

	for (const tag of RESULT_TAGS) {
		text = text.replace(pairedRe(tag), () => {
			wroteResult = true;
			return "";
		});
		text = text.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*$`, "i"), () => {
			wroteResult = true;
			return "";
		});
		text = text.replace(closeRe(tag), () => {
			wroteResult = true;
			return "";
		});
	}

	for (const tag of CALL_TAGS) {
		text = text.replace(pairedRe(tag), (_m, attrs: string, body: string) => {
			const name = nameFrom(attrs, body);
			if (name) names.push(name);
			return "";
		});
		// An orphan opener/closer loses the TAG only. Unlike a result block, the body of a call is
		// often the JSON the walker already removed, and the prose around it is the model's answer.
		text = text.replace(openRe(tag), (m) => {
			const name = nameFrom(m, "");
			if (name) names.push(name);
			return "";
		});
		text = text.replace(closeRe(tag), "");
	}

	return { text: text.replace(/\n{3,}/g, "\n\n").trim(), names, wroteResult };
}

/**
 * First-person assertions of a fetch that JUST happened.
 *
 * Only ever evaluated when the turn executed NOTHING, which is what makes them checkable rather
 * than a guess about prose: "as I just fetched" in a turn with an empty execution record is false
 * whatever it refers to. The immediacy words are the point — "the issues I found earlier" is a
 * reference to another turn and must stay legal, so the patterns key on `just`, on a direct past
 * tense with an object, or on the tools themselves being named as the source.
 */
const UNBACKED_FETCH_CLAIMS: readonly RegExp[] = [
	/\bas I just (?:fetched|checked|ran|pulled|read|looked)\b/i,
	/\bI just (?:fetched|checked|ran|queried|pulled|retrieved|read|listed|looked at)\b/i,
	/\b(?:I|we) (?:fetched|retrieved|queried|pulled) (?:the|these|those|them|your|it)\b/i,
	/\bthe tools? (?:just )?returned\b/i,
	/\bI checked (?:the|your|our)\b/i,
	/\baccording to (?:the|my) (?:tool|fetch|query)\b/i,
];

/** The verdict on one model reply, against what actually executed this turn. */
export interface ReplyAudit {
	/** The reply with every recognised markup span removed. */
	text: string;
	/** The model wrote a tool RESULT — proof by construction, since the platform never does. */
	inventedResult: boolean;
	/** Tools the model's own markup names that did not execute this turn. */
	unrun: string[];
	/** A first-person "I just fetched" in a turn where nothing ran at all. */
	unbackedFetchClaim: boolean;
}

/** Audit one reply against the turn's execution record. `executed` is the ground truth. */
export function auditReply(reply: ParsedReply, executed: readonly string[]): ReplyAudit {
	const stripped = stripToolMarkup(reply.text);
	const ran = new Set(executed);
	const claimed = [...reply.calls, ...stripped.names];
	const unrun: string[] = [];
	for (const name of claimed) {
		if (!ran.has(name) && !unrun.includes(name)) unrun.push(name);
	}
	return {
		text: stripped.text,
		inventedResult: stripped.wroteResult,
		unrun,
		unbackedFetchClaim: executed.length === 0 && UNBACKED_FETCH_CLAIMS.some((re) => re.test(stripped.text)),
	};
}

/** A reply the platform must not ship as written. */
export function isFabricated(audit: ReplyAudit): boolean {
	return audit.inventedResult || audit.unrun.length > 0;
}

/** The platform's own voice in the tool log, distinct from the ✅/❌ lines the tools write. */
const PREFIX = "⚠️ **platform**";

export const CORRECTED_NOTICE =
	`${PREFIX} The agent wrote tool results that no tool produced. They were removed, and it answered again` +
	" from the results the platform actually has.";

export const REPLACED_NOTICE =
	`${PREFIX} The agent wrote tool results that no tool produced. Its answer was replaced with the` +
	" platform's record of what actually ran.";

export const NO_TOOLS_NOTICE = `${PREFIX} No tools ran on this turn — nothing was fetched or read just now.`;

/** The same disclosure for a surface that appends it to the reply rather than to a tool log. */
export const ONE_SHOT_NOTICE =
	`${PREFIX} The agent wrote tool results that no tool produced. They were removed; nothing above them` +
	" was fetched.";

/** Names a reply claimed and the turn never executed. Empty list → no line. */
export function unrunNotice(names: readonly string[]): string[] {
	return names.length === 0 ? [] : [`${PREFIX} Named but never run this turn: ${names.join(", ")}.`];
}

/** The tool log rendered for the model, or the honest statement that there is nothing in it. */
function recordOf(log: readonly string[]): string {
	return log.length > 0 ? log.join("\n") : "(nothing — no tool ran on this turn)";
}

/**
 * The correction handed back to the model. It states the mechanism rather than scolding, because
 * the model has to be able to ACT on it: what it wrote is not a result, here is the record, answer
 * from that or say you have not looked yet.
 */
export function fabricationCorrection(audit: ReplyAudit, log: readonly string[]): string {
	const named = audit.unrun.length > 0 ? ` You named ${audit.unrun.join(", ")}, which did not run.` : "";
	return (
		"STOP. You wrote tool results yourself. Only the platform produces a tool result; text you write" +
		` inside a response block is not one, and it was discarded.${named}\n\n` +
		`What ACTUALLY ran this turn:\n${recordOf(log)}\n\n` +
		"Answer again using ONLY those results. If you need something they do not contain, say plainly that" +
		" you have not looked yet and what you would run — never describe what a tool would have returned."
	);
}

/**
 * What the user gets when the model fabricates twice. First person, because it occupies the
 * assistant's turn, and factual, because the alternative — shipping the second invention, or
 * shipping an empty bubble — are the two things the incident is about.
 */
export function factualReply(log: readonly string[]): string {
	return (
		"I can't answer that honestly: I wrote tool results that no tool produced, so I have discarded them." +
		` Here is what actually ran this turn:\n\n${recordOf(log)}\n\n` +
		"Ask me to run something specific and I'll answer from its real result."
	);
}

/**
 * The tool log the user sees, with any platform notice FIRST.
 *
 * The order is load-bearing, not cosmetic. Every chat surface collapses a system message into a
 * "Used …" chip when it STARTS with a tool marker (`isToolCallMessage`, packages/sdk), so a notice
 * appended after the ✅ lines would be folded away inside the very evidence it is about — a
 * disclosure nobody opens is the silent strip this module exists to avoid. Leading with ⚠️ keeps
 * the whole message in view, tool lines included, which is the right shape for a turn the platform
 * had to intervene in.
 */
export function toolLogWithNotices(log: readonly string[], notices: readonly string[]): string[] {
	return notices.length === 0 ? [...log] : [...notices, ...log];
}

/** The reply the user sees, plus the platform lines that explain any intervention. */
export interface HonestReply {
	text: string;
	notices: string[];
}

/**
 * The ladder: audit → correct once → replace.
 *
 * `regenerate` is injected so this stays pure and so the second-fabrication branch — the one a
 * live system reaches least often and can least afford to get wrong — is reachable from a unit
 * test. It is called at most once: a model that invents through an explicit correction will not be
 * argued out of it by a third round, and each round is a real charge on the owner's own key.
 *
 * OMIT it for a surface with no correction round to buy — a turn on a model that cannot call a
 * tool at all, where a re-prompt is spend with no mechanism behind it. A fabrication there goes
 * straight to the replacement, which is the same verdict, reached sooner.
 */
export async function honestReply(input: {
	reply: ParsedReply;
	executed: readonly string[];
	log: readonly string[];
	regenerate?: (correction: string) => Promise<ParsedReply>;
}): Promise<HonestReply> {
	const first = auditReply(input.reply, input.executed);
	if (!isFabricated(first)) {
		return { text: first.text, notices: first.unbackedFetchClaim ? [NO_TOOLS_NOTICE] : [] };
	}
	if (!input.regenerate) {
		return { text: factualReply(input.log), notices: [REPLACED_NOTICE, ...unrunNotice(first.unrun)] };
	}

	const second = auditReply(await input.regenerate(fabricationCorrection(first, input.log)), input.executed);
	if (!isFabricated(second)) {
		// Disclosed even though the delivered text is clean: the user is reading an answer that
		// exists only because the platform caught the first one, and the retraction of an invented
		// ticket list is exactly the fact they need in order to re-check a decision made on it.
		return { text: second.text, notices: [CORRECTED_NOTICE, ...unrunNotice(first.unrun)] };
	}
	return { text: factualReply(input.log), notices: [REPLACED_NOTICE, ...unrunNotice([...first.unrun, ...second.unrun])] };
}

/**
 * One-shot cleanup for a surface with no correction round — the coding co-pilot, which has its own
 * bounded read loop and returns a single string.
 *
 * It gets the strip and the disclosure but not the ladder: appending one line is honest and cheap,
 * whereas a silent strip would hand the user a summary whose evidence was quietly deleted.
 */
export function scrubOneShotReply(raw: string): string {
	const stripped = stripToolMarkup(raw);
	if (!stripped.wroteResult) return stripped.text;
	return `${stripped.text}\n\n${ONE_SHOT_NOTICE}`;
}
