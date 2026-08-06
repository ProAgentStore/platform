/**
 * The conversation you are IN, as something the whole app can see (#278) — and what the top bar
 * should say about it.
 *
 * Today the conversation is a property of the PAGE: `InstanceDetail` owns the chat, the voice
 * session and the mode, so navigating to Usage or Terminals leaves nothing anywhere saying "you
 * are mid-conversation with FWS platform". That is tolerable when you type and wrong when you do
 * not: the way back is to remember which of a dozen agents it was and navigate the instance list.
 *
 * The decisions live here, pure, for the same reason the voice guards do — an indicator that
 * re-derived "is this live?" in the pill, the router and the switcher would eventually claim the
 * mic is open when it is closed, which is a privacy bug rather than a cosmetic one.
 */

import type { VoiceMode } from "@proagentstore/sdk/hooks";

/** The conversation, as the app-level store holds it. */
export interface ConversationSnapshot {
	instanceId: string;
	name: string;
	/** Identity mark from `identityFor` — the same one the instances list and the instance
	 *  header use, so the pill is recognisably the thing you clicked. */
	emoji: string;
	bg: string;
	/** How you were interacting when the page last reported in. */
	mode: VoiceMode;
	/**
	 * Is the page that OWNS the voice session still mounted?
	 *
	 * The honest answer to #278's "does navigating away keep the mic open?" is NO, and this
	 * field is what keeps the indicator from lying about it: `useVoice` tears the recognizer,
	 * the mic stream and the TTS down on unmount, so the moment you leave the page the mic is
	 * closed, whatever mode you were in. The pill therefore says "paused", never "listening".
	 */
	live: boolean;
	/** Work still running server-side (a chat turn or a loop run, #252). This is why the
	 *  indicator is also the honest answer to "is something still happening?" from anywhere. */
	runActive: boolean;
}

/** Are we looking at this conversation's own page right now? */
export function isOnConversationRoute(pathname: string, instanceId: string): boolean {
	return pathname.startsWith(`/instances/${instanceId}`);
}

/** What the top bar shows. `null` = show nothing, and the bar is unchanged. */
export interface IndicatorView {
	label: string;
	/** Tooltip / aria-label — the full sentence, since the label is a name (or nothing on mobile). */
	title: string;
	/** `work` = something is still running (accent); `idle` = the conversation is parked. */
	tone: "work" | "idle";
	/** Where clicking goes. */
	href: string;
	/** Resume this voice mode on arrival — a click is a user gesture, which is exactly what
	 *  iOS needs to reopen the mic and prime TTS, so returning by hand can restore hands-free. */
	resumeMode: VoiceMode | null;
}

/**
 * Resolve the persistent conversation indicator.
 *
 * Three things suppress it, each for its own reason:
 *   - no conversation at all — the bar is unchanged, as the ticket requires;
 *   - you are ON that agent's page — the instance header already shows its name and state, and
 *     a second copy in the same 40px bar is noise on a phone;
 *   - the conversation was plain typing with nothing running — there is nothing to get back TO,
 *     and a pill for every chat you have ever opened would train people to ignore it.
 */
export function resolveConversationIndicator(
	conversation: ConversationSnapshot | null | undefined,
	pathname: string,
): IndicatorView | null {
	if (!conversation) return null;
	if (isOnConversationRoute(pathname, conversation.instanceId)) return null;
	const voiceEngaged = conversation.mode !== "text";
	if (!voiceEngaged && !conversation.runActive) return null;

	const href = `/instances/${conversation.instanceId}/chat`;
	// A click is a gesture, so it can reopen the mic — but only into the mode the user actually
	// chose. Resuming hands-free for someone who was typing would open a live mic they never
	// asked for, which is the privacy surprise the ticket names.
	const resumeMode = voiceEngaged ? conversation.mode : null;

	if (conversation.runActive) {
		return {
			label: conversation.name,
			title: `${conversation.name} is still working — tap to go back`,
			tone: "work",
			href,
			resumeMode,
		};
	}
	// Voice, but the page that owned the mic is gone. Say so plainly: the user may have walked
	// away mid-sentence, and "listening" here would be a lie about a microphone.
	return {
		label: conversation.name,
		title: conversation.live
			? `In conversation with ${conversation.name} — tap to go back`
			: `Mic paused — tap to return to ${conversation.name}`,
		tone: "idle",
		href,
		resumeMode,
	};
}

/**
 * What to SAY when the conversation moves (#277).
 *
 * The one requirement that makes voice-switching safe: in hands-free the user is not looking, so
 * a silent switch means their next sentence goes to an agent they did not know they were talking
 * to. The reason is the notification's own title, spoken verbatim — the platform already wrote
 * that sentence for a human to read, and re-classifying it here would be a heuristic with
 * nothing to gain.
 */
export function announceSwitch(name: string, reason?: string): string {
	const why = (reason ?? "").trim();
	return why ? `Switching to ${name}. ${why}` : `Switching to ${name}.`;
}

/** …and what to say when nothing is waiting. Staying put is the answer; saying so is what
 *  stops it looking like the command was not heard. */
export function nothingWaitingLine(currentName?: string): string {
	return currentName ? `Nothing is waiting. Still with ${currentName}.` : "Nothing is waiting for you.";
}
