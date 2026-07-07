import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, API, getToken } from "@proagentstore/sdk/client";
import type { Instance, Message } from "../lib/types";
import { renderMd, formatTime } from "@proagentstore/sdk/ui";
import { usePolling } from "@proagentstore/sdk/hooks";
import { useVoice, buildTranscribePrompt, resolveVoiceStatus } from "@proagentstore/sdk/hooks";
import { Copy, Trash2, Mic, MicOff, Volume2, MessageSquare, Headphones, Send, ArrowLeft, Repeat, Square, Wrench, Settings, Loader2 } from "lucide-react";
import { useHideNav, useHeaderSlot } from "../lib/HeaderContext";
import { SURFACES, visibleSurfaces } from "../lib/surfaces";
import DynamicSurface from "../components/DynamicSurface";

// A built-in SurfaceId or a custom (agent-published) surface id.
type Tab = string;

export default function InstanceDetail() {
	const { id, "*": splat } = useParams<{ id: string; "*": string }>();
	const navigate = useNavigate();
	const [instance, setInstance] = useState<Instance | null>(null);
	const surfaces = instance?.capabilities?.surfaces || [];
	// Phase 3: agent-published UIs, loaded dynamically (see DynamicSurface).
	const customSurfaces = instance?.capabilities?.customSurfaces || [];

	// Tab + session from URL — always sync with the route. Gate the tab against the
	// surfaces THIS instance actually exposes (built-in + custom), so a deep link like
	// /coding on a non-coding agent falls back to chat instead of mounting a broken tab.
	const splatParts = splat?.split("/") || [];
	const urlTab = splatParts[0] || "";
	const allowedSurfaces = new Set<string>([
		...visibleSurfaces(surfaces).map((s) => s.id),
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
		technical: surfaces.includes("repo") || surfaces.includes("coding"),
	});

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

	// Poll runtime status
	const checkRuntime = useCallback(async () => {
		if (!id) return;
		try {
			const d = await api<{ connected?: boolean; node?: string; runtime?: Record<string, unknown> }>(`/v1/instances/${id}/runtime/status`);
			setRunnerOnline(d.connected ?? !!(d.runtime as Record<string, unknown>));
			setRunnerNode(d.node || (d.runtime as Record<string, unknown>)?.runner_node as string || "");
		} catch {
			setRunnerOnline(false);
		}
	}, [id]);

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
		if (messages.length > prevCountRef.current && !loadingMore) {
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

	const continueLoop = useCallback(async () => {
		if (!loopOnRef.current || loopPausedRef.current || !id) return;
		try {
			const recent = messagesRef2.current.slice(-6).map((m) => ({ role: m.role, content: m.content }));
			const decision = await api<{ decision: string; nextInstruction?: string; reason?: string }>(
				`/v1/instances/${id}/loop-decide`,
				{
					method: "POST",
					body: JSON.stringify({
						objective: loopObjectiveRef.current,
						messages: recent,
						iteration: loopIterationRef.current,
						maxIterations: loopMaxRef.current,
					}),
				},
			);
			if (!loopOnRef.current) return; // stopped while waiting

			if (decision.decision === "continue" && decision.nextInstruction) {
				setLoopIteration((i) => i + 1);
				emitSystemChat(`Loop ${loopIterationRef.current + 1}/${loopMaxRef.current}: ${decision.nextInstruction}`);
				await new Promise((r) => setTimeout(r, 1500));
				if (loopOnRef.current && !loopPausedRef.current) {
					doSendRef.current(decision.nextInstruction);
				}
			} else if (decision.decision === "done") {
				setLoopOn(false);
				emitSystemChat(`Loop complete: ${decision.reason || "Objective met."}`);
			} else {
				setLoopOn(false);
				emitSystemChat(`Loop paused — ${decision.decision}: ${decision.reason || "Needs your input."}`);
			}
		} catch (e) {
			setLoopOn(false);
			emitSystemChat(`Loop error: ${e instanceof Error ? e.message : String(e)}`);
		}
	}, [id]);

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
		// If the loop is active, continue after agent response
		if (loopOnRef.current && !loopPausedRef.current) {
			continueLoop();
		}
	}, [id, continueLoop]);

	// Wire the voice hook's auto-send to doSend
	doSendRef.current = doSend;

	// Double-tap a message: play its SAVED voice recording if we have one (voice turns),
	// else fall back to speaking the text via TTS. Owner-scoped fetch of the R2 blob.
	const playMessage = useCallback(async (m: Message) => {
		if (id && m.audioKey) {
			try {
				const res = await fetch(`${API}/v1/instances/${id}/voice-audio/${m.audioKey}`, {
					headers: { Authorization: `Bearer ${getToken() ?? ""}` },
				});
				if (res.ok) {
					const url = URL.createObjectURL(await res.blob());
					const audio = new Audio(url);
					const cleanup = () => URL.revokeObjectURL(url);
					audio.onended = cleanup;
					audio.onerror = cleanup;
					// play() rejection (autoplay blocked) fires NEITHER onended nor onerror,
					// so revoke here too or the blob URL leaks. Then fall through to TTS.
					try { await audio.play(); return; } catch { cleanup(); }
				}
			} catch { /* fall through to TTS */ }
		}
		// No saved recording (or it failed to load) — re-speak the text. Direct, not the
		// auto-speak-gated path, so replay works even when no voice mode is active.
		directSpeakRef.current(m.content);
	}, [id]);

	const sendMessage = () => {
		if (!input.trim()) return;
		const msg = input.trim();
		setInput("");
		// If loop is running, pause it for human intervention
		if (loopOn) setLoopPaused(true);
		doSend(msg);
	};

	// Resume loop after human intervention — only when thinking transitions from true→false
	const wasThinkingRef = useRef(false);
	useEffect(() => {
		if (wasThinkingRef.current && !thinking && loopOn && loopPaused) {
			setLoopPaused(false);
			// Trigger the next loop step after the human's answer was processed
			continueLoop();
		}
		wasThinkingRef.current = thinking;
	}, [thinking]); // eslint-disable-line react-hooks/exhaustive-deps

	const startLoop = () => {
		if (!loopObjective.trim()) return;
		setLoopOn(true);
		setLoopIteration(0);
		setLoopPaused(false);
		setShowLoopForm(false);
		doSend(loopObjective.trim());
	};

	const stopLoop = () => {
		setLoopOn(false);
		setLoopPaused(false);
		emitSystemChat("Loop stopped by user.");
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

	const copyMsgText = async (raw: string) => {
		await navigator.clipboard.writeText(raw);
	};

	const isApply = surfaces.includes("apply");
	// Tabs are derived from the surface registry filtered by this instance's capabilities.
	const tabDefs = useMemo(
		() => [
			...visibleSurfaces(surfaces).map((s) => ({ id: s.id as string, label: s.label, icon: s.icon })),
			...customSurfaces.map((c) => ({ id: c.id, label: c.label, icon: c.icon || "🧩" })),
		],
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[surfaces.join(","), customSurfaces.map((c) => c.id).join(",")],
	);

	// Inject instance controls into the Layout header (single bar)
	useHideNav(true);
	const headerContent = useMemo(() => (
		<div className="flex items-center gap-2 min-w-0">
			<button type="button" onClick={() => navigate("/instances")} className="text-muted hover:text-ink shrink-0"><ArrowLeft size={16} /></button>
			{instance && <span className="text-sm font-semibold truncate max-w-32 hidden sm:inline">{instance.name}</span>}
			<span
				className="text-[0.7rem] font-bold px-1.5 py-0.5 rounded-full shrink-0"
				style={{ background: "var(--color-line)", color: runnerOnline ? "var(--color-green)" : "var(--color-muted)" }}
				title={runnerOnline ? `Runner online${runnerNode ? ` · ${runnerNode}` : ""}` : "Runner offline"}
			>
				{runnerOnline ? "●" : "○"}
			</span>
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
	), [instance, runnerOnline, runnerNode, tab, tabDefs, navigate]);

	// Child tabs (CodingTab) can override the header when they have their own controls
	const [childHeader, setChildHeader] = useState<ReactNode | null>(null);
	// Clear override when switching away from the tab that set it
	useEffect(() => { if (tab !== "coding") setChildHeader(null); }, [tab]);
	useHeaderSlot(childHeader || headerContent);

	return (
		<div className="flex flex-col flex-1 min-h-0">
			{/* Tab content */}
			<div className="flex-1 overflow-hidden flex flex-col min-h-0">
				{tab === "chat" && (
					<div className="flex flex-col flex-1 min-h-0 relative">
						{/* Input bar — top */}
						<div className="flex gap-1 sm:gap-1.5 px-2 pt-2 pb-1 shrink-0 items-center">
							<div className="flex-1 min-w-0 relative">
								<input
									value={voice.interim || input}
									onChange={(e) => { if (!voice.interim) setInput(e.target.value); }}
									onKeyDown={(e) => { if (e.key === "Enter" && !voice.interim) sendMessage(); }}
									placeholder={voice.talking ? "Listening — tap to send" : voice.mode === "ptt" ? "Tap the chat to talk — or type" : voice.mode === "handsfree" ? (voice.micOn ? "Listening…" : "Hands-free — just talk") : isCoding ? "Ask about your repos..." : "Send a message..."}
									readOnly={!!voice.interim}
									className={`w-full bg-panel border rounded-xl px-4 py-2.5 text-sm transition-colors ${voice.interim ? "border-accent text-accent italic" : voice.micOn ? "border-green" : "border-line"}`}
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
								<button type="button" onClick={() => setShowChatMenu((v) => !v)} title="Chat options" aria-label="Chat options" className={`px-1.5 py-1.5 text-sm border rounded-lg transition-colors ${showChatMenu ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-accent hover:border-accent"}`}><Settings size={13} /></button>
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
									<label className="text-xs text-muted flex items-center gap-1.5">Max: <input type="number" value={loopMax} onChange={(e) => setLoopMax(Math.max(1, Math.min(50, parseInt(e.target.value) || 10)))} className="w-14 bg-panel border border-line rounded px-2 py-1 text-xs" min={1} max={50} /></label>
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
							className={`flex-1 overflow-y-auto flex flex-col gap-3 px-2 py-2 chat-scroll transition-shadow ${voice.talking ? "ring-2 ring-inset ring-green" : voice.mode === "ptt" ? "cursor-pointer" : ""}`}
						>
							{hasMore && (
								<button type="button" onClick={loadMore} disabled={loadingMore} className="self-center text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold transition-colors mb-2">
									{loadingMore ? "Loading..." : "Load earlier messages"}
								</button>
							)}
							{messages.map((m, i) => {
								// Tool calls: collapsed chip, tap to expand
								const isToolCall = m.role === "system" && /^[✅❌]/.test(m.content);
								if (isToolCall) {
									const toolNames = m.content.match(/\*\*(\w+)\*\*/g)?.map((t) => t.replace(/\*\*/g, "")) || ["tools"];
									const summary = toolNames.length <= 2 ? toolNames.join(", ") : `${toolNames.length} tools`;
									return (
										<details key={m.id || m.createdAt || i} className="self-start max-w-[90%]">
											<summary className="flex items-center gap-1.5 text-[0.7rem] text-muted cursor-pointer select-none py-0.5 px-2">
												<Wrench size={11} className="shrink-0" />
												<span>Used {summary}</span>
											</summary>
											<div className="mt-1 bg-panel/50 border border-line rounded-lg p-2 text-[0.7rem] text-muted leading-relaxed msg-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
										</details>
									);
								}
								// Regular system messages (loop status, etc.)
								if (m.role === "system") {
									return (
										<div key={m.id || m.createdAt || i} className="bg-yellow/10 text-yellow self-center rounded-full px-4 py-1.5 text-xs border border-yellow/15">
											<span className="whitespace-pre-wrap">{m.content}</span>
										</div>
									);
								}
								// User + assistant messages
								return (
									<div
										key={m.id || m.createdAt || i}
										onDoubleClick={() => playMessage(m)}
										className={`group relative max-w-[90%] px-3 py-2 rounded-xl text-sm leading-relaxed cursor-pointer ${
											m.role === "user" ? "bg-accent text-white self-end rounded-br-sm"
												: "bg-panel border border-line self-start rounded-bl-sm"
										}`}
									>
										<button type="button" onClick={(e) => { e.stopPropagation(); copyMsgText(m.content); }} className="absolute top-1 right-1.5 opacity-0 group-hover:opacity-100 text-[0.65rem] px-1.5 py-0.5 rounded bg-black/50 text-muted transition-opacity" title="Copy"><Copy size={12} /></button>
										{m.role === "user" && <div className="text-[0.65rem] opacity-70 mb-0.5 font-bold flex items-center justify-between gap-3"><span className="flex items-center gap-1">You{m.audioKey && <button type="button" onClick={(e) => { e.stopPropagation(); playMessage(m); }} title="Play your recording" className="opacity-80 hover:opacity-100"><Volume2 size={11} /></button>}</span>{m.createdAt && <span className="font-normal opacity-80">{formatTime(m.createdAt)}</span>}</div>}
										{m.role === "assistant" && <div className="text-[0.65rem] text-accent mb-0.5 font-bold flex items-center justify-between gap-3"><span>Assistant</span>{m.createdAt && <span className="font-normal text-muted">{formatTime(m.createdAt)}</span>}</div>}
										{m.role === "assistant" ? (
											<div className="msg-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
										) : (
											<span className="whitespace-pre-wrap">{m.content}</span>
										)}
									</div>
								);
							})}
						</div>
						{/* Live voice status — the OBVIOUS "it took over and is working" signal.
						    Walks Listening → Transcribing → Working so there's never a silent gap
						    between you finishing and the reply arriving. Doubles as the tap target
						    in Tap-to-talk. */}
						{(() => {
							const s = resolveVoiceStatus({
								mode: voice.mode,
								thinking,
								transcribing: voice.interim === "Transcribing…",
								talking: voice.talking,
								listening: voice.micOn,
								muted: voice.muted,
							});
							if (!s) return null;
							const cls = s.tone === "work" ? "bg-accent text-white ring-4 ring-accent/25 animate-pulse"
								: s.tone === "live" ? "bg-green text-white ring-4 ring-green/30 animate-pulse scale-105"
								: "bg-panel border border-line text-muted hover:text-accent hover:border-accent";
							return (
								<div className="absolute left-0 right-0 bottom-3 flex justify-center px-4 pointer-events-none z-20">
									<button
										type="button"
										onClick={s.tap ? voice.toggleTalk : undefined}
										disabled={!s.tap}
										aria-live="polite"
										className={`pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full font-bold text-sm shadow-lg transition-all ${cls} ${s.tap ? "cursor-pointer" : "cursor-default"}`}
									>
										{s.spin ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
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
						return <DynamicSurface bundleUrl={custom.bundleUrl} instanceId={id} sessionId={urlSessionId} />;
					}
					// Built-in surface from the static registry.
					const active = SURFACES.find((s) => s.id === tab);
					if (!active?.render) return null;
					const body = active.render({
						instanceId: id,
						isApply,
						sessionId: urlSessionId,
						boardColumns: instance?.capabilities?.boardColumns,
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
