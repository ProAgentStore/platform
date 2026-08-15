/**
 * What the Coding tab says when the runner reads offline (#537).
 *
 * ── The instruction that was false
 *
 * The banner had one input — `runnerOnline` from ./runner-online — and rendered the only remedy a
 * boolean can carry: *"Your machine isn't connected. Start the runner: `pags up`."* With machine A
 * off and machine B running `pags up`, every reading behind that boolean was truthful and the
 * sentence was not: the SESSION is stamped to A, so `/capture` correctly says offline, and the
 * owner reading the banner is sitting at B with the runner running.
 *
 * Same family as #530 (the chat prompt), #524 (a remedy naming no machine) and #531 (a tile
 * claiming attachment it never verified). The resolution is the same one those landed on: the
 * SERVER composes the sentence — it is the only side that knows the session's machine, which
 * machine holds a live socket, whether a pin excludes it, and whether two names are one machine
 * (#379) — and the console renders it verbatim. Exactly what `staleListNotice` (#440) already does
 * for the repo list.
 *
 * This module is the choosing, not the wording: which of the two diagnoses on hand answers the
 * question the banner is asking, and what to do when neither has arrived.
 */

/** `{state, message, remedy}` as `/runtime/status` and `/capture` both return it. */
export interface AttachmentAnswer {
	state?: string;
	message?: string;
	remedy?: string | null;
}

export interface RunnerNotice {
	/** Rendered verbatim. Never assembled from fragments here — see the module note. */
	text: string;
	/** The one command that fixes it, when the server says one exists. Rendered as a code block. */
	command?: string;
}

export interface OfflineNoticeSignals {
	/** ./runner-online's answer. `null` = no reading yet, `true` = fine — neither shows a banner. */
	runnerOnline: boolean | null;
	/** From the last `/capture` that reported `runnerConnected: false`. Session-scoped. */
	sessionAttachment?: AttachmentAnswer | null;
	/** From `/runtime/status`. Instance-scoped, and the only one available with no session. */
	relayAttachment?: AttachmentAnswer | null;
}

/**
 * The sentence for the offline banner, or null when there is nothing to say.
 *
 * The session diagnosis wins where both exist, and that is the same priority `resolveRunnerOnline`
 * uses to decide the boolean in the first place: a live session's capture outranks the relay,
 * because the user's next action goes through that session. Explaining the verdict with the OTHER
 * reading is how a banner ends up contradicting itself.
 *
 * The fallback keeps the pre-#537 wording, deliberately. It is reached when the API has not
 * answered yet or is older than this change, and in that state the honest thing is the sentence
 * that was there before rather than a guess assembled client-side.
 */
export function runnerOfflineNotice(s: OfflineNoticeSignals): RunnerNotice | null {
	if (s.runnerOnline !== false) return null;
	const answer = pick(s.sessionAttachment) ?? pick(s.relayAttachment);
	if (!answer) return { text: "Your machine isn't connected. Start the runner:", command: "pags up" };
	return { text: answer.message ?? "", command: (answer.remedy ?? "").trim() || undefined };
}

/**
 * The same notice as ONE line of prose, for a place that cannot render a code block — a `title`
 * attribute, an aria label.
 *
 * The command must survive the flattening: dropping it would turn "the runner isn't running / `pags
 * up`" into a diagnosis with no remedy, which is the opposite failure to the one #537 is about.
 */
export function noticeSentence(n: RunnerNotice | null | undefined): string {
	if (!n) return "";
	const text = n.text.trim();
	if (!n.command) return text;
	// A server sentence is a complete one and gets an instruction after it; the local fallback ends
	// in a colon because it introduces a code block, and "Start the runner: Run `pags up`." is not
	// a sentence anyone wrote on purpose.
	return text.endsWith(":") ? `${text} \`${n.command}\`` : `${text} Run \`${n.command}\`.`;
}

/** An answer is only usable if it carries a sentence — an empty message renders an empty banner. */
function pick(a: AttachmentAnswer | null | undefined): AttachmentAnswer | null {
	return a && (a.message ?? "").trim() ? a : null;
}
