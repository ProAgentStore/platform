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
const LEAD = "^(?:(?:ok(?:ay)?|please|pls|just|now|then|so|and|alright|right|hey)[,\\s]+)*";
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

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * The runs the owner's message NAMES — the target half of their consent (#1015). A stop the owner
 * aimed at one run authorizes that run and nothing else: not another run the model selected, and not
 * the omitted-selector "everything" fallback. Read from the message minus fenced blocks and `>` lines
 * (pasted output), but WITH inline quotes, because "stop `abc…`" names its target. Candidates are this
 * instance's runs; any run-id-shaped token counts too, so naming an unknown run narrows to nothing
 * rather than widening to all. Lower-cased; empty = the owner named no run.
 */
export function runsNamedBy(text: string, candidates: readonly string[]): string[] {
	const said = text
		.replace(/```[\s\S]*?```/g, " ")
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n");
	const esc = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const named = new Set(candidates.filter((id) => new RegExp(`(^|[^\\w-])${esc(id)}(?![\\w-])`, "i").test(said)).map((id) => id.toLowerCase()));
	for (const m of said.matchAll(UUID)) named.add(m[0].toLowerCase());
	return [...named];
}

/**
 * Which runs a `stop_work` may touch (#1015). The consequential action AND its target both have to be
 * the owner's: a run the owner named binds the stop to that run, so a different run the model selected
 * is refused and the omitted-selector "everything" narrows to what they named. "Stop" naming no run
 * authorizes all of theirs, and a direct invocation is its own target. `candidates` are this
 * instance's runs; the model's `runId` is added so a run older than the listing is still recognised.
 */
export function stopTarget(ctx: Pick<RegistryToolCtx, "turn">, runId: string, candidates: readonly string[]): { refused: string } | { named: string[]; allows: (id: string) => boolean } {
	const named = ctx.turn?.explicit ? [] : runsNamedBy(ctx.turn?.text ?? "", runId ? [...candidates, runId] : candidates);
	if (runId && named.length && !named.includes(runId.toLowerCase())) {
		return { refused: `The owner asked to stop ${named.join(", ")}, not ${runId}, so nothing was stopped. Stop the run they named, or ask them which one they mean.` };
	}
	return { named, allows: (id) => !named.length || named.includes(id.toLowerCase()) };
}

/**
 * The repository an `end_coding_session` targets (#1015): a `repo` the owner never said is the model's
 * pick, so it is dropped and `pickSessionToEnd` either finds the one open session or asks which.
 */
export function sessionTarget(ctx: Pick<RegistryToolCtx, "turn">, repo: unknown): string | undefined {
	if (typeof repo !== "string" || !repo.trim()) return undefined;
	return ctx.turn?.explicit || ownWords(ctx.turn?.text ?? "").toLowerCase().includes(repo.trim().toLowerCase()) ? repo : undefined;
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
