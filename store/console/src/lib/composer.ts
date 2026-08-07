/**
 * What the message box says when it is empty.
 *
 * It is the only instruction for voice that is ALWAYS on screen. The mode control shows which of
 * the three modes is selected; it does not say what to do next, and in tap-to-talk and hands-free
 * "what to do next" is the entire interaction — nothing else tells you the chat area is the tap
 * target, or that a hands-free mic is open and waiting rather than idle.
 *
 * It was a six-branch nested ternary inside a JSX attribute, on one line, which is why the order
 * below is worth stating: `talking` OUTRANKS the mode. A recording in progress is a fact about
 * right now ("tap again and this goes"), and it happens in both voice modes, so a mode-first
 * chain would have shown "Hands-free — just talk" to someone mid-sentence.
 */
export interface ComposerState {
	/** A recording is open and will be sent on the next tap. */
	talking: boolean;
	mode: "text" | "ptt" | "handsfree" | string;
	/** The mic is live (hands-free between turns). */
	micOn: boolean;
	/** This agent works on repositories — ask it about those. */
	isCoding: boolean;
	/** This agent drives tmux sessions. */
	isTmux: boolean;
}

export function composerPlaceholder({ talking, mode, micOn, isCoding, isTmux }: ComposerState): string {
	if (talking) return "Listening — tap to send";
	if (mode === "ptt") return "Use the voice control to talk — or type";
	if (mode === "handsfree") return micOn ? "Listening…" : "Hands-free — just talk";
	if (isCoding) return "Ask about your repos...";
	if (isTmux) return "Ask about tmux sessions...";
	return "Send a message...";
}

/** Is the message box on screen at all? */
export interface ComposerVisibility {
	mode: "text" | "ptt" | "handsfree" | string;
	/** What the user has typed — or what was recovered into the box without them typing it. */
	draft: string;
	/** The transient notice line: mic errors, the wrong-language warning. */
	notice: string;
}

/**
 * Whether the message box is on screen (#365).
 *
 * The ask was "move text entry to the bottom, as all messaging apps do, and only show it in text
 * mode". The first clause is the point of the whole change: the live dictation bubble is already
 * the LAST child of the thread, so inverting thread and composer puts the words being spoken
 * directly above the box, and leaves exactly one surface showing them instead of two.
 *
 * The second clause cannot be taken literally, because **the composer is not only an input**. Two
 * mechanisms write into it without the user touching a key, and both of them fire in the voice
 * modes by construction:
 *
 *  - A turn the guard classifies as `recover` (#175, `classifyResult`). It transcribed fine, but
 *    the conversation moved on while it was in flight, so it is deliberately NOT sent — it lands
 *    in the box for the user to see, edit and send. A literal `mode === "text"` would delete those
 *    words at the instant they arrive, silently, which is the exact failure #175 exists to prevent.
 *  - The notice line (#364): a mic error, or the wrong-language warning. With the box gone in the
 *    voice modes those have no surface at all — worse than the confusion they cause today.
 *
 * So: always in text mode, and in a voice mode exactly when the box HAS something. It can never
 * sit there empty during a voice session, and it can never swallow anything either. The one thing
 * knowingly given up is starting to type mid-voice-session; the route to that is one tap on the
 * mode control, which stays visible in every mode.
 */
export function shouldShowComposer({ mode, draft, notice }: ComposerVisibility): boolean {
	if (mode === "text") return true;
	return draft.trim() !== "" || notice.trim() !== "";
}
