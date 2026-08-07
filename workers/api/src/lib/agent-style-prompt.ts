/**
 * The prompt blocks that tell an agent WHERE its work happens and HOW to answer (#315).
 *
 * These sentences used to live inline in `runAgentThink`, interleaved with the D1/DO reads that
 * feed them. That placement is why three of them went stale without anyone noticing: a claim about
 * the agent ("suggest adding the repo in the Repo tab", "start a session in the Coding tab",
 * "start the runner with `pags up`") sat inside a data-shaped branch, where it read as part of the
 * surrounding query rather than as an assertion about the agent's configuration — and where
 * nothing could reach it to check.
 *
 * Two things change by moving them here, and only the second one matters:
 *
 *   1. Every tab, runner and code-index mention is now DERIVED from the resolved `SelfModel`
 *      rather than written as a constant. An agent with `surfaces: ["coding"]` has no Repo tab,
 *      so it is never sent to one — which is #255, stated as code instead of as care.
 *   2. Because they are pure, `prompt-claims.ts` can build the real prompt for a real agent and
 *      assert that no sentence in it names a capability the agent does not have. A claim keyed to
 *      a NAMED capability is mechanically checkable; that is the whole subset this guard covers.
 *
 * Wording is otherwise unchanged from what shipped, deliberately: this is an extraction, and a
 * reworded prompt would make a behaviour change look like a refactor.
 */
import type { SelfModel } from "./agent-self-description.js";

/**
 * The channel the agent is heard through, and does not control (#340).
 *
 * ── A confirmation that fires ONLY on failure
 *
 * A user said **"Stop-stop."** into a live voice session. It was transcribed, sent as an ordinary
 * chat message, and the agent replied *"Got it. Stopped."* Nothing stopped: the mic stayed open and
 * two phantom turns followed (#332).
 *
 * The shape is what makes this worth a prompt line rather than a shrug. A voice-exit command is
 * matched CLIENT-SIDE and the utterance is never sent — so the only way the model can see the words
 * at all is if the match FAILED. "Stopped" is therefore emitted exactly and only when the stop did
 * not happen. And it did the damage a false confirmation always does: the user, told it worked,
 * stopped trying, which is what left the mic open for the phantom turns.
 *
 * ── Why a line and not a detector
 *
 * `3d7e28b` fixed the transport half (#334/#331/#332) — `"Stop-stop."` now normalises and matches,
 * bare `"stop"` was added, the silence hole is closed — so the trigger is largely gone. What is left
 * is the residue: a phrase in a language or wording nobody configured still arrives as text, and the
 * model must not confirm an action it cannot take. That residue is a WORDING problem, and a wording
 * problem is what a prompt line is for. The client-side alternative (#340 option 2) would regex
 * generated replies for voice verbs on turns where no exit occurred — the same unreliable class of
 * check, with a false-positive path ("I stopped the run") that would flag correct answers, built
 * speculatively for a condition the transport fix already removes.
 *
 * ── Why it cannot quietly drift back out
 *
 * This is a DENIAL keyed to a named capability, so `prompt-claims.ts` adjudicates it in both
 * directions. The source ratchet compares the found claims EXACTLY, so deleting this line fails the
 * test; and `DENIAL_RULES`' `no-voice-control` predicate asks the resolved `SelfModel` — the day any
 * agent is granted a tool that really does control the mic, the denial becomes false and the guard
 * fires. That is the #254 shape (a denial surviving the arrival of the tool that contradicts it),
 * caught by mechanism instead of by memory.
 *
 * Unconditional because it is unconditionally true: voice is a client feature on every agent's chat,
 * and no agent anywhere has a tool for it.
 */
export const voiceControlPrompt =
	"\n\nVOICE: you do not control the microphone or voice mode — the app the user speaks through does, on their device." +
	" You cannot start, stop, mute, unmute or switch it, and you never see whether it is on." +
	"\n- NEVER reply \"Stopped\", \"Muted\", \"Listening\" or anything else that confirms a voice action. You would only ever be" +
	" reading those words because the app did NOT act on them, so confirming is telling the user a failure succeeded." +
	"\n- If the user asks you to stop listening, mute, or leave voice, say plainly that you cannot do it from here and that they" +
	" should tap the voice control in the app. Then answer whatever else they asked.";

/**
 * A clause that names a console tab, emitted ONLY when the agent has that tab.
 *
 * The fallback is not a reworded tab — it is silence. "Add it somewhere" is useless advice, and
 * the failure mode being fixed is precisely an agent that would rather give bad directions than
 * admit it has none. Saying nothing leaves the surrounding sentence true.
 */
export function tabClause(model: SelfModel, tab: string, clause: string): string {
	return model.tabs.includes(tab) ? clause : "";
}

/**
 * Whether the local runner is connected — and, when it is not, what to do about it.
 *
 * `pags up` is a claim about a NAMED capability (`capabilities.runtime`): an agent with no local
 * runtime has no runner to start, and telling its owner to start one is the same class of error as
 * naming a tab it does not have. Cloud-only agents therefore get the state without the remedy.
 */
