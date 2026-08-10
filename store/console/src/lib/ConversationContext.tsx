/**
 * The conversation, hoisted above the router (#278) — and the ONE way it changes (#277, #279).
 *
 * `InstanceDetail` owns the chat and the voice session, and it is keyed on the instance id, so a
 * switch unmounts it (#240 — deliberately: that keying is what stops one agent's board, forms and
 * draft message appearing under another's name). What is hoisted here is therefore the
 * conversation's IDENTITY and the intent to resume it, not the voice session itself:
 *
 *   - `conversation` — who you are talking to and what state it is in, so the top bar can show it
 *     and get you back from anywhere;
 *   - `handoff` — a one-shot baton the arriving page consumes: which voice mode to reopen in, and
 *     what to say out loud on arrival;
 *   - `parked` — the ONE agent you left with work still running (#450). Not a second
 *     conversation: the mic is not open there and never was after you left. It exists because
 *     replacing the snapshot wholesale DELETED the "still working" pill, which is the only thing
 *     saying a run you did not stop is still going — and #279 made leaving a busy agent routine.
 *
 * The baton is what makes "next" hands-free end to end. The mic genuinely CLOSES across the move
 * (the outgoing hook tears it down on unmount) and reopens on the other side; #279 asks whether
 * that is acceptable and answers itself — reopening with a spoken cue is simpler and more honest
 * than pretending at continuity, and the ANNOUNCEMENT is what the user actually needs. The
 * announcement is deliberately spoken by the agent you ARRIVE at rather than the one you leave:
 * the outgoing hook is about to be unmounted mid-sentence, so anything it says would be cut off.
 *
 * Keeping literal mic continuity would mean instantiating `useVoice` once at app level, which
 * #279 identifies as the real engineering and which nothing here forecloses: this provider is the
 * seam it would move behind.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { VoiceMode } from "@proagentstore/sdk/hooks";
import type { ConversationSnapshot } from "./conversation";
import { announceSwitch, nothingWaitingLine, parkedOnSwitch } from "./conversation";
import { pickNextConversation, type NotificationLike, type RosterEntry } from "./nextAgent";
import { backFromLine, noWayBackLine, resolveGoBack } from "./transfer";

/** The one-shot instruction the arriving instance page consumes. */
export interface ConversationHandoff {
	instanceId: string;
	/** Reopen the mic in this mode (null = arrive silent, e.g. the user was typing). */
	mode: VoiceMode | null;
	/** Say this on arrival. Empty = say nothing. */
	say: string;
}

interface ConversationState {
	conversation: ConversationSnapshot | null;
	/**
	 * The agent you left with work STILL RUNNING, if any (#450). A second pill, and nothing else:
	 * it is not "where you were" (that is `lastEngagedId`, which decides what "go back" and the
	 * `next` toggle mean and must keep meaning exactly that) — it is "what is still going".
	 */
	parked: ConversationSnapshot | null;
	/** The agent you were with BEFORE the current one — the toggle rule in `pickNextConversation`. */
	lastEngagedId: string | null;
	setConversation: (c: ConversationSnapshot) => void;
	/** The owning page unmounted: the mic is closed, but WHO you were talking to survives. */
	detachConversation: (instanceId: string) => void;
	clearConversation: () => void;
	/** Drop the second pill by hand — the way out of a run that finished while you were away. */
	dismissParked: () => void;
	beginHandoff: (h: ConversationHandoff) => void;
	/** Consume the baton if it is for this instance. One-shot, by construction. */
	takeHandoff: (instanceId: string) => ConversationHandoff | null;
}

const Ctx = createContext<ConversationState>({
	conversation: null,
	parked: null,
	lastEngagedId: null,
	setConversation: () => {},
	detachConversation: () => {},
	clearConversation: () => {},
	dismissParked: () => {},
	beginHandoff: () => {},
	takeHandoff: () => null,
});

