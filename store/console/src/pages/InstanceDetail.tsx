import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { Instance, Message } from "../lib/types";
import { renderMd } from "../lib/markdown";
import BoardTab from "../tabs/BoardTab";
import CodingTab from "../tabs/CodingTab";
import KnowledgeTab from "../tabs/KnowledgeTab";
import SettingsTab from "../tabs/SettingsTab";

type Tab = "chat" | "board" | "coding" | "knowledge" | "settings";

export default function InstanceDetail() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const [instance, setInstance] = useState<Instance | null>(null);
	const [tab, setTab] = useState<Tab>("chat");
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState("");
	const [thinking, setThinking] = useState(false);
	const chatRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!id) return;
		(async () => {
			try {
				const data = await api<{ instances: Instance[] }>(
					"/v1/instances/my/instances",
				);
				const inst = (data.instances || []).find(
					(i) => i.id === id || i.agent_slug === id,
				);
				if (inst) {
					setInstance(inst);
					// Default to coding tab for coding agents
					const surfaces = inst.capabilities?.surfaces || [];
					if (surfaces.includes("coding") && tab === "chat") setTab("coding");
				}
			} catch (e) {
				console.error(e);
			}
		})();
	}, [id]); // eslint-disable-line react-hooks/exhaustive-deps

	const loadMessages = useCallback(async () => {
		if (!id) return;
		try {
			const data = await api<{ messages: Message[] }>(
				`/v1/instances/${id}/messages`,
			);
			setMessages(data.messages || []);
		} catch {}
	}, [id]);

	useEffect(() => {
		loadMessages();
	}, [loadMessages]);

	useEffect(() => {
		if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
	}, [messages]);

	const sendMessage = async () => {
		if (!input.trim() || !id) return;
		const msg = input.trim();
		setInput("");
		setMessages((prev) => [...prev, { role: "user", content: msg }]);
		setThinking(true);
		try {
			const data = await api<{ message?: Message }>(
				`/v1/instances/${id}/chat`,
				{ method: "POST", body: JSON.stringify({ message: msg }) },
			);
			if (data.message) setMessages((prev) => [...prev, data.message!]);
		} catch (e) {
			setMessages((prev) => [
				...prev,
				{ role: "system", content: `Error: ${e instanceof Error ? e.message : String(e)}` },
			]);
		}
		setThinking(false);
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
				<button type="button" onClick={() => navigate("/instances")} className="text-sm text-muted hover:text-ink px-1">&larr;</button>
				{instance && (
					<span className="text-sm font-semibold truncate max-w-40 hidden sm:inline">{instance.agent_name}</span>
				)}
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
									className={`max-w-[82%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
										m.role === "user"
											? "bg-accent text-white self-end rounded-br-sm shadow-sm"
											: m.role === "system"
												? "bg-yellow/10 text-yellow self-center rounded-full px-4 py-1.5 text-xs border border-yellow/15"
												: "bg-panel border border-line self-start rounded-bl-sm shadow-sm"
									}`}
								>
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
						<div className="flex gap-1.5 pt-3 border-t border-line shrink-0 items-center">
							<input
								value={input}
								onChange={(e) => setInput(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") sendMessage(); }}
								placeholder="Send a message..."
								className="flex-1 bg-panel border border-line rounded-xl px-4 py-2.5 text-sm"
							/>
							<button type="button" onClick={sendMessage} className="px-4 py-2.5 bg-accent text-white rounded-xl font-bold text-sm hover:bg-accent-hover transition-colors whitespace-nowrap">
								Send
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
