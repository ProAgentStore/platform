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
