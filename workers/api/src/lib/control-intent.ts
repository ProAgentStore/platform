/**
 * Whether a CONTROL tool call carries the owner's own request (#1015).
 *
 * `stop_work` checked only that the run was the caller's to stop. That answers "may this agent stop
 * it?" and not "did the owner ask?" — so the model choosing the tool WAS the authorization, and
 * anything that put a stop word in front of it could cancel work: a pasted log line ("cancel run
 * …"), an evidence-only question quoting a CLI ("it printed 'stop'"), a Loop or a supervisor writing
 * the turn, or a diagnostic report. A capacity warning is the same shape: advice, not a request.
 *
 * So a control effect needs two facts the model cannot supply:
 *
 *   1. WHO wrote the turn — set by the dispatcher on `RegistryToolCtx.turn`, never by the model. The
 *      owner's chat (`chat` / `api` channel, not driven by a supervisor) is the owner; a Loop turn, a
 *      supervisor's delegation, a pipeline, a trigger or no turn at all is the CONTROLLER. The owner
 *      invoking the tool directly (console, MCP `call_instance_tool`, an approved ticket) is `explicit`.
 *   2. That the owner's own words ASK for it — read from their text with every quoted span removed
 *      (code fences, backticks, quotation marks, `>` lines), so quoted or pasted text is evidence and
 *      never a request; and only an imperative or a direct request counts, not "why did it stop?".
 *
 * A refusal says nothing was stopped. An accepted control effect is attributed to the verified owner
 * on the #1017 lifecycle ledger by its caller.
 */
import type { RegistryToolCtx } from "./connectors/types.js";
import { recordLifecycle } from "./objective-lifecycle.js";

/** The chat channels a person types into. A `loop` turn is the Loop; `trial` is a public visitor. */
const OWNER_CHANNELS = new Set(["chat", "api"]);

/** Who wrote a chat turn: the owner, unless a Loop wrote it or a supervisor is driving the turn. */
export function chatTurnAuthor(channel: string | undefined, delegatedBy: string | null | undefined): "owner" | "controller" {
	return !delegatedBy && OWNER_CHANNELS.has(channel ?? "chat") ? "owner" : "controller";
}

/** The owner's text with everything quoted or pasted removed — what is left is what they SAID. */
export function ownWords(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(^|\s)'[^'\n]*'(?=\s|$|[.,!?])/g, " ")
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n");
}

