import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { Instance, Message } from "../lib/types";
import { renderMd, formatTime } from "@proagentstore/sdk/ui";
import { usePolling } from "@proagentstore/sdk/hooks";
import { useVoice } from "@proagentstore/sdk/hooks";
import { Copy, Trash2, Mic, MicOff, Volume2, AudioLines, Send, ArrowLeft, Repeat, Square, Wrench } from "lucide-react";
import { useHideNav, useHeaderSlot } from "../lib/HeaderContext";
import { SURFACES, SURFACE_IDS, visibleSurfaces, type SurfaceId } from "../lib/surfaces";

type Tab = SurfaceId;

export default function InstanceDetail() {
	const { id, "*": splat } = useParams<{ id: string; "*": string }>();
	const navigate = useNavigate();
	const [instance, setInstance] = useState<Instance | null>(null);

	// Tab + session from URL — always sync with the route
	const validTabs: Tab[] = SURFACE_IDS;
	const splatParts = splat?.split("/") || [];
	const urlTab = (splatParts[0] || "") as Tab;
	const tab = validTabs.includes(urlTab) ? urlTab : "chat";
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
	const loopOnRef = useRef(false);
	const loopPausedRef = useRef(false);
	loopOnRef.current = loopOn;
	loopPausedRef.current = loopPaused;

	// Voice: both push-to-talk and conversation mode auto-send via this ref
	const doSendRef = useRef<(text: string) => void>(() => {});
	const voice = useVoice(id, {
		onSend: (text) => doSendRef.current(text),
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
				requestAnimationFrame(() => {
					if (el) el.scrollTop = el.scrollHeight - prevHeight;
				});
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

	const doSend = useCallback(async (msg: string) => {
		console.log("[chat] doSend:", msg?.slice(0, 50), "id:", id);
		if (!msg.trim() || !id) return;
		setMessages((prev) => [...prev, { role: "user", content: msg }]);
		setThinking(true);
		try {
			const data = await api<{ message?: Message; toolMessage?: Message }>(
				`/v1/instances/${id}/chat`,
				{ method: "POST", body: JSON.stringify({ message: msg }) },
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
		} catch {}
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

	const surfaces = instance?.capabilities?.surfaces || [];
	const isApply = surfaces.includes("apply");
	// Tabs are derived from the surface registry filtered by this instance's capabilities.
	const tabDefs = useMemo(
		() => visibleSurfaces(surfaces).map((s) => ({ id: s.id, label: s.label, icon: s.icon })),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[surfaces.join(",")],
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
					<div className="flex flex-col flex-1 min-h-0">
						{/* Input bar — top */}
						<div className="flex gap-1 sm:gap-1.5 px-2 py-2 shrink-0 items-center border-b border-line">
							<div className="flex-1 min-w-0 relative">
								<input
									value={voice.interim || input}
									onChange={(e) => { if (!voice.interim) setInput(e.target.value); }}
									onKeyDown={(e) => { if (e.key === "Enter" && !voice.interim) sendMessage(); }}
									placeholder={voice.micOn ? "Listening..." : voice.convoOn ? "Conversation mode — just talk" : isCoding ? "Ask about your repos..." : "Send a message..."}
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
						{/* Controls bar */}
						<div className="flex gap-1 px-2 py-1 shrink-0 items-center">
							<button type="button" onClick={voice.toggleMic} title="Push to talk" className={`px-1.5 py-1.5 text-sm border rounded-lg transition-colors ${voice.micOn ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}><Mic size={13} /></button>
							<button type="button" onClick={voice.toggleSpeak} title="Auto-speak" className={`px-1.5 py-1.5 text-sm border rounded-lg transition-colors ${voice.speakOn ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}><Volume2 size={13} /></button>
							<button type="button" onClick={voice.toggleConvo} title="Hands-free voice" className={`px-1.5 py-1.5 text-sm border rounded-lg transition-colors ${voice.convoOn ? "border-green bg-green/15 text-green" : "border-line text-muted hover:border-accent hover:text-accent"}`}><AudioLines size={13} /></button>
							{voice.convoOn && <button type="button" onClick={voice.toggleMute} title={voice.muted ? "Unmute" : "Mute"} className={`px-1.5 py-1.5 text-sm border rounded-lg transition-colors ${voice.muted ? "border-red bg-red/15 text-red" : "border-line text-muted hover:border-accent hover:text-accent"}`}><MicOff size={13} /></button>}
							{loopOn ? (
								<button type="button" onClick={stopLoop} title={`Loop ${loopIteration}/${loopMax}`} className="px-1.5 py-1.5 text-sm border border-green bg-green/15 text-green rounded-lg relative"><Square size={13} /><span className="absolute -top-1 -right-1 text-[0.55rem] bg-green text-white rounded-full px-1 font-bold leading-tight">{loopIteration}</span></button>
							) : (
								<button type="button" onClick={() => setShowLoopForm(!showLoopForm)} title="Loop" className={`px-1.5 py-1.5 text-sm border rounded-lg ${showLoopForm ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}><Repeat size={13} /></button>
							)}
							<button type="button" onClick={copyChat} title="Copy JSON" className="px-1.5 py-1.5 text-sm border border-line rounded-lg text-muted hover:text-accent hover:border-accent transition-colors"><Copy size={13} /></button>
							<button type="button" onClick={clearChat} title="Clear" className="px-1.5 py-1.5 text-sm border border-line rounded-lg text-red hover:bg-red/10 transition-colors"><Trash2 size={13} /></button>
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
						{/* Messages */}
						<div ref={chatRef} className="flex-1 overflow-y-auto flex flex-col gap-3 px-2 py-2 chat-scroll">
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
										<details key={i} className="self-start max-w-[90%]">
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
										<div key={i} className="bg-yellow/10 text-yellow self-center rounded-full px-4 py-1.5 text-xs border border-yellow/15">
											<span className="whitespace-pre-wrap">{m.content}</span>
										</div>
									);
								}
								// User + assistant messages
								return (
									<div
										key={i}
										onClick={() => voice.cancelSpeak()}
										onDoubleClick={() => voice.maybeSpeakResponse(m.content)}
										className={`group relative max-w-[90%] px-3 py-2 rounded-xl text-sm leading-relaxed cursor-pointer ${
											m.role === "user" ? "bg-accent text-white self-end rounded-br-sm"
												: "bg-panel border border-line self-start rounded-bl-sm"
										}`}
									>
										<button type="button" onClick={(e) => { e.stopPropagation(); copyMsgText(m.content); }} className="absolute top-1 right-1.5 opacity-0 group-hover:opacity-100 text-[0.65rem] px-1.5 py-0.5 rounded bg-black/50 text-muted transition-opacity" title="Copy"><Copy size={12} /></button>
										{m.role === "user" && <div className="text-[0.65rem] opacity-70 mb-0.5 font-bold flex items-center justify-between gap-3"><span>You</span>{m.createdAt && <span className="font-normal opacity-80">{formatTime(m.createdAt)}</span>}</div>}
										{m.role === "assistant" && <div className="text-[0.65rem] text-accent mb-0.5 font-bold flex items-center justify-between gap-3"><span>Chat</span>{m.createdAt && <span className="font-normal text-muted">{formatTime(m.createdAt)}</span>}</div>}
										{m.role === "assistant" ? (
											<div className="msg-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
										) : (
											<span className="whitespace-pre-wrap">{m.content}</span>
										)}
									</div>
								);
							})}
							{thinking && (
								<div className="text-muted text-sm flex items-center gap-2">
									<span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
									Thinking...
								</div>
							)}
						</div>
					</div>
				)}

				{tab !== "chat" && id && (() => {
					const active = SURFACES.find((s) => s.id === tab);
					if (!active?.render) return null;
					const body = active.render({
						instanceId: id,
						isApply,
						sessionId: urlSessionId,
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
