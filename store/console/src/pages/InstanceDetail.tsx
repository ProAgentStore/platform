import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, API, getToken } from "@proagentstore/sdk/client";
import type { Instance, Message, RunnerPresence } from "../lib/types";
import { identityFor } from "../lib/identity";
import { mergeOlderMessages, nextOlderCursor, resolveHasMore, type MessagePageResponse } from "../lib/messagePaging";
import { classifyMessage, messageKey, toolCallSummary } from "@proagentstore/sdk/ui";
import Button from "../components/Button";
import ErrorBoundary from "../components/ErrorBoundary";
import { renderMd, formatDateTime } from "@proagentstore/sdk/ui";
import { SafeHtmlView } from "@proagentstore/sdk/ui-react";
import PlaybackIcon from "../components/PlaybackIcon";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { useVoice, buildTranscribePrompt, resolveVoiceStatus, resolveComposer } from "@proagentstore/sdk/hooks";
import { Copy, Trash2, Mic, MicOff, Volume2, MessageSquare, Headphones, Send, ArrowLeft, Repeat, Square, Wrench, MoreVertical, Loader2, ChevronDown } from "lucide-react";
import { useHideNav, useHeaderSlot } from "../lib/HeaderContext";
import { useConversation, useConversationSwitch } from "../lib/ConversationContext";
import { parseChatTransfer, type ChatTransfer } from "../lib/transfer";
import { SURFACES, visibleSurfaces, surfaceOwnsHeader } from "../lib/surfaces";
import { useGloss } from "../lib/use-gloss";
import type { LoopPreset } from "../lib/loopPresets";
import { adoptableRun, isChatWorking, shouldAdopt, type InstanceStateLike, type LoopRunLike } from "../lib/workInFlight";
import DynamicSurface from "../components/DynamicSurface";
import HostedNode from "../components/HostedNode";
import GlossedMessage from "../components/GlossedMessage";
import SpokenMessage from "../components/SpokenMessage";
import SystemMessage from "../components/SystemMessage";
import MessageActions from "../components/MessageActions";
import FabricatedNotice from "../components/FabricatedNotice";
import McpInputRequests from "../components/McpInputRequests";
import { useScrapLastTurn } from "../lib/deleteTurn";
import { isPinnedToBottom, shouldScrollAfterLoad } from "../lib/chatScroll";
import { resolveInstanceRoute } from "../lib/instanceRoute";
import { loopCompletionNotice, loopStartFailureNotice, loopStartNotice } from "../lib/loopNotices";
import { loopStopControl, STOPPING_HINT, type LoopPhase } from "../lib/loopStopState";
import { chatExportPayload } from "../lib/chatExport";
import { composerPlaceholder, shouldShowComposer } from "../lib/composer";
import { stampTitle } from "../lib/messageStamp";
import { useAccountTimeZone } from "../lib/accountTimezone";

// A built-in SurfaceId or a custom (agent-published) surface id.
type Tab = string;

/**
 * The chat header's Loop/Stop button, per phase. A lookup, not a decision — `loopStopControl`
 * already made the decision; this only spells out what live and settling look like. `ended` never
 * renders (the button becomes the Loop starter there) but the record must be total.
 */
const LOOP_BUTTON_CLASS: Record<LoopPhase, string> = {
	running: "border-success bg-success-soft text-success",
	// Yellow, not orange: `index.css` `@theme` declares no `--color-orange`, so an orange utility
	// compiles to nothing and the chip renders unstyled (the class #368 fixed elsewhere).
	stopping: "border-warning bg-warning-soft text-warning",
	ended: "border-line text-muted",
};

/**
 * The iteration counter riding on that button, kept in step with it. A green badge on a yellow
 * button is the two-statements-about-one-fact problem `lib/runnerPanel.ts` was written to end.
 */
const LOOP_BADGE_CLASS: Record<LoopPhase, string> = {
	running: "bg-success text-white",
	stopping: "bg-warning text-paper",
	ended: "bg-muted text-white",
};

/**
 * One mounted page per instance (#240).
 *
 * `/instances/:id/*` is a single route, so ANY navigation that only changes the id keeps the same
 * mounted component — React reuses it and every `useState` in it (and in every tab below it)
 * survives. Each tab's `useEffect([instanceId])` refetches, but nothing guards the window in
 * between and nothing cancels the previous instance's in-flight request, so agent A's documents,
 * board cards and — the part that matters — POPULATED FORM FIELDS would stay on screen under
 * agent B's name. A save then builds its URL from the current `instanceId` and writes A's values
 * to B, with nothing in the flow able to notice.
 *
 * Today every route INTO this page comes from a different route (the instances list, a
 * notification, Terminals), which remounts it — so the leak is latent rather than reachable. It
 * becomes reachable the moment anything navigates instance→instance: an agent switcher in the
 * header, a "next agent" link, a deep link followed from within the page.
 *
 * Keying on the id makes the identity of the page the identity of the agent: a switch unmounts
 * everything and mounts it fresh. That is deliberately done HERE rather than on each surface, so
 * a new tab inherits the guarantee instead of having to remember it — and because the leak was
 * never only in the tabs: the loop banner, the draft chat input, the voice session and the
 * message list all belong to one agent too.
 *
 * A late response for the previous instance now lands on an unmounted tree (a no-op in React 18+)
 * rather than overwriting the successor's state, which also closes the out-of-order-fetch race.
 */
export default function InstanceDetail() {
	const { id } = useParams<{ id: string }>();
	return <InstancePage key={id || "none"} />;
}