const STOP = "(?:stop|halt|cancel|abort|kill|terminate)";
/** Closing words — consent to END A SESSION only, and only when the clause names the session. */
const END = "(?:stop|halt|cancel|abort|kill|terminate|close|end|finish|shut\\s+down|wrap\\s+up)";
const LEAD = "^(?:(?:ok(?:ay)?|please|pls|just|now|then|so|and|alright|right|hey|never\\s+mind)[,\\s]+)*";
const ASK = "\\b(?:please|can you|could you|would you|will you|i want you to|i need you to|go ahead and)\\s+";
const ENOUGH = /^(?:that'?s enough|enough)\b/i;
const negated = (verb: string) => new RegExp(`\\b(?:don'?t|do not|never|no need to|not)\\s+(?:\\w+\\s+){0,2}${verb}\\b`, "i");
/**
 * A verb whose object is a BEHAVIOUR ("stop asking the same question", "stop repeating yourself") is
 * about how the agent talks, not about work — consent to neither a run nor a session. `working`,
 * `running` and the `…thing` pronouns ("stop everything") do name work.
 */
const behaviourObject = (verb: string) => new RegExp(`\\b${verb}\\s+(?!(?:working|running|[a-z]*thing)\\b)[a-z]+ing\\b`, "i");

/** The clauses of the owner's own words that ask, imperatively or directly, with `verb`. */
function askingClauses(text: string, verb: string): string[] {
	const imperative = new RegExp(`${LEAD}${verb}\\b`, "i");
	const request = new RegExp(`${ASK}${verb}\\b`, "i");
	return ownWords(text)
		.split(/[\n.!?;]+/)
		.map((c) => c.trim())
		.filter((c) => !negated(verb).test(c) && !behaviourObject(verb).test(c) && (imperative.test(c) || request.test(c)));
}

/** Do the owner's own words ask to stop WORK? Not "stop asking …", not a question, not a quote. */
export function asksToStop(text: string): boolean {
	return askingClauses(text, STOP).length > 0 || ownWords(text).split(/[\n.!?;]+/).some((c) => ENOUGH.test(c.trim()));
}

/** Do the owner's own words ask to end a SESSION — "close / end / finish / stop the session"? */
export function asksToEndSession(text: string): boolean {
	return askingClauses(text, END).some((c) => /\bsessions?\b/i.test(c));
}

/**
 * A run-id-shaped TOKEN — the whole token, so `<a real id>-extra` reads as `<a real id>-extra`, an id no
 * run has, and never as the real id it starts with (#1015). `mentions` already required the exact token;
 * this keeps the id scan from re-adding the prefix behind it.
 */
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/**
 * Every whole token that CONTAINS an id shape, lower-cased — `extra-<id>`, `x<id>`, `_<id>` and
 * `<id>-extra` are each their own token, an id no run has, so they narrow to nothing instead of either
 * matching the real id or vanishing and leaving "stop" to mean every run (#1015 audit).
 */
const idTokens = (text: string): string[] => (text.match(/[\w-]+/g) ?? []).filter((t) => UUID_SHAPE.test(t)).map((t) => t.toLowerCase());

const esc = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Does `text` mention `id` as a whole token (not as part of a longer id or word)? */
const mentions = (text: string, id: string) => new RegExp(`(^|[^\\w-])${esc(id)}(?![\\w-])`, "i").test(text);
/** A repository name as a whole path token: not a segment of a longer `owner/repo` path. */
const repoMention = (text: string, name: string) => new RegExp(`(^|[^\\w./-])${esc(name)}(?![\\w/-]|\\.[\\w])`, "i").test(text);
/**
 * Where the owner EXCLUDES a target (#1015): "not X", "don't / never / no need to …X", "except X",
 * "excluding X", "other than X", "apart from X", "leave X" ("never mind" is not one). Each lead covers the rest of its clause, so "not run-a or run-b" excludes both and
 * "do not stop run-b" excludes run-b. A clause ends at sentence punctuation or a "but" that turns back.
 * Reading too much as excluded only narrows what may be touched, never widens it.
 */
const EXCLUDE_LEAD = /\b(?:not|don'?t|never(?!\s+mind\b)|no\s+need\s+to|except(?:\s+for)?|excluding|other\s+than|apart\s+from|leave)\b/gi;
/** A clause ends at sentence punctuation, a colon ("Not X: stop Y" turns to Y), or a "but" that turns back. */
const CLAUSE_END = /[\n.!?;:]|,?\s+but\s+(?!not\b)/i;
/** Each exclusion as `[start, end)` in `text`: from its lead to the end of its clause. */
function exclusionRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const m of text.matchAll(EXCLUDE_LEAD)) {
		const from = (m.index ?? 0) + m[0].length;
		const span = text.slice(from).split(CLAUSE_END)[0] ?? "";
		ranges.push([m.index ?? 0, from + span.length]);
	}
	return ranges;
}
function excludedSpans(text: string): string[] {
	return exclusionRanges(text).map(([start, end]) => text.slice(start, end).replace(EXCLUDE_LEAD, " "));
}
/** `text` with every exclusion clause blanked — what is left is what the owner pointed AT. */
function withoutExclusions(text: string): string {
	let out = text;
	for (const [start, end] of exclusionRanges(text)) out = out.slice(0, start) + " ".repeat(end - start) + out.slice(end);
	return out;
}
/** The candidates (lower-cased) the owner excluded, plus any run-id-shaped token in an excluded span. */
function excludedOf(text: string, candidates: readonly string[], uuids = false, match = mentions): string[] {
	const out = new Set<string>();
	for (const span of excludedSpans(text)) {
		for (const id of candidates) if (match(span, id)) out.add(id.toLowerCase());
		if (uuids) for (const t of idTokens(span)) out.add(t);
	}
	return [...out];
}
/** A run's text as targets are read from it: minus fenced blocks and `>` lines, WITH inline quotes. */
const targetText = (text: string) =>
	text
		.replace(/```[\s\S]*?```/g, " ")
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n");

/**
 * The runs the owner's message NAMES — the target half of their consent (#1015). A stop the owner
 * aimed at one run authorizes that run and nothing else: not another run the model selected, and not
 * the omitted-selector "everything" fallback. Read from the message minus fenced blocks and `>` lines
 * (pasted output), but WITH inline quotes, because "stop `abc…`" names its target. Candidates are this
 * instance's runs; any run-id-shaped token counts too, so naming an unknown run narrows to nothing
 * rather than widening to all. Lower-cased; empty = the owner named no run.
 */
export function runsNamedBy(text: string, candidates: readonly string[]): string[] {
	// A run the owner excluded ("stop run-a, not run-b") is mentioned, and is the opposite of named.
	const excluded = new Set(runsExcludedBy(text, candidates));
	return runsPointedAt(text, candidates).filter((id) => !excluded.has(id));
}