export function runnerStatusPrompt(model: SelfModel, online: boolean): string {
	if (online) {
		return "\n\n## Runner status: ONLINE — the local runner is connected, so the sessions below can reflect live activity.";
	}
	const remedy = model.hasRunner
		? ` If the user wants to run, search, or fix code, tell them to start the runner first with \`pags up\`${tabClause(model, "Coding", " (then use the Coding tab)")}.`
		: "";
	return (
		"\n\n## Runner status: OFFLINE — the local runner is NOT connected right now. Nothing is running;" +
		` the sessions below show only their LAST captured state.${remedy} Do not imply anything is happening live.`
	);
}

/** No session is running right now — where a new one is started, when the agent has anywhere to say. */
export function noActiveSessionPrompt(model: SelfModel): string {
	const where = tabClause(model, "Coding", " in the Coding tab");
	const runner = model.hasRunner ? " (the local runner must be online — `pags up`)" : "";
	return `\nNo active coding session right now. To work on a repo, start a session${where}${runner}.\n`;
}

/**
 * How to answer about repositories that are in the vector index.
 *
 * The "add it in the Repo tab" hint is the one from #255, now conditional. It fires on the
 * presence of `repoMember:` keys in the DO, which is not the same question as "does this agent
 * declare the repo surface" — an instance can hold indexed repos without it — so the hint has to
 * ask the tab set rather than assume.
 */
export function indexedReposPrompt(model: SelfModel): string {
	return (
		"\nAnswer about these repositories, grounded in the retrieved code above, and cite the repository + file path." +
		" If asked about code you can't find in your knowledge, say it isn't indexed yet" +
		`${tabClause(model, "Repo", " (suggest adding it in the Repo tab)")} rather than guessing.`
	);
}

/**
 * The STYLE block: four mutually exclusive branches, one per kind of agent.
 *
 * The branch order encodes a distinction that took three tickets to find. `guardrails.responseStyle
 * === "technical"` is NOT "is this Repo Chat" — `coder-repo` and `coder-lead` both seed it — so the
 * branch is chosen on `hasCodeIndex`, which only the `repo` surface has. Choosing on the string
 * handed every Repo Coder the read-only explainer's self-description ("You are READ-ONLY … you have
 * no ability to change code", plus a Repo tab), which is the strongest single cause of both #254's
 * denial and #255's invented tab.
 */
export function styleGuidance(opts: {
	model: SelfModel;
	/** The agent is talking to a developer (technical language + a grounding block). */
	codingContext: boolean;
	/** This instance actually has repositories attached right now. */
	hasCodingContext: boolean;
	/** The plain-speech, read-aloud voice (non-technical owner). */
	plainSpeech: boolean;
	/** Resolved length rule — the subscriber's `verbosity` band, or the default 2-sentence cap. */
	lengthRule: string;
}): string {
	const { model, codingContext, hasCodingContext, plainSpeech, lengthRule } = opts;

	if (codingContext && model.hasCodeIndex) {
		// Repo Chat genuinely HAS a vector index of the code (RAG context injected above), so
		// grounding answers in "the indexed code" is correct here.
		return (
			"\n\nSTYLE: You are a precise code explainer helping a developer understand a repository." +
			"\n- Be accurate and concrete. Reference real file paths, functions, and types from the indexed code above when relevant." +
			"\n- Ground every claim about how the code works in the retrieved context. If something isn't in your indexed knowledge," +
			` say you didn't find it${tabClause(model, "Repo", " (suggest adding the repo in the Repo tab)")} rather than guessing.` +
			readOnlyClause(model) +
			"\n- Lead with the plain-English answer (it may be read aloud), then add short code snippets or bullet points when they clarify."
		);
	}

	// `hasCodingContext` as well as the declaration: this branch has always been reached by "this
	// instance actually has repos", and an instance holding repos without declaring the surface
	// must keep the block that describes repos and terminals.
	if (codingContext && (hasCodingContext || model.surfaces.includes("coding"))) {
		// Coder has NO vector index — its code lives in live coding sessions, not RAG. Telling it to
		// reference "the indexed code" made it search an empty knowledge base and report the code
		// "isn't indexed / hasn't been populated", a hallucinated failure seen on a real Coder loop.
		//
		// The two "you do not drive the engine / that work runs in the Coding tab" lines that used to
		// close this block are gone (#254). What replaces them is `executionAuthorityPrompt`,
		// derived from whether this agent actually has an executor.
		return (
			"\n\nSTYLE: You are a precise code explainer helping a developer understand their repositories." +
			"\n- You do NOT have a searchable code index. Do not fabricate code findings. You read live coding sessions, not a vector code" +
			" index (that is the Repo Chat agent) — so if the user asks about indexing, just explain that plainly; never invent an indexing" +
			" status, and never retract a correct summary you already gave as if it were fabricated." +
			"\n- Base answers on the Attached Repositories and live terminal snapshots above, plus what your own tools return." +
			githubClause(model) +
			actionClause(model) +
			"\n- Lead with the plain-English answer (it may be read aloud), then add short code snippets or bullet points when they clarify."
		);
	}

	if (codingContext) {
		// Technical, but neither a code index nor a coding surface — the Coder Lead (which delegates
		// and writes no code) and Local Repo Chat (which reads a checkout through its own tools).
		// Both used to land in the Repo Chat branch purely because their seeded `responseStyle` is
		// "technical", and were told they were READ-ONLY explainers of "the indexed code" with a Repo
		// tab. All three claims are false for the Lead.
		return (
			"\n\nSTYLE: You are talking to a developer, so be concrete: cite real file paths, functions and short snippets when they help." +
			"\n- You do NOT have a searchable code index. Never claim code is or isn't indexed, and never invent an indexing status." +
			"\n- Everything you can do, you do by calling the tools listed above. If none of them can do what is asked, say so plainly rather than describing work you did not do." +
			"\n- Ground every claim in what a tool actually returned. Do not retract a report your own tool results support."
		);
	}

	if (plainSpeech) {
		// `!technical`, not a bare `else`: an agent with NO coding context whose owner asked for
		// technical language used to land here and be told "MAXIMUM 2 sentences, never mention
		// filenames or code" — the exact opposite of the setting.
		return (
			"\n\nSTYLE: You are speaking to a NON-TECHNICAL person. Your response will be READ ALOUD to them." +
			"\nRULES:" +
			`\n- ${lengthRule}` +
			"\n- Never mention filenames, paths, line numbers, git status, CSS classes, function names, or code." +
			"\n- Never repeat raw tool output. Summarize in plain English." +
			"\n- Say WHAT happened and WHETHER it needs anything from the user." +
			"\n- Only get technical if the user explicitly asks for details/code/files." +
			"\n- Good: 'You have 3 repos connected. Everything looks good.' Bad: 'I found repos pags/platform with modified files agent-capabilities.ts...'."
		);
	}

	return "";
}

