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
 * Which conversation to HOLD ON TO when the current one changes (#450).
 *
 * The store was singular, so leaving an agent replaced its snapshot with the destination's — and
 * with it went the "still working" pill and the one-tap route back. That was right for #278, which
 * is about the conversation you are IN. What made it wrong is #279: an agent can now move you off
 * one mid-run, hands-free, on your own request, and the pill was the thing telling you the run you
 * left is still going.
 *
 * So exactly ONE extra is kept, and only for the reason that justifies keeping it: the outgoing
 * conversation had work RUNNING. Two pills is the ceiling — current, plus the one you left
 * running. An idle conversation you walked away from is not information; that is the same
 * judgement `resolveConversationIndicator` already makes about a plain typed chat.
 *
 * PURE, and it returns the SAME reference when nothing changes. That is load-bearing rather than
 * tidy: `setConversation` is called from a render effect on every poll tick, and a fresh object
 * per tick would re-render the whole `Layout` for nothing.
 */
export function parkedOnSwitch(
	parked: ConversationSnapshot | null,
	leaving: ConversationSnapshot | null,
	arrivingId: string,
): ConversationSnapshot | null {
	// Leaving an agent mid-run: it becomes the one we hold. It replaces whatever was held before,
	// which is the ceiling being enforced — the newest still-running thing is the one you are
	// likeliest to want back, and three pills in a 40px bar is not a header.
	if (leaving && leaving.instanceId !== arrivingId && leaving.runActive) return leaving;
	// Arriving AT the held one retires it: it is the current conversation now, and two pills for
	// one agent is noise rather than information.
	return parked && parked.instanceId === arrivingId ? null : parked;
}

/**
 * The SECOND pill: the agent you left running (#450).
 *
 * Deliberately NOT `resolveConversationIndicator` with different arguments. That function's three
 * suppression rules are about the conversation you are in and must not move; this one has exactly
 * one rule of its own — `runActive`, the whole reason the entry was kept — plus the same "you are
 * on its page" suppression, because the instance header is already saying it there.
 *
 * The honest limit, stated because the pill would otherwise imply more than it knows: nothing
 * polls the agent you left, so `runActive` here is as fresh as the last tick before you moved. A
 * finished run keeps its pill until you tap it (arriving re-establishes the truth) or dismiss it.
 * That is the same staleness the single indicator has always had, not a new one — and the run
 * completing also raises a notification, which is the channel that does chase you.
 */
export function resolveParkedIndicator(
	parked: ConversationSnapshot | null | undefined,
	pathname: string,
): IndicatorView | null {
	if (!parked) return null;
	if (!parked.runActive) return null;
	if (isOnConversationRoute(pathname, parked.instanceId)) return null;
	return {
		label: parked.name,
		title: `${parked.name} is still working — tap to go back`,
		tone: "work",
		href: `/instances/${parked.instanceId}/chat`,
		// Same rule as the current pill: a click is the gesture iOS needs to reopen a mic, but
		// only into the mode the user chose. Resuming hands-free for a typist would open a live
		// mic they never asked for.
		resumeMode: parked.mode !== "text" ? parked.mode : null,
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