/** The runs the owner's words point AT, outside every exclusion clause — before any conflict is resolved. */
function runsPointedAt(text: string, candidates: readonly string[]): string[] {
	const said = withoutExclusions(targetText(text));
	const named = new Set(candidates.filter((id) => mentions(said, id)).map((id) => id.toLowerCase()));
	for (const t of idTokens(said)) named.add(t);
	return [...named];
}

/** "Everything", "all", "the rest" — the words that make an exclusion an all-except rather than a target. */
const UNIVERSAL = /\b(?:every(?:thing|one)?|all|any(?:thing)?|the\s+rest|others)\b/i;

/** The runs the owner's message EXCLUDES — "not X", "except X", "leave X" (#1015). Lower-cased. */
export function runsExcludedBy(text: string, candidates: readonly string[]): string[] {
	return excludedOf(targetText(text), candidates, true);
}

/**
 * Which runs a `stop_work` may touch (#1015). The consequential action AND its target both have to be
 * the owner's: a run the owner named binds the stop to that run, so a different run the model selected
 * is refused and the omitted-selector "everything" narrows to what they named. "Stop" naming no run
 * authorizes all of theirs, and a direct invocation is its own target. `candidates` are this
 * instance's runs; the model's `runId` is added so a run older than the listing is still recognised.
 */
export function stopTarget(ctx: Pick<RegistryToolCtx, "turn">, runId: string, candidates: readonly string[]): { refused: string } | { named: string[]; allows: (id: string) => boolean } {
	const all = runId ? [...candidates, runId] : candidates;
	const text = ctx.turn?.explicit ? "" : (ctx.turn?.text ?? "");
	const named = runsNamedBy(text, all);
	// An excluded run is refused even when it is the only one the owner mentioned, and is never in the
	// "everything" an unnamed stop reaches: "stop everything except run-b" must leave run-b running.
	const excluded = runsExcludedBy(text, all);
	// A run the owner both named and excluded is a contradiction, not a cancelled-out target: it must not
	// leave an empty named set that reads as "every run".
	const conflicted = runsPointedAt(text, all).filter((id) => excluded.includes(id));
	if (conflicted.length) {
		return { refused: `The owner both asked to stop and said not to stop ${conflicted.join(", ")}, so nothing was stopped. Ask them which run they mean.` };
	}
	// Exclusions that name no positive target are an all-except only when the owner said "everything".
	if (!named.length && excluded.length && !UNIVERSAL.test(withoutExclusions(ownWords(text)))) {
		return { refused: `The owner said not to stop ${excluded.join(", ")} and named no run to stop, so nothing was stopped. Ask them which run they mean.` };
	}
	if (runId && excluded.includes(runId.toLowerCase())) {
		return { refused: `The owner said not to stop ${runId}, so nothing was stopped. Stop only what they asked for, or ask them which run they mean.` };
	}
	if (runId && named.length && !named.includes(runId.toLowerCase())) {
		return { refused: `The owner asked to stop ${named.join(", ")}, not ${runId}, so nothing was stopped. Stop the run they named, or ask them which one they mean.` };
	}
	return { named, allows: (id) => !excluded.includes(id.toLowerCase()) && (!named.length || named.includes(id.toLowerCase())) };
}

/** What an `end_coding_session` call carries for the target decision: the owner's turn and the model's pick. */
export interface SessionRequest {
	explicit: boolean;
	text: string;
	repo: string | undefined;
}

/** The request as the dispatcher and the model left it; resolved against the real repo names by {@link resolveSessionTarget}. */
export function sessionTarget(ctx: Pick<RegistryToolCtx, "turn">, repo: unknown): SessionRequest {
	return { explicit: !!ctx.turn?.explicit, text: ctx.turn?.text ?? "", repo: typeof repo === "string" && repo.trim() ? repo.trim() : undefined };
}

/**
 * Which repository's session the owner's words let `end_coding_session` end (#1015).
 *
 * - A repo the owner EXCLUDED ("…, not aipa") is refused, and is never the session a bare request falls
 *   back to (`excluded` goes to `pickSessionToEnd`).
 * - A repo the owner NAMED binds the target, whatever the model picked. If that repo has no open session,
 *   nothing is ended. It must not fall back to the one open session, which belongs to another repository.
 * - A repo only the model named is dropped (879620b1), so a bare "close the session" still ends the one
 *   open session or asks which.
 *
 * `repoNames` are this instance's repository names. A name is recognised by its full form or its last
 * path segment ("acme/platform" or "platform").
 */