/**
 * "file a GitHub issue with `github_create_issue`" — only for an agent that has the connector.
 *
 * The sentence exists because agents route around their own tools: the Coder ran `gh issue create`
 * in a terminal instead of calling the tool it had. But only the Repo Coder DECLARES the GitHub
 * connector; the legacy Coder and any other repo-holding instance do not, and were being told to
 * call a tool whose schema they are never shown. Naming an absent tool is the over-reporting half
 * of #254's failure, and the guard caught it on its first run.
 *
 * The generic fallback keeps the true half — use your tools, do not deflect — without naming one.
 */
function githubClause(model: SelfModel): string {
	if (!model.tools.has("github_create_issue")) {
		return (
			"\n- You CAN use your own tools directly from this chat. If one of them can do what is asked, call it — do NOT shell out to a" +
			" terminal and do NOT tell the user to run it themselves."
		);
	}
	return (
		"\n- You CAN use your own tools directly from this chat — e.g. file a GitHub issue with github_create_issue, or list/read issues" +
		" and CI status. If the user asks you to open/track an issue, just call the tool and do it (do NOT shell out to a terminal or" +
		" tell them to run `gh`)."
	);
}

/**
 * "You are READ-ONLY" — true of the code explainer, and of nothing else.
 *
 * Conditional because the assertion is exactly the #254 shape in its most damaging form: an agent
 * that CAN act, told in its own prompt that it cannot, believes the prompt over its tool results.
 * Repo Chat has no executor, no drive tools and nobody to delegate to, so for it the sentence is
 * simply true; anything else reaching this branch (an owner who set `responseStyle: "technical"` on
 * an agent that also has an executor) gets silence rather than a lie.
 */
function readOnlyClause(model: SelfModel): string {
	if (model.canStartWork || model.canDrive || model.canDelegate) return "";
	return "\n- You are READ-ONLY: you explain and analyze the repository, you never modify it and you have no ability to change code.";
}

/** What to do when asked to change code — the truthful answer for each kind of executor. */
function actionClause(model: SelfModel): string {
	if (model.canStartWork) {
		return (
			"\n- If asked to find, change, build, test or fix something in the code, that is what `start_work` is for: hand it the goal and" +
			" say you have started it. Do NOT deflect it back to the user, and do NOT tell them to do it in another tab — you have an" +
			" executor and they are asking you to use it."
		);
	}
	if (model.canDelegate) {
		// The Lead again (#318). It cannot type code, but "you cannot change code yourself" is read as
		// "nothing you do changes code", which is false for the only thing it exists to do.
		return "\n- If asked to change code, hand the goal to an agent you supervise with `delegate_goal` and report what the run reports back.";
	}
	if (model.canDrive) {
		return "\n- If asked to change code, steer the engine with `send_to_cli` and report what its terminal actually shows.";
	}
	return "\n- You cannot change code yourself. If asked to, say so plainly and offer to summarize what the current session is doing.";
}
