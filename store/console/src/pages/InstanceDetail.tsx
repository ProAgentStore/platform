import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, API, getToken } from "@proagentstore/sdk/client";
import type { Instance, Message } from "../lib/types";
import { identityFor } from "../lib/identity";
import { classifyMessage, messageKey, toolCallSummary } from "@proagentstore/sdk/ui";
import ErrorBoundary from "../components/ErrorBoundary";
import { renderMd, formatDateTime } from "@proagentstore/sdk/ui";
import { usePolling } from "@proagentstore/sdk/hooks";
import { useVoice, buildTranscribePrompt, resolveVoiceStatus } from "@proagentstore/sdk/hooks";
import { Copy, Check, Trash2, Mic, MicOff, Volume2, MessageSquare, Headphones, Send, ArrowLeft, Repeat, Square, Wrench, MoreVertical, Loader2, ChevronDown } from "lucide-react";
import { useHideNav, useHeaderSlot } from "../lib/HeaderContext";
import { SURFACES, visibleSurfaces, surfaceOwnsHeader } from "../lib/surfaces";
import { useGloss } from "../lib/use-gloss";
import DynamicSurface from "../components/DynamicSurface";
import HostedNode from "../components/HostedNode";
import GlossedMessage from "../components/GlossedMessage";

/**
 * Per-message copy button — top-right of a bubble, subtle, 16px. Always visible on mobile
 * (no hover there); hover-revealed from `sm` up. Shows a green check for 1.5s after copying.
 */
function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}).catch(() => {});
			}}
			onDoubleClick={(e) => e.stopPropagation()}
			title={copied ? "Copied" : "Copy"}
			aria-label="Copy message"
			className="absolute top-1 right-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-1 rounded bg-black/40 text-muted hover:text-accent transition-opacity"
		>
			{copied ? <Check size={16} className="text-green" /> : <Copy size={16} />}
		</button>
	);
}

// A built-in SurfaceId or a custom (agent-published) surface id.
type Tab = string;

