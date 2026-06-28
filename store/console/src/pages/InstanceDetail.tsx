import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import type { Instance, Message } from "../lib/types";
import { renderMd } from "../lib/markdown";
import { usePolling } from "../hooks/usePolling";
import { useVoice } from "../hooks/useVoice";
import { Copy, Trash2, Mic, Volume2, AudioLines, Send, ArrowLeft } from "lucide-react";
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
	const [input, setInput] = useState("");
	const [thinking, setThinking] = useState(false);
	const chatRef = useRef<HTMLDivElement>(null);

	// Runtime status
	const [runnerOnline, setRunnerOnline] = useState<boolean | null>(null);
	const [runnerNode, setRunnerNode] = useState("");

	// Voice: auto-send callback needs sendMessage reference, use ref
	const sendRef = useRef<(text: string) => void>(() => {});
	const voice = useVoice(id, {
		onTranscript: (text) => setInput((prev) => (prev ? prev + " " : "") + text),
		onAutoSend: (text) => sendRef.current(text),
	});

	useEffect(() => {
		if (!id) return;
		(async () => {
			try {
				const data = await api<{ instances: Instance[] }>("/v1/instances/my/instances");
				const inst = (data.instances || []).find((i) => i.id === id || i.slug === id);
				if (inst) {
					setInstance(inst);
					const surfaces = inst.capabilities?.surfaces || [];
					if (surfaces.includes("coding") && tab === "chat") setTab("coding");
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

	const loadMessages = useCallback(async () => {
		if (!id) return;
		try {
			const data = await api<{ messages: Message[] }>(`/v1/instances/${id}/messages`);
			setMessages(data.messages || []);
		} catch {}
	}, [id]);

	useEffect(() => { loadMessages(); }, [loadMessages]);

	useEffect(() => {
		if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
	}, [messages]);

	const doSend = useCallback(async (msg: string) => {
		if (!msg.trim() || !id) return;
		setMessages((prev) => [...prev, { role: "user", content: msg }]);
		setThinking(true);
		try {
			const data = await api<{ message?: Message }>(
				`/v1/instances/${id}/chat`,
				{ method: "POST", body: JSON.stringify({ message: msg }) },
			);
			if (data.message) {
				setMessages((prev) => [...prev, data.message!]);
				// Speak response if auto-speak or conversation mode is on
				voice.maybeSpeakResponse(data.message.content);
			}
		} catch (e) {
			setMessages((prev) => [
				...prev,
				{ role: "system", content: `Error: ${e instanceof Error ? e.message : String(e)}` },
			]);
		}
		setThinking(false);
	}, [id, voice]);

	// Wire sendRef for conversation mode auto-send
	sendRef.current = doSend;

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
	const tabs: { id: Tab; label: string; icon: string }[] = [
		{ id: "chat", label: "Chat", icon: "💬" },
	];
	if (isApply || !surfaces.includes("coding")) tabs.push({ id: "board", label: "Board", icon: "📋" });
	if (surfaces.includes("coding")) tabs.push({ id: "coding", label: "Coding", icon: "💻" });
	tabs.push({ id: "knowledge", label: "Knowledge", icon: "📚" });
	tabs.push({ id: "settings", label: "Settings", icon: "⚙" });

	return (
		<div className="flex flex-col h-[calc(100dvh-49px)]">
			{/* Tab bar */}
			<div className="flex items-center gap-2 px-3 py-1.5 border-b border-line bg-panel">
				<button type="button" onClick={() => navigate("/instances")} className="text-sm text-muted hover:text-ink px-1"><ArrowLeft size={16} /></button>
				{instance && (
					<span className="text-sm font-semibold truncate max-w-40 hidden sm:inline">{instance.name}</span>
				)}
				{/* Runtime status badge */}
				<span
					className="text-xs font-bold px-1.5 py-0.5 rounded-full shrink-0 cursor-pointer"
					style={{ background: "var(--color-line)", color: runnerOnline ? "var(--color-green)" : "var(--color-muted)" }}
					title={runnerOnline ? `Runner online${runnerNode ? ` · ${runnerNode}` : ""}` : "Runner offline"}
				>
					{runnerOnline ? "●" : "○"}
				</span>
				<div className="flex border border-line rounded-lg overflow-x-auto overflow-y-hidden shrink min-w-0 scrollbar-none">
					{tabs.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => setTab(t.id)}
							className={`px-2.5 py-1 text-xs font-bold whitespace-nowrap shrink-0 transition-all ${tab === t.id ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel-hover"}`}
						>
							<span className="sm:hidden">{t.icon}</span>
							<span className="hidden sm:inline">{t.label}</span>
						</button>
					))}
				</div>
			</div>

			{/* Tab content */}
			<div className="flex-1 overflow-auto p-4 flex flex-col min-h-0">
				{tab === "chat" && (
					<div className="flex flex-col flex-1 min-h-0">
						<div ref={chatRef} className="flex-1 overflow-y-auto flex flex-col gap-4 py-3 chat-scroll">
							{messages.map((m, i) => (
								<div
									key={i}
									className={`group relative max-w-[82%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
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
						<div className="flex gap-1.5 pt-3 border-t border-line shrink-0 items-center">
							<input
								value={input}
								onChange={(e) => setInput(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") sendMessage(); }}
								placeholder="Send a message..."
								className="flex-1 bg-panel border border-line rounded-xl px-4 py-2.5 text-sm min-w-0"
							/>
							<button
								type="button"
								onClick={voice.toggleMic}
								title="Push to talk — fills input"
								className={`px-2 py-2 text-sm border rounded-lg transition-colors ${voice.micOn ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}
							>
								<Mic size={16} />
							</button>
							<button
								type="button"
								onClick={voice.toggleSpeak}
								title="Auto-speak responses"
								className={`px-2 py-2 text-sm border rounded-lg transition-colors ${voice.speakOn ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}
							>
								<Volume2 size={16} />
							</button>
							<button
								type="button"
								onClick={voice.toggleConvo}
								title="Conversation mode — continuous voice chat"
								className={`px-2 py-2 text-sm border rounded-lg transition-colors ${voice.convoOn ? "border-green bg-green/15 text-green" : "border-line text-muted hover:border-accent hover:text-accent"}`}
							>
								<AudioLines size={16} />
							</button>
							<button type="button" onClick={sendMessage} className="px-4 py-2.5 bg-accent text-white rounded-xl font-bold text-sm hover:bg-accent-hover transition-colors whitespace-nowrap">
								<span className="hidden sm:inline">Send</span>
								<Send size={16} className="sm:hidden" />
							</button>
							<button type="button" onClick={copyChat} title="Copy chat as JSON" className="px-2 py-2 text-sm border border-line rounded-lg text-muted hover:text-accent hover:border-accent transition-colors">
								<Copy size={14} />
							</button>
							<button type="button" onClick={clearChat} title="Clear chat" className="px-2 py-2 text-sm border border-line rounded-lg text-red hover:bg-red/10 transition-colors">
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