export function resolveSessionTarget(req: SessionRequest, repoNames: readonly string[]): { refused: string } | { repo: string | undefined; excluded: string[] } {
	if (req.explicit) return { repo: req.repo, excluded: [] };
	const intent = parseSessionIntent(targetText(req.text), repoNames, req.repo);
	// Validation and selection read the SAME parsed intent — nothing below re-reads the owner's text.
	if (intent.conflicted.length) {
		return { refused: `The owner both asked to end and said not to end the ${intent.conflicted.join(", ")} session, so nothing was ended. Ask them which session they mean.` };
	}
	if (intent.ambiguous.length) {
		const [a] = intent.ambiguous;
		return { refused: `The owner said "${a.name}", which more than one repository is called (${a.repos.join(", ")}), so nothing was ended. Ask which one they mean.` };
	}
	if (intent.unresolved.length) {
		const [u] = intent.unresolved;
		return { refused: `The owner asked to end the ${u} session, but there is no repository called "${u}" on this agent, so nothing was ended. Ask them which session they mean.` };
	}
	const { named, excluded, pick } = intent;
	if (pick && excluded.includes(pick)) return { refused: `The owner said not to end the ${pick} session, so nothing was ended. End only the session they asked for, or ask them which one they mean.` };
	if (named.length > 1 && !(pick && named.includes(pick))) {
		return { refused: `The owner named more than one repository (${named.join(", ")}), so nothing was ended. Ask which session they want closed.` };
	}
	if (named.length) return { repo: pick && named.includes(pick) ? pick : named[0], excluded };
	return { repo: undefined, excluded };
}

/**
 * Everything the owner's words say about WHICH session, parsed once (#1015). Explicit-but-unresolved,
 * ambiguous and contradictory targets are states of the result, not things a later step may lose:
 *
 * - `named`: repositories the owner pointed at, outside every exclusion, resolved exactly.
 * - `excluded`: repositories an exclusion reaches. A short name two repositories share excludes BOTH —
 *   reading too much as excluded only narrows what may be touched.
 * - `conflicted`: named AND excluded.
 * - `ambiguous`: a positive short name more than one repository is called.
 * - `unresolved`: an explicit target that names no repository — including a name whose trailing "-", "/"
 *   or ".." is part of it ("platform-" is not "platform"), and a label directly after "session".
 * - `pick`: the model's selector, resolved by exact name or a unique short name — never trusted on its own.
 */
export interface SessionIntent {
	named: string[];
	excluded: string[];
	conflicted: string[];
	ambiguous: Array<{ name: string; repos: string[] }>;
	unresolved: string[];
	pick: string | undefined;
}

export function parseSessionIntent(said: string, repoNames: readonly string[], selector?: string): SessionIntent {
	const names = [...new Set([...repoNames, ...(selector ? [selector] : [])])];
	// A short name ("platform" for "acme/platform") stands for its repo only when no other repo shares it,
	// and only as its own token — "owner1/platform" is owner1's, never a mention of "platform".
	const short = (name: string) => name.split("/").pop() ?? name;
	const sharing = (alias: string) => names.filter((n) => short(n).toLowerCase() === alias.toLowerCase());
	const aliases = (name: string) => [...new Set([name, ...(sharing(short(name)).length === 1 ? [short(name)] : [])])];
	const sharedShorts = [...new Set(names.map(short).filter((a) => sharing(a).length > 1))];
	// Exclusions: exact names and unique aliases, plus every repository behind a shared short name.
	const excludedTokens = new Set(excludedOf(said, [...names.flatMap(aliases), ...sharedShorts], false, repoMention));
	const isExcluded = (name: string) => aliases(name).some((a) => excludedTokens.has(a.toLowerCase())) || excludedTokens.has(short(name).toLowerCase());
	const excluded = names.filter(isExcluded);
	const pointed = withoutExclusions(said);
	const pointedAt = names.filter((n) => aliases(n).some((a) => repoMention(pointed, a)));
	const ambiguous = sharedShorts.filter((a) => repoMention(pointed, a)).map((a) => ({ name: a, repos: sharing(a) }));
	// One resolution for every explicit target slot: a token is a repository, ambiguous, or unresolved.
	const known = new Set(repoNames.flatMap((n) => [n.toLowerCase(), short(n).toLowerCase()]));
	const unresolved = [...new Set(sessionTargetWords(pointed).filter((w) => !known.has(w.toLowerCase())))];
	const pick = selector ? (names.find((n) => aliases(n).some((a) => a.toLowerCase() === selector.toLowerCase())) ?? selector) : undefined;
	return {
		named: pointedAt.filter((n) => !isExcluded(n)),
		excluded,
		conflicted: pointedAt.filter(isExcluded),
		ambiguous,
		unresolved,
		pick,
	};
}