export default function InstanceDetail() {
	const { id, "*": splat } = useParams<{ id: string; "*": string }>();
	const navigate = useNavigate();
	const [instance, setInstance] = useState<Instance | null>(null);
	const surfaces = instance?.capabilities?.surfaces || [];
	// Tabs are gated on the whole DECLARED set, not just surfaces: some are about what the agent
	// can DO (knowledge tools → Indexing, collection tools → Data). An agent that declares no tool
	// allowlist stays permissive. See SurfaceCaps in lib/surfaces.
	const declaredTools = instance?.capabilities?.tools;
	const surfaceCaps = { surfaces, tools: declaredTools };
	// Phase 3: agent-published UIs, loaded dynamically (see DynamicSurface).
	const customSurfaces = instance?.capabilities?.customSurfaces || [];

	// Tab + session from URL — always sync with the route. Gate the tab against the
	// surfaces THIS instance actually exposes (built-in + custom), so a deep link like
	// /coding on a non-coding agent falls back to chat instead of mounting a broken tab.
	const splatParts = splat?.split("/") || [];
	const urlTab = splatParts[0] || "";
	const allowedSurfaces = new Set<string>([
		...visibleSurfaces(surfaceCaps).map((s) => s.id),
		...customSurfaces.map((c) => c.id),
	]);
	const tab: Tab = allowedSurfaces.has(urlTab) ? urlTab : "chat";
	const urlSessionId = splatParts[1] || undefined; // e.g. coding/csess_xxx
	const setTab = (t: Tab) => {
		navigate(`/instances/${id}/${t}`, { replace: true });
	};
	const [messages, setMessages] = useState<Message[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [input, setInput] = useState("");
	const [thinking, setThinking] = useState(false);
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

	// Agent loop state
	const [loopOn, setLoopOn] = useState(false);
	const [loopObjective, setLoopObjective] = useState("");
	const [loopIteration, setLoopIteration] = useState(0);
	const [loopMax, setLoopMax] = useState(10);
	const [loopPaused, setLoopPaused] = useState(false);
	// #158: the loop now runs on the SERVER (AgentLoopWorkflow). This is the run we are watching,
	// not a loop we are driving — closing this tab no longer kills the objective.
	const [loopRunId, setLoopRunId] = useState<string | null>(null);
	const [showLoopForm, setShowLoopForm] = useState(false);
	// Overflow menu for the less-frequent chat actions (Copy JSON, Clear) — keeps the
	// controls bar focused on voice, and moves the destructive Clear behind a tap.
	const [showChatMenu, setShowChatMenu] = useState(false);
	const loopOnRef = useRef(false);
	const loopPausedRef = useRef(false);
	loopOnRef.current = loopOn;
	loopPausedRef.current = loopPaused;
	// Stop the self-continuing loop on unmount — otherwise a mid-loop navigation keeps
	// the continueLoop chain firing chat rounds + setState on a dead component.
	useEffect(() => () => { loopOnRef.current = false; loopPausedRef.current = true; }, []);

	// Voice: both push-to-talk and conversation mode auto-send via this ref
	const doSendRef = useRef<(text: string, audioKey?: string) => void>(() => {});
	const voice = useVoice(id, {
		onSend: (text, meta) => doSendRef.current(text, meta?.audioKey),
		// Bias transcription toward this agent's vocabulary so domain words aren't
		// mis-heard (a coding agent should expect "bugs", not "bars").
		transcribePrompt: buildTranscribePrompt(surfaces, instance?.name ? [instance.name] : []),
		// A code explainer (repo/coding) speaks ABOUT code — keep identifiers + file
		// basenames in the spoken reply instead of gutting them to "a file … a file".
		technical: surfaces.includes("repo") || surfaces.includes("coding") || surfaces.includes("tmux"),
	});

	// Auto-grow the chat input so the FULL live transcript (or a long typed message) is readable
	// as it grows, instead of truncating to one line (#164). Caps at ~40vh, then scrolls.
	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [voice.interim, input]);

	useEffect(() => {
		if (!id) return;
		setInstance(null);
		setMessages([]);
		setChildHeader(null);
		(async () => {
			try {
				const data = await api<{ instances: Instance[] }>("/v1/instances/my/instances");
				const inst = (data.instances || []).find((i) => i.id === id || i.slug === id);
				if (inst) {
					setInstance(inst);
				}
			} catch (e) {
				console.error(e);
			}
		})();
	}, [id]); // eslint-disable-line react-hooks/exhaustive-deps

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
			const d = await api<{ runtime?: { runnerNode?: string | null }; relay?: { connected?: boolean; runnerNode?: string | null } }>(
				`/v1/instances/${id}/runtime/status`,
			);
			setRunnerOnline(d.relay?.connected === true);
			setRunnerNode(d.relay?.runnerNode || d.runtime?.runnerNode || "");
		} catch {
			setRunnerOnline(false);
		}
	}, [id, hasRuntime]);

	useEffect(() => { checkRuntime(); }, [checkRuntime]);
	usePolling(checkRuntime, 4000);

	// Load last N messages (newest at the bottom)
	const loadMessages = useCallback(async () => {
		if (!id) return;
		try {
			const data = await api<{ messages: Message[] }>(`/v1/instances/${id}/messages?limit=${PAGE}`);
			const msgs = data.messages || [];
			setMessages(msgs);
			setHasMore(msgs.length >= PAGE);
			// Scroll to bottom after initial load
			requestAnimationFrame(() => {
				if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
			});
		} catch (e) { console.error("[chat] loadMessages failed:", e); }
	}, [id]);

	// Load older messages (prepend). Use ref for messages to avoid dep cycle.
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const loadMore = useCallback(async () => {
		if (!id || loadingMore || !hasMore) return;
		setLoadingMore(true);
		try {
			const oldest = messagesRef.current[0];
			const before = oldest?.id || oldest?.createdAt || "";
			const data = await api<{ messages: Message[] }>(`/v1/instances/${id}/messages?limit=${PAGE}&before=${encodeURIComponent(before)}`);
			const older = data.messages || [];
			setHasMore(older.length >= PAGE);
			if (older.length > 0) {
				const el = chatRef.current;
				const prevHeight = el?.scrollHeight || 0;
				setMessages((prev) => [...older, ...prev]);
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
		} catch {}
		setLoadingMore(false);
	}, [id, loadingMore, hasMore]);

	useEffect(() => { loadMessages(); }, [loadMessages]);

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
	const loadMessagesRef = useRef(loadMessages);
	loadMessagesRef.current = loadMessages;

	/** Add a system message to the chat + persist to DO. */
	const emitSystemChat = useCallback((content: string) => {
		setMessages((prev) => [...prev, { role: "system", content }]);
		if (id) {
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
			const run = await api<{ status: string; iteration: number; stopReason?: string | null; detail?: string | null }>(
				`/v1/instances/${id}/loop/${loopRunIdRef.current}`,
			);
			setLoopIteration(run.iteration);
			await loadMessagesRef.current();
			if (run.status !== "running") {
				setLoopOn(false);
				setLoopRunId(null);
				const label = run.stopReason === "done" ? "Loop complete" : `Loop stopped (${run.stopReason ?? run.status})`;
				emitSystemChat(`${label}: ${run.detail || ""}`.trim());
			}
		} catch {
			// A transient read failure must not kill the WATCHER — the run itself is durable and
			// carries on regardless of whether this tab can see it.
		}
	}, [id, emitSystemChat]);

	const doSend = useCallback(async (msg: string, audioKey?: string) => {
		if (!msg.trim() || !id) return;
		setMessages((prev) => [...prev, { role: "user", content: msg, createdAt: new Date().toISOString(), audioKey }]);
		setThinking(true);
		try {
			const data = await api<{ message?: Message; toolMessage?: Message }>(
				`/v1/instances/${id}/chat`,
				{ method: "POST", body: JSON.stringify({ message: msg, audioKey }) },
			);
			if (data.toolMessage) {
				setMessages((prev) => [...prev, data.toolMessage!]);
			}
			if (data.message) {
				// One final card: fetch the gloss BEFORE showing the reply so message,
				// transliteration, and translation render together (the thinking spinner
				// covers the wait; a slow/failed gloss falls back to lazy fill-in).
				if (data.message.role === "assistant") await glossReplyRef.current(data.message.content);
				setMessages((prev) => [...prev, data.message!]);
				speakRef.current(data.message.content);
			} else {
				setMessages((prev) => [...prev, { role: "system", content: "No response. Check Profile → API Keys." }]);
			}
		} catch (e) {
			setMessages((prev) => [
				...prev,
				{ role: "system", content: `Error: ${e instanceof Error ? e.message : String(e)}` },
			]);
		}
		setThinking(false);
		// #158: no client-side continuation. When a loop is running the SERVER sends the next
		// instruction; a kick from here would race the workflow and double-send.
	}, [id]);

	// Wire the voice hook's auto-send to doSend
	doSendRef.current = doSend;

	// Computed once per render: the voice-status pill state. Also drives the chat
	// area's bottom padding — the pill is absolutely positioned over the scroll area,
	// and without reserved space it sat ON TOP of the last message (worst on mobile,
	// where auto-scroll parks the newest bubble exactly under it).
	const voiceStatus = resolveVoiceStatus({
		mode: voice.mode,
		thinking,
		transcribing: voice.interim === "Transcribing…",
		talking: voice.talking,
		listening: voice.micOn,
		speaking: voice.speaking,
		muted: voice.muted,
	});
	// When the pill appears, its reserved padding is BELOW the current scroll position —
	// nudge to the bottom so the last message rises clear of the pill immediately.
	const pillVisible = !!voiceStatus;
	useEffect(() => {
		// Only nudge to the bottom for the pill's reserved space when the user is AT the bottom —
		// don't yank them down mid-read just because voice status appeared (#132).
		if (pillVisible && atBottomRef.current && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
	}, [pillVisible]);

	// Only ONE replay at a time: a new double-tap (or word tap) cuts off the previous
	// recording instead of layering Audio elements on top of each other.
	const replayAudioRef = useRef<HTMLAudioElement | null>(null);
	const stopReplay = useCallback(() => {
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
	const playMessage = useCallback(async (m: Message) => {
		stopReplay();
		if (id && m.audioKey) {
			try {
				const res = await fetch(`${API}/v1/instances/${id}/voice-audio/${m.audioKey}`, {
					headers: { Authorization: `Bearer ${getToken() ?? ""}` },
				});
				if (res.ok) {
					const url = URL.createObjectURL(await res.blob());
					const audio = new Audio(url);
					const cleanup = () => {
						URL.revokeObjectURL(url);
						if (replayAudioRef.current === audio) replayAudioRef.current = null;
					};
					audio.onended = cleanup;
					audio.onerror = cleanup;
					// play() rejection (autoplay blocked) fires NEITHER onended nor onerror,
					// so revoke here too or the blob URL leaks. Then fall through to TTS.
					try { replayAudioRef.current = audio; await audio.play(); return; } catch { cleanup(); }
				}
			} catch { /* fall through to TTS */ }
		}
		// No saved recording (or it failed to load) — re-speak the text. Direct, not the
		// auto-speak-gated path, so replay works even when no voice mode is active.
		directSpeakRef.current(m.content);
	}, [id, stopReplay]);

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

	const startLoop = async () => {
		if (!loopObjective.trim() || !id) return;
		setShowLoopForm(false);
		try {
			// The server owns the loop now (#158) — it survives this tab closing, and its spend
			// is bounded by a budget the browser could never have enforced.
			const run = await api<{ runId: string }>(`/v1/instances/${id}/loop`, {
				method: "POST",
				body: JSON.stringify({ objective: loopObjective.trim(), maxIterations: loopMax }),
			});
			setLoopRunId(run.runId);
			setLoopOn(true);
			setLoopIteration(0);
			setLoopPaused(false);
		} catch (e) {
			emitSystemChat(`Could not start the loop: ${e instanceof Error ? e.message : String(e)}`);
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
			emitSystemChat("Stopping the loop…");
		} catch {
			setLoopOn(false);
			setLoopRunId(null);
		}
	};

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
			const msgs = (data.messages || []).map((m) => ({
				role: m.role,
				content: (m.content || "").replace(/^\[Context:[\s\S]*?\]\s*\n*/i, ""),
				timestamp: m.createdAt,
			}));
			await navigator.clipboard.writeText(JSON.stringify({ instanceId: id, count: msgs.length, messages: msgs }, null, 2));
		} catch (e) {
			alert("Copy failed: " + (e instanceof Error ? e.message : String(e)));
		}
	};

	const isApply = surfaces.includes("apply");
	// Tabs are derived from the surface registry filtered by this instance's capabilities.
	const tabDefs = useMemo(
		() => [
			...visibleSurfaces(surfaceCaps).map((s) => ({ id: s.id as string, label: s.label, icon: s.icon })),
			...customSurfaces.map((c) => ({ id: c.id, label: c.label, icon: c.icon || "🧩" })),
		],
		// eslint-disable-next-line react-hooks/exhaustive-deps
		// Joined strings, not the arrays: each poll returns fresh array identities, and depending on
		// those would re-derive the tab list every few seconds.
		[surfaces.join(","), declaredTools?.join(","), customSurfaces.map((c) => c.id).join(",")],
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
						className="w-5 h-5 rounded-md flex items-center justify-center text-[0.7rem] shrink-0"
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
					className="text-[0.7rem] font-bold px-1.5 py-0.5 rounded-full shrink-0"
					style={{ background: "var(--color-line)", color: runnerOnline ? "var(--color-green)" : "var(--color-muted)" }}
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
	), [instance, hasRuntime, runnerOnline, runnerNode, tab, tabDefs, navigate]);

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
					<div className="flex flex-col flex-1 min-h-0 relative">
						{/* Input bar — top */}
						<div className="flex gap-1 sm:gap-1.5 px-2 pt-2 pb-1 shrink-0 items-end">
							<div className="flex-1 min-w-0 relative">
								<textarea
									ref={inputRef}
									rows={1}
									value={voice.interim || input}
									onChange={(e) => { if (!voice.interim) setInput(e.target.value); }}
									// Enter sends; Shift+Enter inserts a newline (standard chat multi-line input).
									onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !voice.interim) { e.preventDefault(); sendMessage(); } }}
									placeholder={voice.talking ? "Listening — tap to send" : voice.mode === "ptt" ? "Tap the chat to talk — or type" : voice.mode === "handsfree" ? (voice.micOn ? "Listening…" : "Hands-free — just talk") : isCoding ? "Ask about your repos..." : surfaces.includes("tmux") ? "Ask about tmux sessions..." : "Send a message..."}
									readOnly={!!voice.interim}
									className={`w-full resize-none overflow-y-auto max-h-[40vh] bg-panel border rounded-xl px-4 py-2.5 text-sm leading-relaxed transition-colors ${voice.interim ? "border-accent text-accent italic" : voice.micOn ? "border-green" : "border-line"}`}
								/>
								{voice.micOn && (
									<div className="absolute bottom-0 left-2 right-2 h-1 rounded-full overflow-hidden bg-line/50">
										<div className="h-full bg-green rounded-full transition-all" style={{ width: `${Math.round(voice.audioLevel * 100)}%`, transitionDuration: "50ms" }} />
									</div>
								)}
							</div>
							<button type="button" onClick={sendMessage} disabled={!!voice.interim} aria-label="Send" className="px-3 py-2.5 bg-accent text-white rounded-xl font-bold text-sm disabled:opacity-40">
								<Send size={14} />
							</button>
						</div>
						{/* Controls bar — mode selector + actions (tight under the input, no divider) */}
						<div className="flex flex-wrap gap-1.5 px-2 pt-0.5 pb-1.5 shrink-0 items-center">
							{/* Three distinct interaction modes — a single segmented control (was four
							    overlapping toggles). Chat · Tap-to-talk · Hands-free. */}
							<div className="flex border border-line rounded-lg overflow-hidden shrink-0" role="radiogroup" aria-label="Interaction mode">
								{([
									{ id: "text", label: "Chat", icon: <MessageSquare size={15} />, title: "Chat: type and read replies — no voice", on: "border-accent bg-accent text-white" },
									{ id: "ptt", label: "Tap to talk", icon: <Mic size={15} />, title: "Tap to talk: tap the chat to record, tap again to send. Replies are read aloud.", on: "border-accent bg-accent text-white" },
									{ id: "handsfree", label: "Hands-free", icon: <Headphones size={15} />, title: "Hands-free: fully automatic — it listens, detects when you stop, replies aloud, and listens again.", on: "border-green bg-green text-white" },
								] as const).map((m) => (
									<button
										key={m.id}
										type="button"
										role="radio"
										aria-checked={voice.mode === m.id}
										title={m.title}
										onClick={() => voice.setVoiceMode(m.id)}
										className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition-colors ${voice.mode === m.id ? m.on : "text-muted hover:bg-panel-hover hover:text-accent"}`}
									>
										{m.icon}<span className="hidden sm:inline">{m.label}</span>
									</button>
								))}
							</div>
							{voice.mode === "handsfree" && <button type="button" onClick={voice.toggleMute} title={voice.muted ? "Unmute the mic" : "Mute the mic (stay in hands-free)"} className={`flex items-center gap-1.5 px-2.5 py-1.5 text-sm border rounded-lg transition-colors ${voice.muted ? "border-red bg-red text-white" : "border-line text-muted hover:border-accent hover:text-accent"}`}><MicOff size={16} /><span className="text-xs font-semibold hidden sm:inline">{voice.muted ? "Muted" : "Mute"}</span></button>}
							{loopOn ? (
								<button type="button" onClick={stopLoop} title={`Loop ${loopIteration}/${loopMax}`} className="px-1.5 py-1.5 text-sm border border-green bg-green/15 text-green rounded-lg relative"><Square size={13} /><span className="absolute -top-1 -right-1 text-[0.55rem] bg-green text-white rounded-full px-1 font-bold leading-tight">{loopIteration}</span></button>
							) : (
								<button type="button" onClick={() => setShowLoopForm(!showLoopForm)} title="Loop" className={`px-1.5 py-1.5 text-sm border rounded-lg ${showLoopForm ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}><Repeat size={13} /></button>
							)}
							<div className="relative">
								{/* Kebab, NOT a gear: these are conversation ACTIONS (copy/clear) — real
							    settings live on the Settings tab. A gear here read as a second
							    settings surface and confused people. */}
							<button type="button" onClick={() => setShowChatMenu((v) => !v)} title="Chat options" aria-label="Chat options" className={`px-1.5 py-1.5 text-sm border rounded-lg transition-colors ${showChatMenu ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-accent hover:border-accent"}`}><MoreVertical size={13} /></button>
								{showChatMenu && (
									<>
										<div className="fixed inset-0 z-10" onClick={() => setShowChatMenu(false)} />
										<div className="absolute right-0 top-full mt-1 z-20 bg-panel border border-line rounded-xl shadow-lg py-1 min-w-[10rem]">
											<button type="button" onClick={() => { setShowChatMenu(false); copyChat(); }} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted hover:bg-panel-hover hover:text-accent transition-colors"><Copy size={13} /> Copy JSON</button>
											<button type="button" onClick={() => { setShowChatMenu(false); clearChat(); }} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red hover:bg-red/10 transition-colors"><Trash2 size={13} /> Clear messages</button>
										</div>
									</>
								)}
							</div>
						</div>
						{/* Loop form with presets */}
						{showLoopForm && !loopOn && (
							<div className="bg-panel border border-line rounded-xl p-3 mx-2 mb-1 flex flex-col gap-2">
								<textarea
									value={loopObjective}
									onChange={(e) => setLoopObjective(e.target.value)}
									onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); startLoop(); } }}
									placeholder="What should the agent work on?"
									className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-sm resize-none"
									rows={2}
									autoFocus
								/>
								<div className="flex items-center gap-2 justify-between">
									<label className="text-xs text-muted flex items-center gap-1.5">Max: <input type="number" value={loopMax} onChange={(e) => setLoopMax(Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 10)))} className="w-14 bg-panel border border-line rounded px-2 py-1 text-xs" min={1} max={50} /></label>
									<div className="flex gap-1.5">
										<button type="button" onClick={() => setShowLoopForm(false)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Cancel</button>
										<button type="button" onClick={startLoop} disabled={!loopObjective.trim()} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold disabled:opacity-40">Start Loop</button>
									</div>
								</div>
							</div>
						)}
						{/* Messages. In Tap-to-talk, a tap here (not on a button) starts/stops a
						    recording turn. In Hands-free, a tap interrupts the agent so you can talk. */}
						<div
							ref={chatRef}
							onClick={(e) => {
								if ((e.target as HTMLElement).closest("button, a, summary, input, textarea")) return;
								if (voice.mode === "ptt") voice.toggleTalk();
								else if (voice.mode === "handsfree") voice.cancelSpeak();
							}}
							onScroll={(e) => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40); }}
							className={`flex-1 overflow-y-auto flex flex-col gap-3 px-2 py-2 chat-scroll transition-shadow ${voiceStatus ? "pb-16" : ""} ${voice.talking ? "ring-2 ring-inset ring-green" : voice.mode === "ptt" ? "cursor-pointer" : ""}`}
						>
							{hasMore && (
								<button type="button" onClick={loadMore} disabled={loadingMore} className="self-center text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold transition-colors mb-2">
									{loadingMore ? "Loading..." : "Load earlier messages"}
								</button>
							)}
							{messages.map((m, i) => {
								// Classification lives in the SDK — the same heuristic was written out three
								// times (here, the Coder Co-pilot, the agent page) and three copies of a
								// heuristic is three chances to drift, invisibly.
								if (classifyMessage(m) === "tool") {
									const summary = toolCallSummary(m.content);
									return (
										<details key={messageKey(m, i)} className="self-start max-w-[90%]">
											<summary className="flex items-center gap-1.5 text-[0.7rem] text-muted cursor-pointer select-none py-0.5 px-2">
												<Wrench size={11} className="shrink-0" />
												<span>Used {summary}</span>
											</summary>
											<div className="mt-1 bg-panel/50 border border-line rounded-lg p-2 text-[0.7rem] text-muted leading-relaxed msg-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
										</details>
									);
								}
								// Regular system messages (loop status, etc.) — deliberately NOT collapsed.
								if (classifyMessage(m) === "system") {
									return (
										<div key={messageKey(m, i)} className="bg-yellow/10 text-yellow self-center rounded-full px-4 py-1.5 text-xs border border-yellow/15 max-w-[90%]">
											<span className="whitespace-pre-wrap break-words">{m.content}</span>
										</div>
									);
								}
								// User + assistant messages
								return (
									<div
										key={messageKey(m, i)}
										// Keep a bubble tap from bubbling to the chat-container tap handler — in
										// Tap-to-talk that would churn the mic (and fire a phantom empty turn); in
										// Hands-free it would reopen the mic into the replay audio. NOTE: no
										// onDoubleClick here — it hijacked double-click-to-select-a-word and blocked
										// copying the text. Replay lives on the always-visible speaker button below.
										onClick={(e) => e.stopPropagation()}
										className={`group relative max-w-[90%] px-3 py-2 rounded-xl text-sm leading-relaxed cursor-auto select-text ${
											m.role === "user" ? "bg-accent text-white self-end rounded-br-sm"
												: "bg-panel border border-line self-start rounded-bl-sm"
										}`}
									>
										<CopyButton text={m.content} />
										{m.role === "user" && <div className="text-[0.65rem] opacity-70 mb-0.5 font-bold flex items-center justify-between gap-3"><span className="flex items-center gap-1">You{m.audioKey && <button type="button" onClick={(e) => { e.stopPropagation(); playMessage(m); }} onDoubleClick={(e) => e.stopPropagation()} title="Play your recording" className="opacity-80 hover:opacity-100"><Volume2 size={11} /></button>}</span>{m.createdAt && <span className="font-normal opacity-80">{formatDateTime(m.createdAt)}</span>}</div>}
										{m.role === "assistant" && <div className="text-[0.65rem] text-accent mb-0.5 font-bold flex items-center justify-between gap-3"><span className="flex items-center gap-1">Assistant<button type="button" onClick={(e) => { e.stopPropagation(); playMessage(m); }} onDoubleClick={(e) => e.stopPropagation()} title="Play this message" className="opacity-70 hover:opacity-100"><Volume2 size={11} /></button></span>{m.createdAt && <span className="font-normal text-muted">{formatDateTime(m.createdAt)}</span>}</div>}
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
											<span className="whitespace-pre-wrap break-words">{m.content}</span>
										)}
									</div>
								);
							})}
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
								: s.tone === "live" ? "bg-green text-white ring-4 ring-green/30 animate-pulse scale-105"
								: "bg-panel border border-line text-muted hover:text-accent hover:border-accent";
							const StatusIcon = s.icon === "spin" ? Loader2 : s.icon === "speak" ? Volume2 : Mic;
							return (
								<div className="absolute left-0 right-0 bottom-3 flex justify-center px-4 pointer-events-none z-20">
									<button
										type="button"
										onClick={s.tap ? (s.tone === "speak" ? voice.cancelSpeak : voice.toggleTalk) : undefined}
										disabled={!s.tap}
										aria-live="polite"
										className={`pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full font-bold text-sm shadow-lg transition-all ${cls} ${s.tap ? "cursor-pointer" : "cursor-default"}`}
									>
										<StatusIcon size={16} className={s.icon === "spin" ? "animate-spin" : ""} />
										{s.label}
									</button>
								</div>
							);
						})()}
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
						sessionId: urlSessionId,
						boardColumns: instance?.capabilities?.boardColumns,
						settingsSchema: instance?.capabilities?.settingsSchema,
						surfaceOptions: instance?.capabilities?.surfaceOptions,
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