function InstancePage() {
	const { id, "*": splat } = useParams<{ id: string; "*": string }>();
	const navigate = useNavigate();
	// The owner's own zone when they set one (#345) — the hover text on every message stamp.
	const timeZone = useAccountTimeZone();
	const [instance, setInstance] = useState<Instance | null>(null);
	const surfaces = instance?.capabilities?.surfaces || [];
	// Tabs are gated on the whole DECLARED set, not just surfaces: some are about what the agent
	// can DO (knowledge tools → Indexing, collection tools → Data). An agent that declares no tool
	// allowlist stays permissive. See SurfaceCaps in lib/surfaces.
	const declaredTools = instance?.capabilities?.tools;
	// Keyed on CONTENT, not identity. `surfaces` above is `… || []`, which mints a fresh array on
	// every render whenever the capability is absent — so an identity-keyed memo here is never a
	// memo at all. That churn reaches the injected header: `tabDefs` and the header memo below both
	// re-derive every render, the instance tab bar is replaced continuously, and a click on a tab
	// lands on a node that no longer exists — the tabs render but do not switch (#309).
	// A biome-ignore covers only the line that FOLLOWS it, so the reason has to fit on one line —
	// this one sat two prose lines up, suppressed a COMMENT, and let the findings it answers back
	// through unseen (#326). InstanceDetail.test.ts holds both memos to that shape.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the deps ARE these values — joining is what makes the comparison by-value, and taking the lint's suggestion is what broke #309.
	const surfaceCaps = useMemo(() => ({ surfaces, tools: declaredTools }), [surfaces.join(","), declaredTools?.join(",")]);
	// Phase 3: agent-published UIs, loaded dynamically (see DynamicSurface).
	const customSurfaces = instance?.capabilities?.customSurfaces || [];

	// Tab + session from URL — always sync with the route. Gated against the surfaces THIS
	// instance actually exposes (built-in + custom), so a deep link like /coding on a non-coding
	// agent falls back to chat instead of mounting a broken tab. The parse itself is positional
	// (`<tab>/<sessionId>`, anything further dropped) and lives in lib/instanceRoute.ts, where a
	// test can hold it against the grammar lib/routes.ts uses to police the links Workers emit —
	// that grammar was a claim about this component that nothing executed (#344).
	const { tab: resolvedTab, sessionId: urlSessionId } = resolveInstanceRoute(splat, [
		...visibleSurfaces(surfaceCaps).map((s) => s.id),
		...customSurfaces.map((c) => c.id),
	]);
	const tab: Tab = resolvedTab;
	const setTab = useCallback((t: Tab) => {
		navigate(`/instances/${id}/${t}`, { replace: true });
	}, [id, navigate]);
	const [messages, setMessages] = useState<Message[]>([]);
	const [hasMore, setHasMore] = useState(false);
	// The server's opaque cursor for the next OLDER page (#428). Never derived from a message
	// field here — the previous cursor was `oldest.id`, a UUID, which the DO's `msg:{createdAt}:
	// {id}` ordering could never seek with, so every "load older" re-served the newest page.
	const [olderCursor, setOlderCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [input, setInput] = useState("");
	const [thinking, setThinking] = useState(false);
	// Work this tab did NOT start (or started before a remount) — a chat turn still running in
	// the DO, read from the server every few seconds (#252). `thinking` above is local by
	// nature: it dies with the component, which is exactly why coming back looked idle.
	const [remoteWork, setRemoteWork] = useState(false);
	const chatRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	// Smart auto-scroll (#132): auto-scroll to the newest message ONLY while the user is at the
	// bottom. The moment they scroll up, auto-scroll pauses and a jump-to-bottom button appears
	// (even behind the voice pill). A ref mirrors the state so the message effects read it live
	// without a dependency (appending a message doesn't fire onScroll, so it stays accurate).
	const [atBottom, setAtBottom] = useState(true);
	const atBottomRef = useRef(true);
	atBottomRef.current = atBottom;
	const scrollChatToBottom = () => {
		const el = chatRef.current;
		if (el) { el.scrollTop = el.scrollHeight; setAtBottom(true); }
	};
	const PAGE = 20;

	// Runtime status
	const [runnerOnline, setRunnerOnline] = useState<boolean | null>(null);
	const [runnerNode, setRunnerNode] = useState("");
	// WHY it isn't attached, computed server-side (#237). The dot could only ever be a colour; a
	// surface that renders an offline state needs the reason and the remedy — and `pags up` is the
	// wrong advice for one of the three cases (#378).
	const [runnerAttachment, setRunnerAttachment] = useState<RunnerPresence["attachment"]>(null);

	// Agent loop state
	const [loopOn, setLoopOn] = useState(false);
	const [loopObjective, setLoopObjective] = useState("");
	const [loopIteration, setLoopIteration] = useState(0);
	const [loopMax, setLoopMax] = useState(10);
	const [loopPaused, setLoopPaused] = useState(false);
	// #158: the loop now runs on the SERVER (AgentLoopWorkflow). This is the run we are watching,
	// not a loop we are driving — closing this tab no longer kills the objective.
	const [loopRunId, setLoopRunId] = useState<string | null>(null);
	// A stop the server has accepted but the run has not reached yet (#376). Read from the run
	// itself, not remembered from the press, so a tab that never pressed Stop — or one reopened
	// afterwards — shows the same pending state as the one that did.
	const [loopCancelPending, setLoopCancelPending] = useState(false);
	const [showLoopForm, setShowLoopForm] = useState(false);
	// The agent's loop presets (#234). Fetched when the form first opens rather than on mount —
	// most visits to a chat never press Loop, and this is a request that would be wasted on them.
	const [loopPresets, setLoopPresets] = useState<LoopPreset[]>([]);
	const loopPresetsLoaded = useRef(false);
	// Overflow menu for the less-frequent chat actions (Copy JSON, Clear) — keeps the
	// controls bar focused on voice, and moves the destructive Clear behind a tap.
	const [showChatMenu, setShowChatMenu] = useState(false);
	const loopOnRef = useRef(false);
	/** Which driver the running loop dispatched to — decides who writes the completion notice. */
	const loopDriverRef = useRef<string | null>(null);
	/** True when this tab is watching a run it did NOT start (adopted on mount, #252). */
	const loopAdoptedRef = useRef(false);
	const loopPausedRef = useRef(false);
	loopOnRef.current = loopOn;
	loopPausedRef.current = loopPaused;
	// Stop the self-continuing loop on unmount — otherwise a mid-loop navigation keeps
	// the continueLoop chain firing chat rounds + setState on a dead component.
	useEffect(() => () => { loopOnRef.current = false; loopPausedRef.current = true; }, []);

	// The conversation, as the whole app sees it (#277/#278). Read here so this page can report
	// who you are talking to, and so "next" has one switch primitive to go through.
	const { setConversation, detachConversation, takeHandoff } = useConversation();
	const { switchTo, switchToNext, switchBack } = useConversationSwitch();
	// The name is read from a callback that runs long after the render that built it, and the
	// instance loads asynchronously — so the announcement gets the live name, not "".
	const instanceNameRef = useRef("");

	// Voice: both push-to-talk and conversation mode auto-send via this ref
	const doSendRef = useRef<(text: string, meta?: { audioKey?: string; dictation?: string; suspect?: boolean }) => void>(() => {});
	/** "scrap that" (#342). Same indirection as `voiceRef` below and for the same reason: the
	 *  handler needs the thread and the delete callback, both defined further down. */
	const scrapRef = useRef<() => void>(() => {});
	const voice = useVoice(id, {
		onSend: (text, meta) => doSendRef.current(text, meta),
		/**
		 * "scrap that" (#342) — the transcript surface is the only place that can delete a turn,
		 * so passing this handler is what turns the word on here and leaves it ordinary speech
		 * everywhere else. It STAGES: the confirmation quotes the turn before anything goes.
		 */
		onScrap: () => scrapRef.current(),
		/**
		 * "next" (#277) — move to the agent asking for you, without touching the screen.
		 *
		 * Passing this handler is also what TURNS THE COMMAND ON (see `useVoice`'s `onNext`):
		 * this is the only surface in the app that can change which agent you are talking to,
		 * so everywhere else "next" stays an ordinary word. By the time it fires the voice
		 * session here is already torn down, and `carryMode` is the mode to reopen on the far
		 * side — passed through the handoff baton so hands-free survives the move.
		 */
		onNext: ({ carryMode }) => {
			if (!id) return;
			void (async () => {
				const r = await switchToNext({ instanceId: id, name: instanceNameRef.current || "this agent", mode: carryMode });
				if (r.moved) return; // the announcement is spoken on ARRIVAL — see the handoff effect
				// Staying put has to mean staying put. The switch guard tore the session down
				// before we knew whether there was anywhere to go (it must — a hands-free mic left
				// open across the lookup would capture speech destined for nobody), so put the user
				// back in the mode they were in before saying why nothing happened.
				if (carryMode && carryMode !== "text") await voiceRef.current.setVoiceMode(carryMode);
				if (r.say) await voiceRef.current.speak(r.say);
			})();
		},
		/**
		 * "go back" (#279) — the reversal of an agent-mediated transfer.
		 *
		 * Same shape as `onNext`, and passed here for the same reason: this is the only surface
		 * that can change which agent you are talking to, so everywhere else the words stay
		 * ordinary speech. Shipped WITH the transfer deliberately — an agent that can move you,
		 * with no way back, is a one-way door, and in hands-free the only alternative way back is
		 * the screen.
		 */
		onBack: ({ carryMode }) => {
			if (!id) return;
			void (async () => {
				const r = await switchBack({ instanceId: id, name: instanceNameRef.current || "this agent", mode: carryMode });
				if (r.moved) return;
				if (carryMode && carryMode !== "text") await voiceRef.current.setVoiceMode(carryMode);
				if (r.say) await voiceRef.current.speak(r.say);
			})();
		},
		// #175: a turn spoken while the agent was replying used to be transcribed and then
		// silently dropped. It lands in the composer instead — the user can see their words
		// survived and press send, rather than having them fired into a thread that moved on.
		onRecoveredText: (text) => {
			setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
			requestAnimationFrame(() => inputRef.current?.focus());
		},
		// Bias transcription toward this agent's vocabulary so domain words aren't
		// mis-heard (a coding agent should expect "bugs", not "bars").
		transcribePrompt: buildTranscribePrompt(surfaces, instance?.name ? [instance.name] : [], { runtime: instance?.capabilities?.runtime }),
		// A code explainer (repo/coding) speaks ABOUT code — keep identifiers + file
		// basenames in the spoken reply instead of gutting them to "a file … a file".
		technical: surfaces.includes("repo") || surfaces.includes("coding") || surfaces.includes("tmux"),
	});
	// `onNext` above is defined inside the very expression that initialises `voice`, so it cannot
	// name it directly; and the arrival effect below is mount-only, so it would close over the
	// first render's hook. Both reach the live one through this.
	const voiceRef = useRef(voice);
	voiceRef.current = voice;

	// Auto-grow the chat input so a long typed message is readable as it grows, instead of
	// truncating to one line (#164). Caps at ~40vh, then scrolls. It used to also grow for the
	// live transcript; speech is not in this box any more (#364), so the draft is the only input.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `input` is a trigger, not an input — the effect must re-run as the draft changes so the box keeps growing.
	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [input]);

	useEffect(() => {
		if (!id) return;
		let live = true;
		setInstance(null);
		setMessages([]);
		setChildHeader(null);
		(async () => {
			try {
				const data = await api<{ instances: Instance[] }>("/v1/instances/my/instances");
				const inst = (data.instances || []).find((i) => i.id === id || i.slug === id);
				// Belt and braces with the remount above: a response that outlives its effect must
				// never write. The capabilities this sets decide which tabs render, so landing one
				// from a previous agent is exactly the wrong-agent-on-screen bug (#240).
				if (inst && live) {
					setInstance(inst);
				}
			} catch (e) {
				console.error(e);
			}
		})();
		return () => { live = false; };
	}, [id]); // eslint-disable-line react-hooks/exhaustive-deps

	// ── The conversation, reported UP so the app can show it from anywhere (#278) ──────────
	//
	// This page owns the chat and the voice session, and it is keyed on the instance id, so it
	// unmounts on every switch. What it publishes here is the identity + state of the
	// conversation, which has to outlive it: the top bar renders from this, and "next" reads
	// `lastEngagedId` off it to decide whether a switch is a toggle or a walk.
	instanceNameRef.current = instance?.name ?? "";
	const runActive = thinking || remoteWork || !!loopRunId;
	useEffect(() => {
		if (!id || !instance) return;
		const ident = identityFor(instance);
		setConversation({
			instanceId: id,
			name: instance.name,
			emoji: ident.emoji,
			bg: ident.bg,
			mode: voice.mode,
			live: true,
			runActive,
		});
	}, [id, instance, voice.mode, runActive, setConversation]);
	// Unmount = the mic is CLOSED, whatever mode we were in: `useVoice` tears the recognizer,
	// the stream and the TTS down. Say so rather than clearing the conversation — who you were
	// talking to is exactly what you need to get back, and an indicator that claimed to be
	// listening here would be lying about a microphone.
	useEffect(() => {
		if (!id) return;
		return () => detachConversation(id);
	}, [id, detachConversation]);

	/**
	 * Arrival: consume the handoff baton (#277).
	 *
	 * The mic genuinely closed on the way out and is reopened here — #279's "reopen with a
	 * spoken cue" answer. Order matters: the mode first, so the session (and its echo guard)
	 * exists before the announcement plays; then the announcement, whose `speak` pauses the mic
	 * for its own duration and reopens it after. Announcing from the OUTGOING page instead would
	 * be cut off mid-sentence by its own unmount.
	 *
	 * Runs once per mounted instance page — the component is keyed on the id (#240), and
	 * `takeHandoff` is one-shot besides.
	 */
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only by design — a re-run would re-announce a switch that already happened.
	useEffect(() => {
		if (!id) return;
		const h = takeHandoff(id);
		if (!h) return;
		void (async () => {
			if (h.mode && h.mode !== "text") await voiceRef.current.setVoiceMode(h.mode);
			if (h.say) await voiceRef.current.speak(h.say);
		})();
	}, [id]);

	// Under-message translation + transliteration (the learning display) — see lib/use-gloss.
	const gloss = useGloss(id, tab, messages);
	// Ref mirror so doSend (stable callback) always calls the live glossReply.
	const glossReplyRef = useRef(gloss.glossReply);
	glossReplyRef.current = gloss.glossReply;

	// Only agents with a local runner (capabilities.runtime: browser/coding) have a
	// meaningful connection status — for chat-only agents the dot was permanent grey
	// noise, so it's hidden and its 4s polling skipped entirely.
	const hasRuntime = !!instance?.capabilities?.runtime;

	// Poll runtime status
	const checkRuntime = useCallback(async () => {
		if (!id || !hasRuntime) return;
		try {
			// The route answers `{runtime, health, capabilities, relay:{connected, runnerNode}}` —
			// there is no top-level `connected` or `node`. Reading those fell through to
			// `!!d.runtime`, which is true whenever a runtime row has EVER existed, so the header
			// dot read "Runner online" forever after the first `pags up` — and the 4s poll kept
			// re-confirming it while every runner-backed action failed. (A missing socket is a 503
			// from the relay DO, not a throw, so the route still answers 200.) The node name came
			// from snake_case `runner_node`, but the response is camelCase, so it was always blank.
			// SettingsTab fixed exactly this; the header was never updated.
			const d = await api<{
				runtime?: { runnerNode?: string | null };
				relay?: { connected?: boolean; runnerNode?: string | null };
				attachment?: RunnerPresence["attachment"];
			}>(`/v1/instances/${id}/runtime/status`);
			setRunnerOnline(d.relay?.connected === true);
			setRunnerNode(d.relay?.runnerNode || d.runtime?.runnerNode || "");
			setRunnerAttachment(d.attachment ?? null);
		} catch {
			setRunnerOnline(false);
			// A failed probe is not a diagnosis. Keeping the previous reason would let a stale
			// "another runner may already hold this agent" outlive the state it described.
			setRunnerAttachment(null);
		}
	}, [id, hasRuntime]);

	useEffect(() => { checkRuntime(); }, [checkRuntime]);
	// The header's runner dot (CODER-005). This is the single most expensive poll in the console
	// per request — `/runtime/status` does two relay `/command` round-trips to the user's laptop
	// (health + capabilities) plus a `relayConnected` probe, i.e. ~3 Durable Object hits — to
	// re-read a boolean that changes about twice a day.
	//
	// Full 4s rate while the user is actually engaging the runner (a message in flight, a loop
	// running) or while we believe it is OFFLINE — that being the state a change is imminent
	// from, and the one the user is actively trying to fix by running `pags up`. Otherwise 20s,
	// which still keeps a fresh `pags up` visible inside the CLI's own 20s discovery window, and
	// nothing at all in a background tab (with an immediate catch-up fetch on refocus).
	const runtimeWatchBusy = thinking || !!loopRunId || runnerOnline === false;
	useTieredPolling(checkRuntime, { activeMs: 4000, passiveMs: 20000 }, runtimeWatchBusy, hasRuntime);

	/**
	 * Load the last N messages (newest at the bottom). `initial` separates OPENING a conversation
	 * from REFRESHING one — this is also the loop watcher's 3s transcript refresh, and scrolling
	 * unconditionally here yanked the reader to the bottom every poll (#335; lib/chatScroll.ts).
	 */
	const loadMessages = useCallback(async (opts?: { initial?: boolean }) => {
		if (!id) return;
		try {
			const data = await api<MessagePageResponse<Message>>(`/v1/instances/${id}/messages?limit=${PAGE}`);
			const msgs = data.messages || [];
			setMessages(msgs);
			setHasMore(resolveHasMore(data, PAGE));
			setOlderCursor(nextOlderCursor(data));
			const initial = opts?.initial === true;
			if (!shouldScrollAfterLoad({ initial, pinned: atBottomRef.current })) return;
			requestAnimationFrame(() => {
				if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
			});
			// `atBottom` survives an instance switch (the page is reused), so an opening load must
			// reset it or the jump-to-latest button lingers from the previous thread.
			if (initial) setAtBottom(true);
		} catch (e) { console.error("[chat] loadMessages failed:", e); }
	}, [id]);

	// Load older messages (prepend). Use ref for messages to avoid dep cycle.
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const loadMore = useCallback(async () => {
		// No cursor means the server said this IS the start of the conversation — asking again
		// would ask for the newest page, which is the bug (#428), not a harmless no-op.
		if (!id || loadingMore || !hasMore || !olderCursor) return;
		setLoadingMore(true);
		try {
			const data = await api<MessagePageResponse<Message>>(`/v1/instances/${id}/messages?limit=${PAGE}&before=${encodeURIComponent(olderCursor)}`);
			const older = data.messages || [];
			setHasMore(resolveHasMore(data, PAGE));
			setOlderCursor(nextOlderCursor(data));
			if (older.length > 0) {
				const el = chatRef.current;
				const prevHeight = el?.scrollHeight || 0;
				// Dedup on prepend (lib/messagePaging.ts). Cheap insurance that also makes a
				// repeated page LOUD — nothing visibly happens — instead of quietly filling the top
				// of the thread with the tail it already shows, under colliding React keys.
				setMessages((prev) => mergeOlderMessages(older, prev));
				// Restore scroll position AND clear loadingMore in the SAME frame — if we
				// cleared it synchronously here, React would batch it with the prepend so
				// the bottom-scroll effect sees loadingMore=false and yanks to the newest
				// message instead of staying where you were.
				requestAnimationFrame(() => {
					if (el) el.scrollTop = el.scrollHeight - prevHeight;
					setLoadingMore(false);
				});
				return;
			}
		} catch (e) {
			// #424: this catch was bare, so a failing page load looked exactly like a conversation
			// with nothing older behind it. Say so in the thread — the user clicked a button.
			console.error("[chat] loadMore failed:", e);
			setMessages((prev) => [
				...prev,
				{ role: "system", content: `Could not load older messages: ${e instanceof Error ? e.message : String(e)}`, createdAt: new Date().toISOString() },
			]);
		}
		setLoadingMore(false);
	}, [id, loadingMore, hasMore, olderCursor]);

	// Mount, and every instance switch — the one case that lands on the newest message
	// regardless of where the reader was left in the PREVIOUS conversation.
	useEffect(() => { loadMessages({ initial: true }); }, [loadMessages]);

	// Scroll to bottom only when NEW messages are added (not when loading older)
	const prevCountRef = useRef(0);
	useEffect(() => {
		if (messages.length > prevCountRef.current && !loadingMore && atBottomRef.current) {
			requestAnimationFrame(() => {
				if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
			});
		}
		prevCountRef.current = messages.length;
	}, [messages, loadingMore]);

	// The pending voice bubble grows as words arrive and is the newest thing in the thread — keep
	// it in view for the same reason as a new message, or the live transcript scrolls off the
	// bottom and the user is back to not being able to see what they said (#281). Only when
	// already at the bottom, so it never yanks someone out of scrollback mid-read.
	const dictationText = voice.dictation?.text ?? "";
	const dictationStatus = voice.dictation?.status;
	// biome-ignore lint/correctness/useExhaustiveDependencies: dictationText is a trigger, not an input — the effect must re-run as words arrive so the growing bubble stays in view.
	useEffect(() => {
		if (!dictationStatus || !atBottomRef.current) return;
		requestAnimationFrame(() => {
			if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
		});
	}, [dictationText, dictationStatus]);

	// Use ref for maybeSpeakResponse to avoid circular deps
	const speakRef = useRef(voice.maybeSpeakResponse);
	speakRef.current = voice.maybeSpeakResponse;
	// Direct (ungated) speak for manual replay — maybeSpeakResponse only speaks when a
	// voice mode is active, so double-tapping a message to hear it was silent otherwise.
	const directSpeakRef = useRef(voice.speak);
	directSpeakRef.current = voice.speak;

	const isCoding = instance?.capabilities?.surfaces?.includes("coding") ?? false;

	// Refs for loop state used inside the async loop continuation
	const loopObjectiveRef = useRef(loopObjective);
	const loopIterationRef = useRef(loopIteration);
	const loopMaxRef = useRef(loopMax);
	loopObjectiveRef.current = loopObjective;
	loopIterationRef.current = loopIteration;
	loopMaxRef.current = loopMax;
	const messagesRef2 = useRef(messages);
	messagesRef2.current = messages;
	const loopRunIdRef = useRef<string | null>(null);
	loopRunIdRef.current = loopRunId;
	const remoteWorkRef = useRef(false);
	remoteWorkRef.current = remoteWork;
	const thinkingRef = useRef(false);
	thinkingRef.current = thinking;
	const loadMessagesRef = useRef(loadMessages);
	loadMessagesRef.current = loadMessages;

	/**
	 * Add a system message to the chat + persist to DO.
	 *
	 * `persist: false` keeps it local to THIS tab — used for a run this tab merely adopted
	 * (#252): every tab watching the same run would otherwise write the same completion notice
	 * into the transcript, once each.
	 */
	const emitSystemChat = useCallback((content: string, persist = true) => {
		// Stamp it here as well as server-side: a `persist:false` notice (an adopted run, #252)
		// is never written to the DO, so a refresh will never hand it back with a `createdAt`,
		// and it would be the one row in the thread with no time on it (#336).
		setMessages((prev) => [...prev, { role: "system", content, createdAt: new Date().toISOString() }]);
		if (id && persist) {
			// IGNORABLE (#291): the line is already in `messages` (set synchronously above), so the
			// user has read it. This is persistence only, and the same recursion argument as the
			// Coder's `emitSystem` applies — the report of a failed system message would be a
			// system message. See agents/coder/web/src/use-coding-loop.ts.
			api(`/v1/instances/${id}/system-message`, {
				method: "POST",
				body: JSON.stringify({ content }),
			}).catch(() => {});
		}
	}, [id]);

	/**
	 * Watch a server-driven run (#158).
	 *
	 * The console used to BE the loop: poll /loop-decide, send the next instruction. That died
	 * with the tab and could not be budgeted, because the platform did not drive it. Now the
	 * workflow drives and this only reports — so it also refreshes the transcript, since the
	 * agent's turns arrive from the server rather than from calls this component made.
	 */
	const pollLoop = useCallback(async () => {
		if (!id || !loopRunIdRef.current) return;
		try {
			const run = await api<{ status: string; iteration: number; stopReason?: string | null; detail?: string | null; cancelRequested?: boolean }>(
				`/v1/instances/${id}/loop/${loopRunIdRef.current}`,
			);
			setLoopIteration(run.iteration);
			// The server's own answer, every poll — so a cancel requested from ANOTHER tab, or from
			// the Settings run list, shows up here too (#376).
			setLoopCancelPending(run.cancelRequested === true);
			await loadMessagesRef.current();
			if (run.status !== "running") {
				setLoopOn(false);
				setLoopRunId(null);
				setLoopCancelPending(false);
				// Who narrates the end of a run, and into what — both rules and their reasoning
				// live in lib/loopNotices.ts (null = the workflow already wrote it; persist:false =
				// this tab merely adopted the run, so show it but don't add an Nth copy to the log).
				const notice = loopCompletionNotice({
					status: run.status,
					stopReason: run.stopReason,
					detail: run.detail,
					driver: loopDriverRef.current,
					adopted: loopAdoptedRef.current,
				});
				if (notice) emitSystemChat(notice.text, notice.persist);
				loopDriverRef.current = null;
				loopAdoptedRef.current = false;
			}
		} catch {
			// A transient read failure must not kill the WATCHER — the run itself is durable and
			// carries on regardless of whether this tab can see it.
		}
	}, [id, emitSystemChat]);

	const doSend = useCallback(async (msg: string, meta?: { audioKey?: string; dictation?: string; suspect?: boolean }) => {
		if (!msg.trim() || !id) return;
		const { audioKey, dictation, suspect } = meta ?? {};
		setMessages((prev) => [...prev, { role: "user", content: msg, createdAt: new Date().toISOString(), audioKey, dictation, suspect }]);
		setThinking(true);
		// #279: the destination an agent resolved when the user asked to be handed over. It rides
		// on THIS response and nowhere else — no poll reads it, no socket carries it — which is
		// what makes it consumed-once and makes a move nobody asked for structurally impossible:
		// there is no response unless the user just spoke. See lib/transfer.ts.
		let transfer: ChatTransfer | null = null;
		try {
			const data = await api<{ message?: Message; toolMessage?: Message; transfer?: unknown }>(
				`/v1/instances/${id}/chat`,
				{ method: "POST", body: JSON.stringify({ message: msg, audioKey, dictation, ...(suspect ? { suspect: true } : {}) }) },
			);
			transfer = parseChatTransfer(data);
			if (data.toolMessage) {
				setMessages((prev) => [...prev, data.toolMessage!]);
			}
			if (data.message) {
				// One final card: fetch the gloss BEFORE showing the reply so message,
				// transliteration, and translation render together (the thinking spinner
				// covers the wait; a slow/failed gloss falls back to lazy fill-in).
				if (data.message.role === "assistant") await glossReplyRef.current(data.message.content);
				setMessages((prev) => [...prev, data.message!]);
				// Not spoken when we are leaving: this page is about to unmount, so the utterance
				// would be cut off a word in — and the announcement on the OTHER side is the line
				// that matters, because it says who is listening now.
				if (!transfer) speakRef.current(data.message.content);
			} else {
				setMessages((prev) => [...prev, { role: "system", content: "No response. Check Profile → API Keys.", createdAt: new Date().toISOString() }]);
			}
		} catch (e) {
			setMessages((prev) => [
				...prev,
				{ role: "system", content: `Error: ${e instanceof Error ? e.message : String(e)}`, createdAt: new Date().toISOString() },
			]);
			// #518: give the words back. `sendMessage` clears the composer BEFORE the POST, so the
			// platform's own advice — "Send the message again" — asked for a string this surface had
			// already thrown away, and the server-side resume it unlocks is gated on byte equality
			// with it. Restoring the exact text makes that gate openable by construction; retyping it,
			// or re-speaking it, essentially cannot (two dictations of one sentence never match).
			// Same landing place a turn recovered mid-reply takes (#175), so a voice mode shows the
			// composer for it rather than swallowing it — see lib/composer.ts.
			//
			// Only into an EMPTY box: waiting for a failing turn is exactly when someone starts typing
			// the next thing, and a recovery that overwrites a draft has traded one lost message for
			// another.
			setInput((cur) => (cur.trim() ? cur : msg));
		}
		setThinking(false);
		if (transfer) {
			// The SAME teardown "next" and "go back" take — TTS cut, a half-spoken turn recovered
			// (#175), the hands-free slot released — so three triggers cannot disagree about the
			// mic. `carryMode` rides the baton, so hands-free survives the move; `announce` is never
			// suppressed, because a silent move means the next sentence goes to an agent the user
			// did not know they were talking to.
			const carryMode = voiceRef.current.leaveForSwitch();
			switchTo({ instanceId: transfer.instanceId, name: transfer.name }, { mode: carryMode, reason: transfer.note });
		}
		// #158: no client-side continuation. When a loop is running the SERVER sends the next
		// instruction; a kick from here would race the workflow and double-send.
	}, [id, switchTo]);

	// Wire the voice hook's auto-send to doSend
	doSendRef.current = doSend;

	// Computed once per render: the voice-status pill state. Also drives the chat
	// area's bottom padding — the pill is absolutely positioned over the scroll area,
	// and without reserved space it sat ON TOP of the last message (worst on mobile,
	// where auto-scroll parks the newest bubble exactly under it).
	const voiceStatus = resolveVoiceStatus({
		mode: voice.mode,
		// A turn running server-side counts as working even though THIS tab did not start it —
		// that is the whole point of #252: the console stops claiming idle over live work.
		thinking: thinking || remoteWork,
		// Read from the hook's state, not by string-matching a sentinel in the composer. The old
		// `voice.interim === "Transcribing…"` was a third copy of the same literal (SDK + here +
		// the Coder Co-pilot) and it only held because the words were destroyed to write it (#281).
		transcribing: voice.transcribing,
		talking: voice.talking,
		listening: voice.micOn,
		speaking: voice.speaking,
		muted: voice.muted,
		starting: voice.starting,
	});
	// What the composer shows and whether voice owns it (#364) — one tested rule, shared with the
	// Coder Co-pilot. The box holds the TYPED draft: live speech is the pending bubble at the end
	// of the thread, and the notice is the banner directly above the box. Locked only while an
	// utterance is in flight; a FAILED one deliberately does not lock (the user is reading it and
	// may well want to type the message themselves), and neither does a notice.
	const composer = resolveComposer({ draft: input, dictation: voice.dictation, notice: voice.notice });
	const voiceBusy = composer.readOnly;
	// Is the message box on screen? Text mode always; a voice mode only when the box holds
	// something that would otherwise be lost — a `recover`ed turn (#175), a draft, or the notice
	// line. The rule and the reasoning are pure and live in lib/composer.ts (#365).
	const composerVisible = shouldShowComposer({ mode: voice.mode, draft: input, notice: composer.notice });
	// Both of these change the THREAD's height: the pill reserves `pb-16` inside the scroll area,
	// and the composer now sits below the thread and takes space from it (#365). Either way the
	// bottom of the transcript moves relative to the viewport.
	const pillVisible = !!voiceStatus;
	// biome-ignore lint/correctness/useExhaustiveDependencies: both flags are TRIGGERS, not inputs — the effect re-pins after a height CHANGE and reads neither, so the lint's fix leaves an effect that never runs.
	useEffect(() => {
		// Re-pin ONLY if the reader was already at the bottom — the #335 rule, unchanged: nothing
		// but a pinned reader (or the jump button) may move the viewport. Scrolled up mid-read,
		// showing or hiding the composer must leave the thread exactly where it is.
		if (atBottomRef.current && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
	}, [pillVisible, composerVisible]);

	// Only ONE replay at a time: a new double-tap (or word tap) cuts off the previous
	// recording instead of layering Audio elements on top of each other.
	const replayAudioRef = useRef<HTMLAudioElement | null>(null);
	/**
	 * Which message is loading or speaking, so the UI can say so.
	 *
	 * Keyed by `messageKey`, not by object identity: the transcript is refetched on a poll, which
	 * replaces every message object, and an identity-keyed indicator would silently detach from
	 * the message it belongs to mid-playback.
	 */
	const [replay, setReplay] = useState<{ key: string; phase: "loading" | "playing" } | null>(null);
	// A generation counter so a slow fetch that finishes AFTER you started another message cannot
	// resurrect its own indicator — the late response must not overwrite the current one.
	const replayGenRef = useRef(0);
	const stopReplay = useCallback(() => {
		replayGenRef.current += 1;
		setReplay(null);
		const a = replayAudioRef.current;
		if (a) {
			try { a.pause(); } catch { /* already stopped */ }
			replayAudioRef.current = null;
		}
	}, []);
	// Tap-to-pronounce entry point: cut off any playing recording, then speak (the
	// voice hook itself cancels any previous TTS utterance).
	const speakTap = useCallback((text: string, lang?: string) => {
		stopReplay();
		voice.speak(text, lang);
	}, [stopReplay, voice.speak]); // eslint-disable-line react-hooks/exhaustive-deps

	// Double-tap a message: play its SAVED voice recording if we have one (voice turns),
	// else fall back to speaking the text via TTS. Owner-scoped fetch of the R2 blob.
	const playMessage = useCallback(async (m: Message, key: string) => {
		// Tapping the message that is already playing STOPS it — otherwise the only way to silence
		// a long recording was to play a different one.
		const wasPlaying = replay?.key === key;
		stopReplay();
		if (wasPlaying) return;
		const gen = ++replayGenRef.current;
		const mine = () => replayGenRef.current === gen;
		setReplay({ key, phase: "loading" });
		if (id && m.audioKey) {
			try {
				const res = await fetch(`${API}/v1/instances/${id}/voice-audio/${m.audioKey}`, {
					headers: { Authorization: `Bearer ${getToken() ?? ""}` },
				});
				if (!mine()) return; // superseded while the blob was downloading
				if (res.ok) {
					const url = URL.createObjectURL(await res.blob());
					const audio = new Audio(url);
					const cleanup = () => {
						URL.revokeObjectURL(url);
						if (replayAudioRef.current === audio) replayAudioRef.current = null;
						if (mine()) setReplay(null);
					};
					audio.onended = cleanup;
					audio.onerror = cleanup;
					// play() rejection (autoplay blocked) fires NEITHER onended nor onerror,
					// so revoke here too or the blob URL leaks. Then fall through to TTS.
					try {
						replayAudioRef.current = audio;
						await audio.play();
						if (mine()) setReplay({ key, phase: "playing" });
						return;
					} catch { cleanup(); }
				}
			} catch { /* fall through to TTS */ }
		}
		if (!mine()) return;
		// No saved recording (or it failed to load) — re-speak the text. Direct, not the
		// auto-speak-gated path, so replay works even when no voice mode is active.
		setReplay({ key, phase: "playing" });
		try {
			await directSpeakRef.current(m.content);
		} finally {
			// `speak` resolves when the utterance ends, so the indicator tracks TTS as well as a
			// saved recording — the two paths must not look different to the reader.
			if (mine()) setReplay(null);
		}
	}, [id, stopReplay, replay?.key]);

	const sendMessage = () => {
		if (!input.trim()) return;
		const msg = input.trim();
		setInput("");
		// If loop is running, pause it for human intervention
		if (loopOn) setLoopPaused(true);
		doSend(msg);
	};

	// Watch the server-driven run (#158). Previously this effect kicked the next iteration after
	// a human interjected; the workflow owns sequencing now, so the client only observes.
	useEffect(() => {
		if (!loopOn || !loopRunId) return;
		const t = setInterval(() => { void pollLoop(); }, 3000);
		void pollLoop();
		return () => clearInterval(t);
	}, [loopOn, loopRunId, pollLoop]);

	/**
	 * Open the Loop form, loading this agent's presets the first time (#234).
	 *
	 * They are per instance and resolved server-side (subscriber override over creator default over
	 * the built-ins for the loop's driver), so the chat cannot hardcode them — which is exactly how
	 * they came to exist in one component and be invisible everywhere else.
	 */
	const toggleLoopForm = () => {
		const opening = !showLoopForm;
		setShowLoopForm(opening);
		if (!opening || loopPresetsLoaded.current || !id) return;
		loopPresetsLoaded.current = true;
		api<{ presets?: LoopPreset[] }>(`/v1/instances/${id}/loop-presets`)
			.then((r) => setLoopPresets(r.presets ?? []))
			// A preset is a shortcut, never a prerequisite: if this fails the textarea still works.
			.catch(() => setLoopPresets([]));
	};

	/**
	 * "Is this agent working?" — asked of the SERVER, not of this tab's memory (#252).
	 *
	 * Both halves used to be tab-local: the thinking indicator was React state discarded on
	 * unmount, and the loop watcher was gated on a run id only the tab that pressed Loop ever
	 * had. So navigating away and back — or opening a second tab — showed an idle console over
	 * an agent that was still working, and the work itself was invisible outside Settings.
	 * Nothing new is needed server-side: `/loop` lists every run, and the DO reports the chat
	 * turns it is actually running (#251).
	 */
	const checkWork = useCallback(async () => {
		if (!id) return;
		const [state, loops] = await Promise.all([
			api<InstanceStateLike>(`/v1/instances/${id}/state`).catch(() => null),
			// Only ask when we are not already watching one — an active watcher is the answer.
			loopOnRef.current ? Promise.resolve(null) : api<{ runs: LoopRunLike[] }>(`/v1/instances/${id}/loop`).catch(() => null),
		]);
		const working = isChatWorking(state);
		if (working !== remoteWorkRef.current) {
			remoteWorkRef.current = working;
			setRemoteWork(working);
			// A turn that finished while we were away (or in another tab) left its reply on the
			// server and nothing on screen. Skip it when the turn is OUR send — doSend already
			// appends the reply, and a reload here would race it.
			if (!working && !thinkingRef.current) void loadMessagesRef.current();
		}
		const run = adoptableRun(loops?.runs);
		if (shouldAdopt(loopRunIdRef.current, run)) {
			loopAdoptedRef.current = true;
			loopDriverRef.current = null; // unknown for a run we did not start
			setLoopRunId(run.runId);
			setLoopIteration(run.iteration ?? 0);
			// Seeded here rather than left to the first poll: a run adopted mid-cancel would
			// otherwise offer a live Stop button for up to three seconds (#376).
			setLoopCancelPending(run.cancelRequested === true);
			if (run.maxIterations) setLoopMax(run.maxIterations);
			if (run.objective) setLoopObjective(run.objective);
			setLoopOn(true); // resumes the watcher above — it only ever lacked its starting value
		}
	}, [id]);

	useEffect(() => {
		if (!id || tab !== "chat") return;
		void checkWork();
		// Slow on purpose: this is a background "is it still going" question, and the console
		// already spends its request budget on the runtime + loop polls.
		const t = setInterval(() => { if (!document.hidden) void checkWork(); }, 10000);
		return () => clearInterval(t);
	}, [id, tab, checkWork]);

	const startLoop = async () => {
		if (!loopObjective.trim() || !id) return;
		setShowLoopForm(false);
		try {
			// The server owns the loop now (#158) — it survives this tab closing, and its spend
			// is bounded by a budget the browser could never have enforced.
			const run = await api<{ runId: string; driver?: string }>(`/v1/instances/${id}/loop`, {
				method: "POST",
				body: JSON.stringify({ objective: loopObjective.trim(), maxIterations: loopMax }),
			});
			// Say that it started, and — crucially — WHERE the work will happen (lib/loopNotices.ts).
			emitSystemChat(loopStartNotice({ driver: run.driver, objective: loopObjective, maxIterations: loopMax }));
			setLoopRunId(run.runId);
			// Remember WHICH driver ran: a coding loop's completion notice is written server-side
			// (it must survive this tab closing), so emitting one here too would duplicate it.
			loopDriverRef.current = run.driver ?? null;
			setLoopOn(true);
			setLoopIteration(0);
			setLoopCancelPending(false);
			setLoopPaused(false);
		} catch (e) {
			emitSystemChat(loopStartFailureNotice(e));
		}
	};

	const stopLoop = async () => {
		setLoopPaused(false);
		const runId = loopRunIdRef.current;
		if (!id || !runId) { setLoopOn(false); return; }
		try {
			// Cooperative: the in-flight iteration finishes and settles its spend. The watcher
			// below sees the terminal status and reports it, so we do not fake one here.
			await api(`/v1/instances/${id}/loop/${runId}/cancel`, { method: "POST" });
			// Flip the control NOW rather than waiting up to 3s for the next poll to confirm what
			// the 200 already told us. The poll remains the authority — it will re-assert this
			// every 3s, and clear it if the run somehow is not cancelling.
			setLoopCancelPending(true);
			// The same sentence the button and the run list use (#376): "Stopping the loop…" said
			// nothing about the multi-minute wait, so the silence that followed read as a hang.
			emitSystemChat(STOPPING_HINT);
		} catch (e) {
			// pollLoop's own catch refuses to kill the watcher for exactly this reason — the run is durable and carries on. Clearing it here stopped the poll, so the loop kept iterating and spending with no UI trace, no Stop control and no way to re-attach: on screen, identical to a stop that worked.
			emitSystemChat(`Couldn't stop the loop — it's still running. ${e instanceof Error ? e.message : ""}`.trim(), false);
		}
	};

	/**
	 * What the header's Stop button says and does (#376).
	 *
	 * `loopOn` means this tab is watching a run the server calls `running`; the cancel flag is the
	 * only thing that separates "running" from "settling the step it is in". Both live states used
	 * to render identically, so a pressed Stop looked like a button that did nothing for minutes.
	 */
	const loopControl = loopStopControl(loopOn ? { status: "running", cancelRequested: loopCancelPending } : null);

	/** Remove exactly the ids the server deleted (#342) — never a locally-recomputed span, so the
	 *  thread can't diverge from the log if the two rules ever drift apart. */
	const dropMessages = useCallback((ids: string[]) => {
		const gone = new Set(ids);
		setMessages((prev) => prev.filter((m) => !m.id || !gone.has(m.id)));
	}, []);

	// The voice trigger for the same delete: last turn only, quoted before it goes.
	scrapRef.current = useScrapLastTurn({ instanceId: id, messagesRef, onDeleted: dropMessages });

	const clearChat = async () => {
		if (!id || !confirm("Clear all messages?")) return;
		try {
			await api(`/v1/instances/${id}/messages`, { method: "DELETE" });
			setMessages([]);
			// Otherwise "Load earlier messages" would re-fetch (with an empty cursor) and
			// repopulate the chat we just cleared.
			setHasMore(false);
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const copyChat = async () => {
		if (!id) return;
		try {
			const data = await api<{ messages: Message[] }>(`/v1/instances/${id}/messages?limit=2000`);
			// The `[Context: …]` strip is anchored and non-greedy for reasons a call site cannot
			// show — see lib/chatExport.ts.
			await navigator.clipboard.writeText(JSON.stringify(chatExportPayload(id, data.messages || []), null, 2));
		} catch (e) {
			alert("Copy failed: " + (e instanceof Error ? e.message : String(e)));
		}
	};

	const isApply = surfaces.includes("apply");
	const isRepo = surfaces.includes("repo");
	// Tabs are derived from the surface registry filtered by this instance's capabilities.
	// `surfaceCaps` is stable by content (see above); `customSurfaces` is another `… || []`, so it
	// is joined for the same reason. The suppression sits HERE, not beside the dep array: the
	// diagnostic is raised on the `useMemo` call, so one inside the call covered nothing (#326).
	// biome-ignore lint/correctness/useExhaustiveDependencies: by-value on purpose — an identity-keyed list here rebuilds the tab bar every render (#309).
	const tabDefs = useMemo(
		() => [
			...visibleSurfaces(surfaceCaps).map((s) => ({ id: s.id as string, label: s.label, icon: s.icon })),
			...customSurfaces.map((c) => ({ id: c.id, label: c.label, icon: c.icon || "🧩" })),
		],
		[surfaceCaps, customSurfaces.map((c) => c.id).join(",")],
	);

	// Inject instance controls into the Layout header (single bar)
	useHideNav(true);
	const headerContent = useMemo(() => (
		<div className="flex items-center gap-1.5 min-w-0">
			<button type="button" onClick={() => navigate("/instances")} className="text-muted hover:text-ink shrink-0"><ArrowLeft size={16} /></button>
			{instance && (
				<>
					{/* Same mark as the instances list, so the thing you clicked is the thing you are
					    now looking at. Shown on mobile too — it costs 20px and is the only identity
					    cue there, since the name is hidden below sm. */}
					<span
						className="w-5 h-5 rounded-md flex items-center justify-center text-2xs shrink-0"
						style={{ background: identityFor(instance).bg }}
						title={instance.name}
						aria-hidden="true"
					>
						{identityFor(instance).emoji}
					</span>
					<span className="text-sm font-semibold truncate max-w-32 hidden sm:inline">{instance.name}</span>
				</>
			)}
			{/* Runner dot only for agents that USE a runner — chat-only agents showed a
			    permanently grey dot that just ate navbar space (worst on mobile). */}
			{hasRuntime && (
				<span
					className="text-2xs font-bold px-1.5 py-0.5 rounded-full shrink-0"
					style={{ background: "var(--color-line)", color: runnerOnline ? "var(--color-success)" : "var(--color-muted)" }}
					title={runnerOnline ? `Runner online${runnerNode ? ` · ${runnerNode}` : ""}` : "Runner offline"}
				>
					{runnerOnline ? "●" : "○"}
				</span>
			)}
			<div className="flex border border-line rounded-lg overflow-x-auto overflow-y-hidden shrink min-w-0 scrollbar-none">
				{tabDefs.map((t) => (
					<button
						key={t.id}
						type="button"
						onClick={() => setTab(t.id)}
						className={`px-2 py-1 text-xs font-bold whitespace-nowrap shrink-0 transition-all ${tab === t.id ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel-hover"}`}
					>
						<span className="sm:hidden">{t.icon}</span>
						<span className="hidden sm:inline">{t.label}</span>
					</button>
				))}
			</div>
		</div>
		), [instance, hasRuntime, runnerOnline, runnerNode, tab, tabDefs, navigate, setTab]);

	// A surface that DECLARES `ownsHeader` may replace the page header while it is active — a
	// full-screen terminal needs it for repo + engine status + session actions.
	const [childHeader, setChildHeader] = useState<ReactNode | null>(null);
	// Clear it whenever the active surface is not one that declares the capability. Derived from
	// the declaration — the built-in registry OR the agent's own published surface — not from
	// `tab !== "coding"`: the string comparison meant only one surface could ever own the header,
	// and the next one to need it would have added a second hardcoded branch.
	const activeOwnsHeader = surfaceOwnsHeader(tab) || customSurfaces.some((c) => c.id === tab && c.ownsHeader);
	useEffect(() => { if (!activeOwnsHeader) setChildHeader(null); }, [activeOwnsHeader]);
	useHeaderSlot(childHeader || headerContent);

	return (
		<div className="flex flex-col flex-1 min-h-0">
			{/* Tab content */}
			<div className="flex-1 overflow-hidden flex flex-col min-h-0">
				{tab === "chat" && (
					<div className="flex flex-col flex-1 min-h-0">
						{/* #264: a remote MCP server that paused a call to ask the person something. It sits
						    ABOVE the thread rather than in a settings tab because the pause happens
						    mid-conversation — the agent has just said it is waiting on you — and a form
						    nobody finds inside the 30-minute deadline is the same as no form. */}
						{id && <McpInputRequests instanceId={id} />}
						{/* The thread, and the two things that overlay it. This wrapper exists so the
						    jump-to-latest button and the voice pill stay anchored to the BOTTOM OF THE
						    THREAD (#365): `bottom-3` used to resolve against the tab container, whose
						    bottom edge WAS the thread's — with the composer below, it would otherwise
						    have started resolving against the composer. Same pixels as before. */}
						<div className="relative flex-1 min-h-0 flex flex-col">
							{/* Messages. Voice control lives in the explicit status pill below so this
							    scroll region stays selectable and accessible. */}
							<div
								ref={chatRef}
								onScroll={(e) => setAtBottom(isPinnedToBottom(e.currentTarget))}
								className={`flex-1 overflow-y-auto flex flex-col gap-3 px-2 py-2 chat-scroll transition-shadow ${voiceStatus ? "pb-16" : ""} ${voice.talking ? "ring-2 ring-inset ring-success" : ""}`}
						>
							{/* Both, not just `hasMore`: without a server cursor the request could only ask for
							    the newest page again, which is the whole of #428. A button that cannot work is
							    not shown. */}
							{hasMore && olderCursor && (
								<Button size="md" onClick={loadMore} disabled={loadingMore} className="self-center mb-2">
									{loadingMore ? "Loading..." : "Load earlier messages"}
								</Button>
							)}
							{messages.map((m, i) => {
								// Classification lives in the SDK — the same heuristic was written out three
								// times (here, the Coder Co-pilot, the agent page) and three copies of a
								// heuristic is three chances to drift, invisibly.
								if (classifyMessage(m) === "tool") {
									const summary = toolCallSummary(m.content);
										return (
											<details key={messageKey(m, i)} className="self-start max-w-[90%]">
												<summary className="flex items-center gap-1.5 text-2xs text-muted cursor-pointer select-none py-0.5 px-2">
													<Wrench size={11} className="shrink-0" />
													<span>Used {summary}</span>
												</summary>
												<SafeHtmlView className="mt-1 bg-panel/50 border border-line rounded-lg p-2 text-2xs text-muted leading-relaxed msg-md" html={renderMd(m.content)} />
											</details>
										);
								}
								// Regular system messages (loop status, etc.) — deliberately NOT collapsed.
								// The shape, and the stamp these rows never had (#336), live in the component.
								if (classifyMessage(m) === "system") {
									return (
										<SystemMessage
											key={messageKey(m, i)}
											content={m.content}
											createdAt={m.createdAt}
											prevCreatedAt={messages[i - 1]?.createdAt}
										/>
									);
								}
								// User + assistant messages
								return (
									<div
										key={messageKey(m, i)}
										data-chat-bubble
										// NOTE: no onDoubleClick here — it hijacked double-click-to-select-a-word and
										// blocked copying the text. Replay lives on the always-visible speaker button.
										className={`group relative max-w-[90%] px-3 py-2 rounded-xl text-sm leading-relaxed cursor-auto select-text ${
											m.role === "user" ? "bg-accent text-white self-end rounded-br-sm"
												// A retracted answer must not carry the same edge as a real one (#406).
												: m.fabricated ? "bg-panel border border-danger-line self-start rounded-bl-sm"
													: "bg-panel border border-line self-start rounded-bl-sm"
										}`}
									>
										{/* Copy, Report a problem and Delete this turn — three hover icons from `sm`
										    up, ONE overflow control below it. #342: a delete is one turn, not one
										    line, and the server resolves the span. #514: the complaint goes on the
										    turn it is about and takes the turn before it. Why the two layouts, and
										    the WebKit measurement that forced them, are in MessageActions.tsx. */}
										{id && <MessageActions instanceId={id} message={m} messages={messages} index={i} agentSlug={instance?.slug} runActive={loopOn} onStopRun={() => void stopLoop()} onDeleted={dropMessages} />}
										{/* The replay button held an 11px icon and nothing else, so it WAS 11×11 — the
										    smallest control in the app, on the thread a hands-free user reaches for when
										    voice has gone wrong. `min-w-6` + `tap-target` make it 24 wide by 44 tall
										    without giving every message header a taller row (#389).

										    `pr-12 sm:pr-0` reserves the corner Copy and Delete sit in (#426). Below `sm`
										    those two are PERMANENTLY visible — correctly, there is no hover on a touch
										    screen — and covered 42px of a 110px stamp in WebKit. Delete's outer edge is
										    56px from the bubble border (`right-8` + its 24px box) against a content box
										    starting 12px in, so 44px must be reserved and `pr-12` is 48. Above `sm` they
										    are hover-only, so nothing is reserved and that layout is unchanged.

										    `title` is the full local time with the zone (#345) — wired only into
										    `SystemMessage` until now, so the rows whose stamp is shortened could not
										    show it.

										    A stamp that still carries its year takes two lines on an assistant bubble at
										    320px — 210px of content in a 200px box. That is the trade, not a bug: 44px
										    must be reserved either way, and a wrapped date is readable where a covered
										    one is not. `text-right` is so the second line reads as deliberate. */}
										{m.role === "user" && <div className="text-2xs opacity-70 mb-0.5 font-bold flex items-center justify-between gap-3 pr-12 sm:pr-0"><span className="flex items-center gap-1">You{m.audioKey && <button type="button" onClick={(e) => { e.stopPropagation(); playMessage(m, messageKey(m, i)); }} onDoubleClick={(e) => e.stopPropagation()} title={replay?.key === messageKey(m, i) ? "Stop" : "Play your recording"} aria-label={replay?.key === messageKey(m, i) ? "Stop playback" : "Play your recording"} className="tap-target min-w-6 inline-flex justify-center opacity-80 hover:opacity-100"><PlaybackIcon phase={replay?.key === messageKey(m, i) ? replay.phase : "idle"} /></button>}</span>{m.createdAt && <span data-msg-stamp title={stampTitle(m.createdAt, timeZone)} className="font-normal opacity-80 text-right">{formatDateTime(m.createdAt)}</span>}</div>}
										{m.role === "assistant" && <div className="text-2xs text-accent mb-0.5 font-bold flex items-center justify-between gap-3 pr-12 sm:pr-0"><span className="flex items-center gap-1">Assistant<button type="button" onClick={(e) => { e.stopPropagation(); playMessage(m, messageKey(m, i)); }} onDoubleClick={(e) => e.stopPropagation()} title={replay?.key === messageKey(m, i) ? "Stop" : "Play this message"} aria-label={replay?.key === messageKey(m, i) ? "Stop playback" : "Play this message"} className="tap-target min-w-6 inline-flex justify-center opacity-70 hover:opacity-100"><PlaybackIcon phase={replay?.key === messageKey(m, i) ? replay.phase : "idle"} /></button></span>{m.createdAt && <span data-msg-stamp title={stampTitle(m.createdAt, timeZone)} className="font-normal text-muted text-right">{formatDateTime(m.createdAt)}</span>}</div>}
										{m.fabricated && <FabricatedNotice />}
										{m.suspect && m.role === "user" && (
											<div className="text-2xs text-warning font-bold mb-1 flex items-start gap-1">
												<span aria-hidden="true">⚠</span>
												<span>Transcript may differ from what was said — the live recogniser replaced words before sending.</span>
											</div>
										)}
										{m.role === "assistant" ? (
											<GlossedMessage
												message={m}
												gloss={gloss.translations[m.content]}
												enabled={gloss.enabled}
												wordTap={gloss.wordTap}
												target={gloss.target}
												targetTag={gloss.targetTag}
												sizes={gloss.sizes}
												onSpeak={speakTap}
											/>
										) : (
											<SpokenMessage content={m.content} dictation={m.dictation} />
										)}
									</div>
								);
							})}
							{/* The utterance in flight (#281). The words used to live in the composer and were
							    ASSIGNED over with the literal "Transcribing…" at end-of-turn, so for the whole upload
							    round trip what the user had just said existed nowhere on screen — and in hands-free
							    that is exactly when they are not looking at the composer. It is a real bubble in the
							    thread now: it appears as speech starts, KEEPS the words while the clip transcribes,
							    and survives a failure instead of leaving a gap. The final transcript arrives via
							    onSend, which appends the real message and clears this. */}
							{voice.dictation && (
								<div
									aria-live="polite"
									className={`group relative max-w-[90%] px-3 py-2 rounded-xl text-sm leading-relaxed cursor-auto select-text self-end rounded-br-sm border border-dashed ${
										voice.dictation.status === "failed" ? "bg-danger-soft border-danger-line text-danger" : "bg-accent/60 border-white/40 text-white"
									}`}
								>
									<div className="text-2xs opacity-90 mb-0.5 font-bold flex items-center justify-between gap-3">
										<span className="flex items-center gap-1">
											You
											{voice.dictation.status === "dictating" && <><Mic size={11} />Speaking…</>}
											{voice.dictation.status === "transcribing" && <><Loader2 size={11} className="animate-spin" />Transcribing…</>}
											{voice.dictation.status === "failed" && <span>Not transcribed</span>}
										</span>
										{voice.dictation.status === "failed" && (
											<span className="flex items-center gap-2">
												{/* The clip is still in hand, so a timeout / 5xx / deploy answers with a
												    button rather than "say that again" (#421) — which matters most for
												    the failure this exists for, where the user has already waited. Absent
												    for a 400/401: that fails identically and bills their own key to find
												    out. */}
												{voice.canRetryDictation && (
													<button type="button" onClick={voice.retryDictation} className="font-semibold underline opacity-80 hover:opacity-100">Retry</button>
												)}
												<button type="button" onClick={voice.clearDictation} className="font-semibold underline opacity-80 hover:opacity-100">Dismiss</button>
											</span>
										)}
									</div>
									<span className="whitespace-pre-wrap break-words italic">
										{voice.dictation.text || (voice.dictation.status === "failed" ? "(nothing was captured)" : "…")}
									</span>
									{voice.dictation.status === "failed" && voice.dictation.note && (
										<div className="text-2xs mt-1 opacity-80 not-italic">{voice.dictation.note}</div>
									)}
								</div>
							)}
						</div>
						{/* Jump to latest — shown whenever the user has scrolled up off the bottom.
						    z-30 so it sits ABOVE the voice pill (never hidden by Listening/Talking),
						    bottom-right so it doesn't clash with the centered pill (#132). */}
						{!atBottom && (
							<button
								type="button"
								onClick={scrollChatToBottom}
								aria-label="Scroll to latest"
								title="Scroll to latest"
								className="absolute bottom-3 right-3 z-30 flex items-center justify-center w-9 h-9 rounded-full bg-panel border border-line shadow-lg text-muted hover:text-accent hover:border-accent transition-colors"
							>
								<ChevronDown size={18} />
							</button>
						)}
						{/* Live voice status — the OBVIOUS "it took over and is working" signal.
						    Walks Listening → Transcribing → Working so there's never a silent gap
						    between you finishing and the reply arriving. Doubles as the tap target
						    in Tap-to-talk. */}
						{(() => {
							const s = voiceStatus;
							if (!s) return null;
							const cls = s.tone === "work" ? "bg-accent text-white ring-4 ring-accent/25 animate-pulse"
								: s.tone === "speak" ? "bg-accent text-white ring-4 ring-accent/25"
								: s.tone === "live" ? "bg-success text-white ring-4 ring-success-line animate-pulse scale-105"
								: "bg-panel border border-line text-muted hover:text-accent hover:border-accent";
							const StatusIcon = s.icon === "spin" ? Loader2 : s.icon === "speak" ? Volume2 : Mic;
							return (
								<div className="absolute left-0 right-0 bottom-3 flex justify-center px-4 pointer-events-none z-20">
									<button
										type="button"
										onClick={s.tap ? (s.tone === "speak" ? voice.cancelSpeak : voice.toggleTalk) : undefined}
										disabled={!s.tap}
										aria-live="polite"
										className={`pointer-events-auto relative flex items-center gap-2 px-4 rounded-full font-bold text-sm shadow-lg transition-all ${voice.micOn ? "pt-2 pb-3.5" : "py-2"} ${cls} ${s.tap ? "cursor-pointer" : "cursor-default"}`}
									>
										<StatusIcon size={16} className={s.icon === "spin" ? "animate-spin" : ""} />
										{s.label}
										{/* The mic level meter, rehomed (#365). It was pinned to the composer's bottom
										    edge — and the composer is the one surface that is now gone in the voice
										    modes, while this is the only "the mic is hearing you" signal there is.
										    The pill is the host that exists exactly when the meter is relevant:
										    `resolveVoiceStatus` never returns null outside text mode. White because
										    an open mic only ever coincides with the live/work tones, both of which
										    are white-on-colour. */}
										{voice.micOn && (
											<span className="absolute bottom-1.5 left-4 right-4 h-1 rounded-full overflow-hidden bg-white/30" aria-hidden="true">
												<span className="block h-full bg-white rounded-full transition-all" style={{ width: `${Math.round(voice.audioLevel * 100)}%`, transitionDuration: "50ms" }} />
											</span>
										)}
									</button>
								</div>
							);
						})()}
						</div>
						{/* Controls bar — mode selector + actions. It sits between the thread and the
						    composer and, unlike the composer, is shown in EVERY mode: it is what makes
						    "switch back to Chat and type" one tap away from anywhere (#365). */}
						<div className="flex flex-wrap gap-1.5 px-2 pt-1 pb-1 shrink-0 items-center">
							{/* Three distinct interaction modes — a single segmented control (was four
							    overlapping toggles). Chat · Tap-to-talk · Hands-free. */}
							<div className="flex border border-line rounded-lg overflow-hidden shrink-0" role="radiogroup" aria-label="Interaction mode">
								{([
									{ id: "text", label: "Chat", icon: <MessageSquare size={15} />, title: "Chat: type and read replies — no voice", on: "border-accent bg-accent text-white" },
									{ id: "ptt", label: "Tap to talk", icon: <Mic size={15} />, title: "Tap to talk: tap the chat to record, tap again to send. Replies are read aloud.", on: "border-accent bg-accent text-white" },
									{ id: "handsfree", label: "Hands-free", icon: <Headphones size={15} />, title: "Hands-free: fully automatic — it listens, detects when you stop, replies aloud, and listens again.", on: "border-success bg-success text-white" },
								] as const).map((m) => (
									<label
										key={m.id}
										aria-busy={voice.starting && m.id === "handsfree"}
										title={m.title}
										className={`flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition-colors ${voice.mode === m.id ? m.on : voice.starting && m.id === "handsfree" ? "bg-success-soft text-success" : "text-muted hover:bg-panel-hover hover:text-accent"}`}
									>
										<input
											type="radio"
											name="interaction-mode"
											value={m.id}
											checked={voice.mode === m.id}
											onChange={() => voice.setVoiceMode(m.id)}
											className="sr-only"
										/>
										{/* #284: opening the mic costs a config read + getUserMedia, and until this
										    spinner nothing on the control changed for that whole window — the press
										    read as "nothing happened". It clears exactly when listening really
										    begins, so the spinner and the ready-chime agree. */}
										{voice.starting && m.id === "handsfree" ? <Loader2 size={15} className="animate-spin" /> : m.icon}
										<span className="hidden sm:inline">{voice.starting && m.id === "handsfree" ? "Starting…" : m.label}</span>
									</label>
								))}
							</div>
							{/* Mute — reachable in EVERY phase, never disabled, never behind a disclosure: on a browser with no Web Speech API this is the ONLY way to mute. Read docs/adr/0001-mute-is-always-available.md (M1) before adding a condition here. */}
							{voice.mode === "handsfree" && <button type="button" onClick={voice.toggleMute} title={voice.muted ? "Unmute the mic" : "Mute the mic (stay in hands-free)"} className={`flex items-center gap-1.5 px-2.5 py-1.5 text-sm border rounded-lg transition-colors ${voice.muted ? "border-danger bg-danger text-white" : "border-line text-muted hover:border-accent hover:text-accent"}`}><MicOff size={16} /><span className="text-xs font-semibold hidden sm:inline">{voice.muted ? "Muted" : "Mute"}</span></button>}
							{loopOn ? (
								<button type="button" onClick={stopLoop} disabled={!loopControl.canStop} aria-label={loopControl.actionLabel} title={loopControl.hint ?? `Loop ${loopIteration}/${loopMax}`} className={`px-1.5 py-1.5 text-sm border rounded-lg relative disabled:opacity-60 ${LOOP_BUTTON_CLASS[loopControl.phase]}`}>{loopControl.phase === "stopping" ? <Loader2 size={13} className="animate-spin" /> : <Square size={13} />}<span className={`absolute -top-1 -right-1 text-2xs rounded-full px-1 font-bold leading-tight ${LOOP_BADGE_CLASS[loopControl.phase]}`}>{loopIteration}</span></button>
							) : (
								<button type="button" onClick={toggleLoopForm} title="Loop" className={`px-1.5 py-1.5 text-sm border rounded-lg ${showLoopForm ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}><Repeat size={13} /></button>
							)}
							<div className="relative">
								{/* Kebab, NOT a gear: these are conversation ACTIONS (copy/clear) — real
							    settings live on the Settings tab. A gear here read as a second
							    settings surface and confused people. */}
								<button
									type="button"
									onClick={() => setShowChatMenu((v) => !v)}
									title="Chat options"
									aria-label="Chat options"
									className={`px-1.5 py-1.5 text-sm border rounded-lg transition-colors ${showChatMenu ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-accent hover:border-accent"}`}
								>
									<MoreVertical size={13} />
								</button>
								{showChatMenu && (
									<>
										<button type="button" aria-label="Close chat options" className="fixed inset-0 z-10 cursor-default" onClick={() => setShowChatMenu(false)}>
											<span className="sr-only">Close chat options</span>
										</button>
										<div className="absolute right-0 top-full mt-1 z-20 bg-panel border border-line rounded-xl shadow-lg py-1 min-w-[10rem]">
											<button
												type="button"
												onClick={() => { setShowChatMenu(false); copyChat(); }}
												className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted hover:bg-panel-hover hover:text-accent transition-colors"
											>
												<Copy size={13} /> Copy JSON
											</button>
											<button
												type="button"
												onClick={() => { setShowChatMenu(false); clearChat(); }}
												className="w-full flex items-center gap-2 px-3 py-2 text-xs text-danger hover:bg-danger-soft transition-colors"
											>
												<Trash2 size={13} /> Clear messages
											</button>
										</div>
									</>
								)}
							</div>
						</div>
						{/* Loop form with presets (#234). The presets were wired to the Coder's Co-pilot
						    view alone, so every other way of starting a loop — including the only one a
						    `copilot:false` agent has, this one — meant retyping the objective. */}
						{showLoopForm && !loopOn && (
							<div className="bg-panel border border-line rounded-xl p-3 mx-2 mb-1 flex flex-col gap-2">
								{loopPresets.length > 0 && (
									<div className="flex flex-wrap gap-1.5">
										{loopPresets.map((p) => (
											<button
												key={p.id}
												type="button"
												onClick={() => setLoopObjective(p.objective)}
												title={p.objective}
												className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${loopObjective === p.objective ? "border-accent bg-accent-soft text-accent font-bold" : "border-line text-muted hover:border-accent hover:text-accent"}`}
											>
												{p.label}
											</button>
										))}
									</div>
								)}
									<textarea
										value={loopObjective}
										onChange={(e) => setLoopObjective(e.target.value)}
										onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); startLoop(); } }}
										aria-label="Loop objective"
										placeholder={loopPresets.length ? "Or type a custom objective…" : "What should the agent work on?"}
									className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-sm resize-none"
									rows={2}
								/>
								<div className="flex items-center gap-2 justify-between">
									<label className="text-xs text-muted flex items-center gap-1.5">Max: <input type="number" value={loopMax} onChange={(e) => setLoopMax(Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 10)))} className="w-14 bg-panel border border-line rounded px-2 py-1 text-xs" min={1} max={50} /></label>
									<div className="flex gap-1.5">
										<Button size="md" onClick={() => setShowLoopForm(false)}>Cancel</Button>
										<Button variant="primary" size="md" onClick={startLoop} disabled={!loopObjective.trim()}>Start Loop</Button>
									</div>
								</div>
							</div>
						)}
						{/* Voice notice — a mic error or the wrong-language nudge, and the ONLY thing that
						    surfaces either. It used to be written into the composer's own `value`, which
						    hid the draft, made the box read-only for the seconds it was up, and left the
						    input styled as the live-speech surface it had stopped being (#364). Its own
						    line, directly above the box, so the box can go on holding what you typed. */}
						{composer.notice && (
							<output aria-live="polite" className="mx-2 mb-1 block rounded-lg border border-warning-line bg-warning-soft px-3 py-1.5 text-xs text-warning whitespace-pre-wrap break-words">
								{composer.notice}
							</output>
						)}
						{/* Composer — BELOW the thread, where every messaging app puts it, and in text
						    mode only (#365). The realtime dictation bubble is the last child of the thread,
						    so inverting these two is what puts the words the user is speaking directly above
						    the place they are looking, with exactly one surface showing them.

						    `shouldShowComposer` is not `mode === "text"`: a turn the guard classified as
						    `recover` (#175) lands in this box rather than being fired into a thread that
						    moved on, and that happens in the VOICE modes by definition. Hiding the box
						    outright would delete those words on arrival. So the box also appears whenever it
						    holds something — a recovered turn, a draft, or the notice line — which is exactly
						    when it has something to say and never otherwise. See lib/composer.ts. */}
						{composerVisible && (
						<div className="flex gap-1 sm:gap-1.5 px-2 pt-0.5 pb-2 shrink-0 items-end">
							<div className="flex-1 min-w-0 relative">
									<textarea
										ref={inputRef}
										rows={1}
										value={composer.value}
										onChange={(e) => { if (!composer.readOnly) setInput(e.target.value); }}
									// Enter sends; Shift+Enter inserts a newline (standard chat multi-line input).
										onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !voiceBusy) { e.preventDefault(); sendMessage(); } }}
										aria-label="Agent message"
										// Six branches, and `talking` outranking the mode is the one that matters —
										// see lib/composer.ts.
										placeholder={composerPlaceholder({ talking: voice.talking, mode: voice.mode, micOn: voice.micOn, isCoding, isTmux: surfaces.includes("tmux") })}
									readOnly={composer.readOnly}
									// Green while the mic is open; accent while voice owns the turn. The old
									// accent-italic "you are speaking" state keyed off the notice string, so
									// after #281 it fired on a mic ERROR and never on speech (#364).
									className={`w-full resize-none overflow-y-auto max-h-[40vh] bg-panel border rounded-xl px-4 py-2.5 text-sm leading-relaxed transition-colors ${composer.readOnly ? "border-accent" : voice.micOn ? "border-success" : "border-line"}`}
								/>
							</div>
							<button type="button" onClick={sendMessage} disabled={voiceBusy} aria-label="Send" className="px-3 py-2.5 bg-accent text-white rounded-xl font-bold text-sm disabled:opacity-40">
								<Send size={14} />
							</button>
						</div>
						)}
					</div>
				)}

				{tab !== "chat" && id && (() => {
					// Agent-published (Phase 3) surface — load its bundle dynamically.
					const custom = customSurfaces.find((c) => c.id === tab);
					if (custom) {
						// A custom surface is THIRD-PARTY CODE running in this origin. DynamicSurface
						// catches a synchronous mount() throw, but an async one — the pattern the
						// docs themselves promote — escaped to the global unhandledrejection handler
						// and left a blank tab with no error UI. resetKey on the surface id so
						// switching tabs clears a stale error.
						return (
							<ErrorBoundary resetKey={custom.id}>
								<DynamicSurface
									bundleUrl={custom.bundleUrl}
									instanceId={id}
									sessionId={urlSessionId}
									// Only a surface that DECLARED the capability is handed a working
									// setHeader; for the rest the bundle's call is inert.
									onHeader={custom.ownsHeader ? (el) => setChildHeader(el ? <HostedNode el={el} /> : null) : undefined}
								/>
							</ErrorBoundary>
						);
					}
					// Built-in surface from the static registry.
					const active = SURFACES.find((s) => s.id === tab);
					if (!active?.render) return null;
					const body = active.render({
						instanceId: id,
						isApply,
						isCoding,
						isRepo,
						sessionId: urlSessionId,
						// No boardColumns/settingsSchema: my/instances strips both (#617, see lib/types).
						surfaceOptions: instance?.capabilities?.surfaceOptions,
						// The same reading the header dot renders, handed to the surface (#378) — one
						// poll, one answer, so a tab cannot contradict the dot directly above it.
						runner: { online: runnerOnline, node: runnerNode, attachment: runnerAttachment },
						caps: surfaceCaps,
						setChildHeader,
						onUnsubscribe: () => navigate("/instances"),
					});
					return active.scroll
						? <div className="flex-1 overflow-auto px-2 py-2 sm:px-4 sm:py-3">{body}</div>
						: body;
				})()}
			</div>
		</div>
	);
}
