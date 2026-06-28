import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import type { Instance, Message } from "../lib/types";
import { renderMd } from "../lib/markdown";
import { usePolling } from "../hooks/usePolling";
import { useVoice } from "../hooks/useVoice";
import { Copy, Trash2, Mic, Volume2, AudioLines, Send, ArrowLeft } from "lucide-react";
import { useHeaderSlot } from "../lib/HeaderContext";
import BoardTab from "../tabs/BoardTab";
import CodingTab from "../tabs/CodingTab";
import KnowledgeTab from "../tabs/KnowledgeTab";
import SettingsTab from "../tabs/SettingsTab";

type Tab = "chat" | "board" | "coding" | "knowledge" | "settings";

export default function InstanceDetail() {
	const { id, "*": splat } = useParams<{ id: string; "*": string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [instance, setInstance] = useState<Instance | null>(null);

	// Parse initial tab from URL path
	const urlTab = (splat?.split("/")[0] || "") as Tab;
	const validTabs: Tab[] = ["chat", "board", "coding", "knowledge", "settings"];
	const initialTab = validTabs.includes(urlTab) ? urlTab : "chat";
	const [tab, setTab] = useState<Tab>(initialTab);
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

	// Voice: both push-to-talk and conversation mode auto-send via this ref
	const doSendRef = useRef<(text: string) => void>(() => {});
	const voice = useVoice(id, {
		onSend: (text) => doSendRef.current(text),
	});

	useEffect(() => {
		if (!id) return;
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
		} catch {}
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
	const doSend = useCallback(async (msg: string) => {
		console.log("[chat] doSend:", msg?.slice(0, 50), "id:", id);
		if (!msg.trim() || !id) return;
		setMessages((prev) => [...prev, { role: "user", content: msg }]);
		setThinking(true);
		try {
			// Always use /chat — it persists messages and works for all agents.
			// The AgentDO handles the response (uses BYOK AI or CF Workers AI).
			const data = await api<{ message?: Message }>(
				`/v1/instances/${id}/chat`,
				{ method: "POST", body: JSON.stringify({ message: msg }) },
			);
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
	}, [id]);

	// Wire the voice hook's auto-send to doSend
	doSendRef.current = doSend;

	const sendMessage = () => {
		if (!input.trim()) return;
		const msg = input.trim();
		setInput("");
		doSend(msg);
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
	const tabDefs: { id: Tab; label: string; icon: string }[] = [
		{ id: "chat", label: "Chat", icon: "💬" },
	];
	if (isApply || !surfaces.includes("coding")) tabDefs.push({ id: "board", label: "Board", icon: "📋" });
	if (surfaces.includes("coding")) tabDefs.push({ id: "coding", label: "Coding", icon: "💻" });
	tabDefs.push({ id: "knowledge", label: "Knowledge", icon: "📚" });
	tabDefs.push({ id: "settings", label: "Settings", icon: "⚙" });

	// Push instance controls into the shared Layout header
	const header = useHeaderSlot();
	useEffect(() => {
		header.set(
			<>
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
			</>
		);
		return () => header.set(null);
	}); // runs every render to keep tab/badge state current

	return (
		<div className="flex flex-col h-[calc(100dvh-49px)]">
			{/* Tab content — header is in the Layout now */}
			<div className="flex-1 overflow-auto px-2 py-2 sm:px-4 sm:py-3 flex flex-col min-h-0">
				{tab === "chat" && (
					<div className="flex flex-col flex-1 min-h-0">
						<div ref={chatRef} className="flex-1 overflow-y-auto flex flex-col gap-4 py-3 chat-scroll">
							{hasMore && (
								<button
									type="button"
									onClick={loadMore}
									disabled={loadingMore}
									className="self-center text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold transition-colors mb-2"
								>
									{loadingMore ? "Loading..." : "Load earlier messages"}
								</button>
							)}
							{messages.map((m, i) => (
								<div
									key={i}
									className={`group relative max-w-[92%] sm:max-w-[82%] px-3 py-2.5 sm:px-4 sm:py-3 rounded-2xl text-sm leading-relaxed ${
										m.role === "user"
											? "bg-accent text-white self-end rounded-br-sm shadow-sm"
											: m.role === "system"
												? "bg-yellow/10 text-yellow self-center rounded-full px-4 py-1.5 text-xs border border-yellow/15"
												: "bg-panel border border-line self-start rounded-bl-sm shadow-sm"
									}`}
								>
									{/* Copy button on each message */}
									<button
										type="button"
										onClick={() => copyMsgText(m.content)}
										className="absolute top-1 right-1.5 opacity-0 group-hover:opacity-100 text-[0.65rem] px-1.5 py-0.5 rounded bg-black/50 text-muted transition-opacity"
										title="Copy"
									>
										<Copy size={12} />
									</button>
									{m.role === "assistant" ? (
										<div className="msg-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
									) : (
										<span className="whitespace-pre-wrap">{m.content}</span>
									)}
								</div>
							))}
							{thinking && (
								<div className="text-muted text-sm flex items-center gap-2">
									<span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
									Agent is thinking...
								</div>
							)}
						</div>
						{/* Chat input bar with voice + action buttons */}
						<div className="flex gap-1 sm:gap-1.5 pt-2 sm:pt-3 border-t border-line shrink-0 items-center">
							<div className="flex-1 min-w-0 relative">
								<input
									value={voice.interim || input}
									onChange={(e) => { if (!voice.interim) setInput(e.target.value); }}
									onKeyDown={(e) => { if (e.key === "Enter" && !voice.interim) sendMessage(); }}
									placeholder={thinking && voice.convoOn ? "Agent is thinking..." : voice.micOn ? "Listening..." : voice.convoOn ? "Conversation mode — just talk" : isCoding ? "Ask about your repos, or tell it to do something..." : "Send a message..."}
									readOnly={!!voice.interim}
									className={`w-full bg-panel border rounded-xl px-4 py-2.5 text-sm transition-colors ${voice.interim ? "border-accent text-accent italic" : voice.micOn ? "border-green" : "border-line"}`}
								/>
								{/* Audio level visualizer — shows when mic is active */}
								{voice.micOn && (
									<div className="absolute bottom-0 left-2 right-2 h-1 rounded-full overflow-hidden bg-line/50">
										<div
											className="h-full bg-green rounded-full transition-all"
											style={{ width: `${Math.round(voice.audioLevel * 100)}%`, transitionDuration: "50ms" }}
										/>
									</div>
								)}
							</div>
							<button
								type="button"
								onClick={voice.toggleMic}
								title="Push to talk: click, speak, auto-submits when you stop"
								className={`px-2 py-2 text-sm border rounded-lg transition-colors ${voice.micOn ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}
							>
								<Mic size={16} />
							</button>
							<button
								type="button"
								onClick={voice.toggleSpeak}
								title="Auto-speak: read every agent response aloud"
								className={`px-2 py-2 text-sm border rounded-lg transition-colors ${voice.speakOn ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}
							>
								<Volume2 size={16} />
							</button>
							<button
								type="button"
								onClick={voice.toggleConvo}
								title="Conversation mode: hands-free continuous voice — just talk, auto-submits and speaks the reply"
								className={`px-2 py-2 text-sm border rounded-lg transition-colors ${voice.convoOn ? "border-green bg-green/15 text-green" : "border-line text-muted hover:border-accent hover:text-accent"}`}
							>
								<AudioLines size={16} />
							</button>
							<button
								type="button"
								onClick={sendMessage}
								disabled={!!voice.interim}
								title="Send message (Enter)"
								className="px-4 py-2.5 bg-accent text-white rounded-xl font-bold text-sm hover:bg-accent-hover transition-colors whitespace-nowrap disabled:opacity-40"
							>
								<span className="hidden sm:inline">Send</span>
								<Send size={16} className="sm:hidden" />
							</button>
							<button type="button" onClick={copyChat} title="Copy entire conversation as JSON to clipboard" className="px-2 py-2 text-sm border border-line rounded-lg text-muted hover:text-accent hover:border-accent transition-colors">
								<Copy size={14} />
							</button>
							<button type="button" onClick={clearChat} title="Clear all messages" className="px-2 py-2 text-sm border border-line rounded-lg text-red hover:bg-red/10 transition-colors">
								<Trash2 size={14} />
							</button>
						</div>
					</div>
				)}

				{tab === "board" && id && <BoardTab instanceId={id} isApply={isApply} />}
				{tab === "coding" && id && <CodingTab instanceId={id} />}
				{tab === "knowledge" && id && <KnowledgeTab instanceId={id} isApply={isApply} />}
				{tab === "settings" && id && <SettingsTab instanceId={id} isApply={isApply} onUnsubscribe={() => navigate("/instances")} />}
			</div>
		</div>
	);
}