export function ConversationProvider({ children }: { children: ReactNode }) {
	const [conversation, setConversationState] = useState<ConversationSnapshot | null>(null);
	const [parked, setParkedState] = useState<ConversationSnapshot | null>(null);
	const [lastEngagedId, setLastEngagedId] = useState<string | null>(null);
	// A ref, not state: the baton is read once during the arriving page's mount effect, and a
	// state round trip would let a re-render deliver it twice (re-announcing the switch).
	const handoffRef = useRef<ConversationHandoff | null>(null);

	const setConversation = useCallback((c: ConversationSnapshot) => {
		setConversationState((prev) => {
			// Moving to a different agent makes the previous one "last engaged" — which is what
			// lets a back-and-forth between two agents feel like toggling rather than cycling.
			if (prev && prev.instanceId !== c.instanceId) setLastEngagedId(prev.instanceId);
			// …and if it was still WORKING, it is held for a second pill (#450). Decided by a pure
			// function so it can be tested without a renderer, and so that "unchanged" is literally
			// the same reference — this runs on every poll tick.
			setParkedState((p) => parkedOnSwitch(p, prev, c.instanceId));
			// Identity-stable update: this is called from a render effect on every poll tick, and
			// a new object each time would re-render the whole Layout for nothing.
			if (
				prev &&
				prev.instanceId === c.instanceId &&
				prev.name === c.name &&
				prev.mode === c.mode &&
				prev.live === c.live &&
				prev.runActive === c.runActive
			) {
				return prev;
			}
			return c;
		});
	}, []);

	const detachConversation = useCallback((instanceId: string) => {
		setConversationState((prev) => (prev && prev.instanceId === instanceId ? { ...prev, live: false } : prev));
	}, []);

	const clearConversation = useCallback(() => setConversationState(null), []);

	const dismissParked = useCallback(() => setParkedState(null), []);

	const beginHandoff = useCallback((h: ConversationHandoff) => {
		handoffRef.current = h;
	}, []);

	const takeHandoff = useCallback((instanceId: string) => {
		const h = handoffRef.current;
		if (!h || h.instanceId !== instanceId) return null;
		handoffRef.current = null;
		return h;
	}, []);

	const value = useMemo(
		() => ({ conversation, parked, lastEngagedId, setConversation, detachConversation, clearConversation, dismissParked, beginHandoff, takeHandoff }),
		[conversation, parked, lastEngagedId, setConversation, detachConversation, clearConversation, dismissParked, beginHandoff, takeHandoff],
	);
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConversation() {
	return useContext(Ctx);
}

/**
 * The switch primitive: move the conversation to another agent, out loud.
 *
 * #277 ("next" — the user picks) and #279 (an agent hands you over) are two TRIGGERS for this one
 * move. Both must announce, both must carry the voice mode, both must leave the top bar telling
 * the truth — so they share this, and only differ in who chose the destination.
 */
export function useConversationSwitch() {
	const navigate = useNavigate();
	const { beginHandoff, lastEngagedId } = useConversation();

	/** Move to a KNOWN agent. `#279`'s agent-mediated transfer is this call with a destination
	 *  the agent supplied instead of one the user picked. */
	const switchTo = useCallback(
		(to: { instanceId: string; name: string }, opts: { mode?: VoiceMode | null; reason?: string; announce?: boolean } = {}) => {
			beginHandoff({
				instanceId: to.instanceId,
				mode: opts.mode ?? null,
				// Silent by default only when explicitly asked (a tap on the indicator, where the
				// user is looking at what they clicked). A voice-driven move always speaks.
				say: opts.announce === false ? "" : announceSwitch(to.name, opts.reason),
			});
			navigate(`/instances/${to.instanceId}/chat`);
		},
		[beginHandoff, navigate],
	);

	/**
	 * "next": find the agent asking for you and go there. Resolved on demand — two requests at
	 * the moment the command fires, rather than a background poll of every instance, so the
	 * feature costs nothing until it is used.
	 *
	 * Arriving marks that agent's notices READ. That is what makes repeated "next" walk the set
	 * instead of returning to the loudest agent forever, and it is honest: the agent wanted to
	 * reach you, and it just did.
	 *
	 * Returns `{ moved: false, say }` when it did NOT move — the ticket's "nothing waiting → say
	 * so and stay put". The line is returned rather than spoken here because the caller owns the
	 * voice session: staying put has to put the user back in the mode they were in, and speaking
	 * from inside this function would say it into a mic that is still torn down.
	 */
	const switchToNext = useCallback(
		async (from: { instanceId: string; name: string; mode: VoiceMode | null }): Promise<{ moved: boolean; say?: string }> => {
			let roster: RosterEntry[] = [];
			let notifications: NotificationLike[] = [];
			try {
				const [inst, notes] = await Promise.all([
					api<{ instances: RosterEntry[] }>("/v1/instances/my/instances"),
					api<{ notifications: NotificationLike[] }>("/v1/notifications?unread=true&limit=100"),
				]);
				roster = inst.instances ?? [];
				notifications = notes.notifications ?? [];
			} catch {
				// Say it rather than doing nothing: an unexplained non-response to a spoken command
				// is indistinguishable from a mic that stopped working.
				return { moved: false, say: "I couldn't check who needs you just now." };
			}

			const pick = pickNextConversation({ roster, notifications, currentId: from.instanceId, lastEngagedId });
			if (!pick) return { moved: false, say: nothingWaitingLine(from.name) };

			// Fire and forget: failing to clear a notice costs one repeat visit, whereas awaiting
			// it would put a round trip between the command and the move.
			for (const id of pick.notificationIds) {
				// IGNORABLE (#291): marking a notification read is a convenience, and its failure is
				// self-correcting — the bell badge re-polls, so an unread that failed to clear
				// simply reappears rather than misleading anyone. The user has already SEEN the
				// notification, which is the thing that mattered.
				void api(`/v1/notifications/${id}/read`, { method: "POST" }).catch(() => {});
			}
			switchTo(pick, { mode: from.mode, reason: pick.reason });
			return { moved: true };
		},
		[lastEngagedId, switchTo],
	);

	/**
	 * "go back": return to the agent you were with before this one (#279).
	 *
	 * The reversal of an agent-mediated transfer, and the reason shipping one is not shipping a
	 * one-way door — an agent hands you over, and in hands-free the only other way back is the
	 * screen, which is the failure this whole area exists to remove.
	 *
	 * Its own resolver rather than `switchToNext`'s, for the reason `resolveGoBack` states: `next`
	 * returns you to `lastEngagedId` only when that agent has an unread notification, and being
	 * transferred away does not raise one. Same `{moved, say}` contract, and for the same reason —
	 * staying put has to put the user back in the mode they were in before saying why.
	 */
	const switchBack = useCallback(
		async (from: { instanceId: string; name: string; mode: VoiceMode | null }): Promise<{ moved: boolean; say?: string }> => {
			// Cheap refusal first: with nowhere to go there is no reason to spend a request.
			if (!lastEngagedId) return { moved: false, say: noWayBackLine(from.name) };
			let roster: RosterEntry[] = [];
			try {
				roster = (await api<{ instances: RosterEntry[] }>("/v1/instances/my/instances")).instances ?? [];
			} catch {
				return { moved: false, say: "I couldn't check where you came from just now." };
			}
			const pick = resolveGoBack({ roster, lastEngagedId, currentId: from.instanceId });
			if (!pick) return { moved: false, say: noWayBackLine(from.name) };
			// `announce` is never passed: a transfer and its reversal both move the conversation
			// without the user touching anything, so the destination must always be spoken. The
			// silent form is for a tap on the indicator, where they are looking at what they clicked.
			switchTo(pick, { mode: from.mode, reason: backFromLine(from.name) });
			return { moved: true };
		},
		[lastEngagedId, switchTo],
	);

	return { switchTo, switchToNext, switchBack };
}