/** Words that describe A session rather than name its repository: "the coding session", "every session". */
const GENERIC_SESSION_WORD = new Set(
	"the this that these those my your our its their a an one only current open active running live idle last old previous other same whole entire existing new stale remaining every each all any both coding cli engine terminal repo repository claude codex grok agent".split(" "),
);
/** Words that may follow "session" without being its label: "close the session now", "…session for X". */
const AFTER_SESSION_WORD = new Set(
	"now please and too again first already itself that this there here which where when just only ever never not no but or if so yet still for at to a an the on of in named called titled with as by".split(" "),
);
/**
 * The explicit target slots, as written (#1015): the word before "session" ("the platform session", "the
 * `owner/repo` session"), the word after "session for/on/of/in/named/called/titled", and a label directly
 * after "session" ("the session ghost"). A name keeps every character but ONE trailing sentence period:
 * "…for platform." names "platform", while "platform-", "platform/" and "platform.." are names no
 * repository has — so they resolve to nothing instead of to the repository they resemble.
 */
function sessionTargetWords(text: string): string[] {
	const words: string[] = [];
	const token = "([\\w][\\w./-]*)[`'\"’”]?";
	const open = "[`'\"‘“]?";
	for (const m of text.matchAll(new RegExp(`(?<![\\w./-])${open}${token}(?:\\s+(?:repo|repository|coding|cli))*\\s+sessions?\\b`, "gi"))) words.push(m[1]);
	for (const m of text.matchAll(new RegExp(`\\bsessions?\\s+(?:for|on|of|in|named|called|titled)\\s+(?:the\\s+)?${open}${token}`, "gi"))) words.push(m[1]);
	for (const m of text.matchAll(new RegExp(`\\bsessions?\\s+${open}${token}`, "gi"))) if (!AFTER_SESSION_WORD.has(m[1].toLowerCase().replace(/\.$/, ""))) words.push(m[1]);
	return words.map((w) => w.replace(/(?<!\.)\.$/, "")).filter((w) => w && !GENERIC_SESSION_WORD.has(w.toLowerCase()));
}

/** What each control tool needs the owner to have asked for, in their own words. */
const ASKS: Record<"stop_work" | "end_coding_session", { test: (text: string) => boolean; nothing: string }> = {
	stop_work: { test: asksToStop, nothing: "Nothing was stopped" },
	end_coding_session: { test: asksToEndSession, nothing: "Nothing was ended" },
};

/** The verdict a control tool acts on: null to proceed, or the refusal to return (nothing done). */
export function controlRefusal(ctx: Pick<RegistryToolCtx, "turn">, tool: keyof typeof ASKS): string | null {
	const turn = ctx.turn;
	const { test, nothing } = ASKS[tool];
	if (turn?.author !== "owner") {
		return `${tool} needs the owner's own request, and this turn was written by ${turn ? "the controller (a Loop, a supervisor, a pipeline or a trigger)" : "no identified person"}. ${nothing} — tell the owner what you found and let them decide.`;
	}
	if (turn.explicit || test(turn.text ?? "")) return null;
	const what = tool === "end_coding_session" ? "to end the session" : "to stop work";
	return `${tool} needs the owner to ASK ${what} in their own words, and their message does not — a stop word inside quoted, pasted or reported text is evidence, and "stop asking/repeating …" is about how you talk, not a request to stop work. ${nothing}; do not tell the owner otherwise. If you are unsure what they meant, ask them.`;
}

/**
 * Attribute a stop that took effect to the verified owner on the #1017 lifecycle ledger — the record
 * of who cancelled a run, beside the queue-entry cancellations it already holds. Only reached past
 * {@link controlRefusal}, so the actor is always the owner; best-effort, like every ledger write.
 */
export async function attributeStop<T extends { kind: string; runId: string; instanceId: string }>(ctx: Pick<RegistryToolCtx, "env" | "userId" | "turn">, outcome: T): Promise<T> {
	if (outcome.kind === "requested" && ctx.userId) {
		await recordLifecycle(ctx.env, {
			userId: ctx.userId,
			instanceId: outcome.instanceId,
			runId: outcome.runId,
			event: "cancelled",
			actor: { kind: "owner", uid: ctx.userId, clientClaimed: null },
			reason: ctx.turn?.explicit ? "stop_work invoked directly by the owner" : "stop_work: the owner asked in their own words",
		});
	}
	return outcome;
}
