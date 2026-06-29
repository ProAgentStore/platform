import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { Agent, Message, KnowledgeDoc, MemoryEntry } from "../lib/types";
import { renderMd } from "@proagentstore/sdk/ui";
import { Zap, ArrowLeft } from "lucide-react";

type Tab = "chat" | "knowledge" | "memory" | "tasks" | "settings" | "analytics" | "ops";

const CATEGORIES = ["general", "chat", "code", "data", "creative", "productivity"];
const MODELS = [
	{ value: "@cf/meta/llama-3.2-3b-instruct", label: "Llama 3.2 3B (fast)" },
	{ value: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B" },
	{ value: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B" },
	{ value: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 24B" },
	{ value: "@cf/qwen/qwen2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B" },
];

export default function AgentDetail() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const [agent, setAgent] = useState<Agent | null>(null);
	const [tab, setTab] = useState<Tab>("chat");

	// Chat
	const [messages, setMessages] = useState<Message[]>([]);
	const [chatInput, setChatInput] = useState("");
	const [thinking, setThinking] = useState(false);
	const chatRef = useRef<HTMLDivElement>(null);

	// Knowledge
	const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
	const [memories, setMemories] = useState<MemoryEntry[]>([]);
	const [tasks, setTasks] = useState<{ id: string; title: string; status: string; description?: string }[]>([]);

	// Settings
	const [sName, setSName] = useState("");
	const [sDesc, setSDesc] = useState("");
	const [sCat, setSCat] = useState("general");
	const [sVis, setSVis] = useState("draft");
	const [sModel, setSModel] = useState(MODELS[0].value);
	const [sPersonality, setSPersonality] = useState("");
	const [sGoal, setSGoal] = useState("");
	const [sWelcome, setSWelcome] = useState("");

	// Analytics
	const [analytics, setAnalytics] = useState<Record<string, unknown> | null>(null);

	// Versions
	const [versions, setVersions] = useState<{ id: string; version_num: number; description: string; created_at: string }[]>([]);

	// Custom surfaces (Phase 3 — agent-published UIs)
	type CSurface = { id: string; label: string; icon?: string; bundleUrl: string };
	const [surfaces, setSurfaces] = useState<CSurface[]>([]);
	const loadSurfaces = useCallback(async () => {
		try {
			const d = await api<{ customSurfaces?: CSurface[] }>(`/v1/agents/${id}/capabilities`);
			setSurfaces(d.customSurfaces || []);
		} catch { /* none */ }
	}, [id]);
	const saveSurfaces = async () => {
		const clean = surfaces.filter((s) => s.id.trim() && s.label.trim() && /^https:\/\//.test(s.bundleUrl.trim()));
		try {
			const d = await api<{ customSurfaces: CSurface[] }>(`/v1/agents/${id}/capabilities`, { method: "PUT", body: JSON.stringify({ customSurfaces: clean }) });
			setSurfaces(d.customSurfaces || []);
			alert("Custom surfaces saved. Subscribers see them on their next load.");
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const loadAgent = useCallback(async () => {
		if (!id) return;
		try {
			const a = await api<Agent>(`/v1/agents/${id}`);
			setAgent(a);
			setSName(a.name);
			setSDesc(a.description);
			setSCat(a.category);
			setSVis(a.visibility);
			setSModel(a.model || MODELS[0].value);
			// Load DO state
			try {
				const state = await api<Record<string, unknown>>(`/v1/agents/${a.id}/state`);
				setSPersonality(String(state.personality || ""));
				setSGoal(String(state.goal || ""));
				setSWelcome(String(state.welcomeMessage || ""));
			} catch {}
		} catch (e) {
			console.error(e);
		}
	}, [id]);

	useEffect(() => { loadAgent(); }, [loadAgent]);

	// Chat
	const loadMessages = useCallback(async () => {
		if (!id) return;
		try {
			const d = await api<{ messages: Message[] }>(`/v1/agents/${id}/messages`);
			setMessages(d.messages || []);
		} catch {}
	}, [id]);

	useEffect(() => { loadMessages(); }, [loadMessages]);
	useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [messages]);

	const sendMessage = async () => {
		if (!chatInput.trim() || !id) return;
		const msg = chatInput.trim();
		setChatInput("");
		setMessages(p => [...p, { role: "user", content: msg }]);
		setThinking(true);
		try {
			const d = await api<{ message?: Message }>(`/v1/agents/${id}/chat`, { method: "POST", body: JSON.stringify({ message: msg }) });
			if (d.message) setMessages(p => [...p, d.message!]);
		} catch (e) {
			setMessages(p => [...p, { role: "system", content: `Error: ${e instanceof Error ? e.message : String(e)}` }]);
		}
		setThinking(false);
	};

	// Knowledge
	const loadKnowledge = useCallback(async () => {
		if (!id) return;
		try { const d = await api<{ documents: KnowledgeDoc[] }>(`/v1/agents/${id}/knowledge`); setDocs(d.documents || []); } catch {}
	}, [id]);
	const loadMemory = useCallback(async () => {
		if (!id) return;
		try { const d = await api<{ memory: MemoryEntry[] }>(`/v1/agents/${id}/memory`); setMemories(d.memory || []); } catch {}
	}, [id]);
	const loadTasks = useCallback(async () => {
		if (!id) return;
		try { const d = await api<{ tasks: { id: string; title: string; status: string; description?: string }[] }>(`/v1/agents/${id}/tasks`); setTasks(d.tasks || []); } catch {}
	}, [id]);
	const loadAnalytics = useCallback(async () => {
		if (!id) return;
		try { const d = await api<Record<string, unknown>>(`/v1/agents/${id}/analytics`); setAnalytics(d); } catch {}
	}, [id]);
	const loadVersions = useCallback(async () => {
		if (!id) return;
		try { const d = await api<{ versions: { id: string; version_num: number; description: string; created_at: string }[] }>(`/v1/agents/${id}/versions`); setVersions(d.versions || []); } catch {}
	}, [id]);

	// Lazy-load: only fetch data for the active tab
	useEffect(() => {
		if (tab === "knowledge") loadKnowledge();
		else if (tab === "memory") loadMemory();
		else if (tab === "tasks") loadTasks();
		else if (tab === "analytics") loadAnalytics();
		else if (tab === "settings") { loadVersions(); loadSurfaces(); }
	}, [tab, loadKnowledge, loadMemory, loadTasks, loadAnalytics, loadVersions]);

	const saveSettings = async () => {
		if (!id) return;
		try {
			await api(`/v1/agents/${id}`, { method: "PUT", body: JSON.stringify({ name: sName, description: sDesc, category: sCat, visibility: sVis, model: sModel }) });
			await api(`/v1/agents/${id}/state`, { method: "PUT", body: JSON.stringify({ name: sName, personality: sPersonality, goal: sGoal, model: sModel, welcomeMessage: sWelcome }) });
			alert("Saved!");
			loadAgent();
		} catch (e) { alert(e instanceof Error ? e.message : String(e)); }
	};

	const deleteAgent = async () => {
		if (!confirm(`Delete "${agent?.name}"? This cannot be undone.`)) return;
		try {
			await api(`/v1/agents/${id}`, { method: "DELETE" });
			navigate("/agents");
		} catch (e) { alert(e instanceof Error ? e.message : String(e)); }
	};

	const exportAgent = async () => {
		try {
			const data = await api(`/v1/agents/${id}/export`);
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${agent?.slug || "agent"}-backup.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) { alert(e instanceof Error ? e.message : String(e)); }
	};

	const saveVersion = async () => {
		const desc = prompt("Version description (optional):") || "";
		try {
			await api(`/v1/agents/${id}/versions`, { method: "POST", body: JSON.stringify({ description: desc }) });
			loadVersions();
		} catch (e) { alert(e instanceof Error ? e.message : String(e)); }
	};

	// Create mode — no id means /agents/new
	if (!id) return <CreateAgent />;

	if (!agent) return <div className="max-w-[960px] mx-auto px-3 py-6 text-muted text-sm">Loading agent...</div>;

	const allTabs: { id: Tab; label: string }[] = [
		{ id: "chat", label: "Chat" }, { id: "knowledge", label: "Knowledge" },
		{ id: "memory", label: "Memory" }, { id: "tasks", label: "Tasks" },
		{ id: "settings", label: "Settings" }, { id: "analytics", label: "Analytics" },
		{ id: "ops", label: "Ops" },
	];

	return (
		<div className="max-w-[960px] mx-auto px-3 py-3 sm:px-6 sm:py-5">
			<button type="button" onClick={() => navigate("/agents")} className="text-sm text-muted mb-3 inline-flex items-center gap-1 hover:text-ink"><ArrowLeft size={14} /> Back</button>

			{/* Header */}
			<div className="flex items-start gap-4 mb-4">
				<div className="w-[52px] h-[52px] rounded-[14px] flex items-center justify-center text-xl shrink-0 shadow-lg" style={{ background: agent.icon_bg || "#7c3aed" }}><Zap size={22} className="text-white" /></div>
				<div>
					<h2 className="font-display text-xl font-bold">{agent.name}</h2>
					<div className="text-xs text-muted">{agent.slug}</div>
					<div className="text-sm text-muted mt-1">{agent.description}</div>
				</div>
			</div>

			{/* Tabs */}
			<div className="flex gap-0 border-b border-line mb-4 overflow-x-auto">
				{allTabs.map(t => (
					<button key={t.id} type="button" onClick={() => setTab(t.id)}
						className={`px-3 py-2 text-sm font-bold uppercase tracking-wide border-b-2 whitespace-nowrap transition-all ${tab === t.id ? "text-accent border-accent" : "text-muted border-transparent hover:text-ink"}`}
					>{t.label}</button>
				))}
			</div>

			{/* Chat */}
			{tab === "chat" && (
				<div className="flex flex-col" style={{ height: "calc(100dvh - 320px)", minHeight: 300 }}>
					<div ref={chatRef} className="flex-1 overflow-y-auto flex flex-col gap-4 py-3 chat-scroll">
						{messages.map((m, i) => (
							<div key={i} className={`max-w-[82%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${m.role === "user" ? "bg-accent text-white self-end rounded-br-sm" : m.role === "system" ? "bg-yellow/10 text-yellow self-center rounded-full px-4 py-1.5 text-xs border border-yellow/15" : "bg-panel border border-line self-start rounded-bl-sm"}`}>
								{m.role === "assistant" ? <div className="msg-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} /> : <span className="whitespace-pre-wrap">{m.content}</span>}
							</div>
						))}
						{thinking && <div className="text-muted text-sm flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-accent animate-pulse" />Thinking...</div>}
					</div>
					<div className="flex gap-1.5 pt-3 border-t border-line shrink-0">
						<input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") sendMessage(); }} placeholder="Send a message..." className="flex-1 bg-panel border border-line rounded-xl px-4 py-2.5 text-sm" />
						<button type="button" onClick={sendMessage} className="px-4 py-2.5 bg-accent text-white rounded-xl font-bold text-sm hover:bg-accent-hover">Send</button>
					</div>
				</div>
			)}

			{/* Knowledge */}
			{tab === "knowledge" && (
				<div>
					<h3 className="text-base font-bold mb-3">Knowledge Base</h3>
					{docs.length === 0 ? <p className="text-muted-soft text-sm text-center py-4">No documents yet.</p> : (
						<div className="flex flex-col gap-2">
							{docs.map(d => (
								<div key={d.id} className="bg-panel border border-line rounded-lg p-3 flex justify-between items-start gap-3">
									<div><div className="font-semibold text-sm">{d.title}</div>{d.source && <div className="text-xs text-muted">{d.source}</div>}</div>
									<button type="button" onClick={async () => { if (confirm("Delete?")) { await api(`/v1/agents/${id}/knowledge/${d.id}`, { method: "DELETE" }); loadKnowledge(); }}} className="text-xs text-red shrink-0">Delete</button>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Memory */}
			{tab === "memory" && (
				<div>
					<h3 className="text-base font-bold mb-3">Agent Memory</h3>
					{memories.length === 0 ? <p className="text-muted-soft text-sm text-center py-4">No memories yet.</p> : (
						<div className="flex flex-col gap-2">
							{memories.map(m => (
								<div key={m.key} className="bg-panel border border-line rounded-lg p-3">
									<span className="font-semibold text-sm">{m.key}</span>
									<span className="text-xs text-purple-400 ml-2">{m.type}</span>
									<div className="text-sm text-muted mt-1">{m.content}</div>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Tasks */}
			{tab === "tasks" && (
				<div>
					<h3 className="text-base font-bold mb-3">Agent Tasks</h3>
					{tasks.length === 0 ? <p className="text-muted-soft text-sm text-center py-4">No tasks yet.</p> : (
						<div className="flex flex-col gap-2">
							{tasks.map(t => (
								<div key={t.id} className="bg-panel border border-line rounded-lg p-3">
									<span className="font-semibold text-sm">{t.title}</span>
									<span className={`text-xs ml-2 px-1.5 py-0.5 rounded font-medium ${t.status === "complete" ? "bg-green/15 text-green" : t.status === "in_progress" ? "bg-blue/15 text-blue" : "bg-yellow/15 text-yellow"}`}>{t.status.replace("_", " ")}</span>
									{t.description && <div className="text-sm text-muted mt-1">{t.description}</div>}
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Settings */}
			{tab === "settings" && (
				<div>
					<div className="bg-panel border border-line rounded-xl p-4 mb-4">
						<h3 className="text-base font-semibold mb-3">Identity</h3>
						<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
							<div><label className="text-xs text-muted font-semibold block mb-1">Name</label><input value={sName} onChange={e => setSName(e.target.value)} /></div>
							<div><label className="text-xs text-muted font-semibold block mb-1">Category</label><select value={sCat} onChange={e => setSCat(e.target.value)}>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
						</div>
						<div className="mt-3"><label className="text-xs text-muted font-semibold block mb-1">Description</label><textarea value={sDesc} onChange={e => setSDesc(e.target.value)} /></div>
						<div className="grid grid-cols-2 gap-3 mt-3 max-sm:grid-cols-1">
							<div><label className="text-xs text-muted font-semibold block mb-1">Personality</label><textarea value={sPersonality} onChange={e => setSPersonality(e.target.value)} /></div>
							<div><label className="text-xs text-muted font-semibold block mb-1">Goal</label><textarea value={sGoal} onChange={e => setSGoal(e.target.value)} /></div>
						</div>
						<div className="mt-3"><label className="text-xs text-muted font-semibold block mb-1">Welcome Message</label><input value={sWelcome} onChange={e => setSWelcome(e.target.value)} /></div>
					</div>

					<div className="bg-panel border border-line rounded-xl p-4 mb-4">
						<h3 className="text-base font-semibold mb-3">Model & Publishing</h3>
						<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
							<div><label className="text-xs text-muted font-semibold block mb-1">Visibility</label><select value={sVis} onChange={e => setSVis(e.target.value)}><option value="draft">Draft</option><option value="published">Published</option><option value="unlisted">Unlisted</option></select></div>
							<div><label className="text-xs text-muted font-semibold block mb-1">Model</label><select value={sModel} onChange={e => setSModel(e.target.value)}>{MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></div>
						</div>
					</div>

					{/* Custom surfaces (Phase 3) */}
					<div className="bg-panel border border-line rounded-xl p-4 mb-4">
						<h3 className="text-base font-semibold mb-1">Custom surfaces</h3>
						<p className="text-xs text-muted mb-3">Ship your own UI as a published bundle — each loads from an https URL that exports <code>mount(ctx)</code>. See docs/custom-surfaces.md (example: <code>/console/surfaces/notes.js</code>).</p>
						<div className="flex flex-col gap-3">
							{surfaces.map((s, i) => (
								<div key={i} className="border border-line rounded-lg p-2.5 flex flex-col gap-1.5">
									<div className="flex gap-2">
										<input value={s.id} onChange={e => setSurfaces(cs => cs.map((x, j) => j === i ? { ...x, id: e.target.value } : x))} placeholder="id (e.g. notes)" className="flex-1 bg-paper border border-line rounded px-2 py-1 text-sm" />
										<input value={s.label} onChange={e => setSurfaces(cs => cs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder="Label" className="flex-1 bg-paper border border-line rounded px-2 py-1 text-sm" />
										<input value={s.icon || ""} onChange={e => setSurfaces(cs => cs.map((x, j) => j === i ? { ...x, icon: e.target.value } : x))} placeholder="🧩" className="w-12 bg-paper border border-line rounded px-2 py-1 text-sm text-center" />
										<button type="button" onClick={() => setSurfaces(cs => cs.filter((_, j) => j !== i))} className="text-red text-xs px-1.5">Remove</button>
									</div>
									<input value={s.bundleUrl} onChange={e => setSurfaces(cs => cs.map((x, j) => j === i ? { ...x, bundleUrl: e.target.value } : x))} placeholder="https://…/surface.js" className="bg-paper border border-line rounded px-2 py-1 text-sm font-mono" />
								</div>
							))}
							{surfaces.length === 0 && <div className="text-xs text-muted-soft">No custom surfaces yet — add one to ship your own UI.</div>}
						</div>
						<div className="flex gap-2 mt-3">
							<button type="button" onClick={() => setSurfaces(cs => [...cs, { id: "", label: "", bundleUrl: "" }])} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">+ Add surface</button>
							<button type="button" onClick={saveSurfaces} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Save surfaces</button>
						</div>
					</div>

					<div className="flex gap-2 flex-wrap">
						<button type="button" onClick={saveSettings} className="text-sm px-4 py-2 rounded-xl bg-accent text-white font-bold hover:bg-accent-hover">Save All Settings</button>
						<button type="button" onClick={exportAgent} className="text-sm px-3 py-2 rounded-xl border border-line text-muted font-semibold">Export JSON</button>
						<button type="button" onClick={saveVersion} className="text-sm px-3 py-2 rounded-xl border border-line text-muted font-semibold">Save Version</button>
						<button type="button" onClick={deleteAgent} className="text-sm px-3 py-2 rounded-xl bg-red text-white font-semibold hover:opacity-90">Delete Agent</button>
					</div>

					{/* Versions */}
					{versions.length > 0 && (
						<div className="bg-panel border border-line rounded-xl p-4 mt-4">
							<h3 className="text-sm font-semibold mb-3">Version History</h3>
							<div className="flex flex-col gap-2">
								{versions.map(v => (
									<div key={v.id} className="flex justify-between items-center p-2.5 bg-paper border border-line rounded-lg">
										<div>
											<span className="font-semibold text-sm">v{v.version_num}</span>
											<span className="text-sm text-muted ml-2">{v.description}</span>
											<span className="text-xs text-muted-soft ml-2">{new Date(v.created_at).toLocaleString()}</span>
										</div>
										<button type="button" onClick={async () => {
											if (!confirm(`Rollback to v${v.version_num}?`)) return;
											await api(`/v1/agents/${id}/versions/${v.id}/rollback`, { method: "POST" });
											loadAgent();
										}} className="text-xs px-2.5 py-1 rounded-md border border-line text-muted font-semibold">Rollback</button>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			)}

			{/* Analytics */}
			{tab === "analytics" && (
				<div>
					{!analytics ? <p className="text-muted text-sm">Loading analytics...</p> : (
						<>
							<div className="grid grid-cols-3 gap-3 mb-4 max-sm:grid-cols-1">
								{[["Subscribers", analytics.subscribers], ["Chat Messages", analytics.totalChats], ["Executions", analytics.totalExecutions]].map(([label, val]) => (
									<div key={String(label)} className="bg-panel border border-line rounded-xl p-4 text-center">
										<div className="text-2xl font-bold">{String(val || 0)}</div>
										<div className="text-xs text-muted">{String(label)}</div>
									</div>
								))}
							</div>
							<div className="bg-panel border border-line rounded-xl p-4">
								<h3 className="text-sm font-semibold mb-3">Daily Usage (last 30 days)</h3>
								<div className="flex items-end gap-0.5 h-20">
									{((analytics.dailyUsage as { day: string; count: number }[]) || []).map((d, i) => {
										const max = Math.max(1, ...((analytics.dailyUsage as { count: number }[]) || []).map(x => x.count));
										return <div key={i} className="flex-1 min-w-[3px] bg-accent rounded-t" style={{ height: `${Math.max(4, (d.count / max) * 100)}%` }} title={`${d.day}: ${d.count}`} />;
									})}
								</div>
							</div>
						</>
					)}
				</div>
			)}

			{/* Ops */}
			{tab === "ops" && (
				<div className="text-center py-8 text-muted text-sm">Ops — API billing, deploy status, health checks. Full port coming soon.</div>
			)}
		</div>
	);
}

function CreateAgent() {
	const navigate = useNavigate();
	const [slug, setSlug] = useState("");
	const [name, setName] = useState("");
	const [desc, setDesc] = useState("");
	const [cat, setCat] = useState("general");
	const [model, setModel] = useState(MODELS[0].value);
	const [personality, setPersonality] = useState("");
	const [goal, setGoal] = useState("");
	const [error, setError] = useState("");

	const create = async () => {
		if (!slug.trim() || !name.trim()) { setError("Slug and name required"); return; }
		try {
			const res = await api<{ id: string }>("/v1/agents", {
				method: "POST",
				body: JSON.stringify({ slug, name, description: desc, category: cat, model, personality, goal }),
			});
			if (res.id) navigate(`/agents/${res.id}`);
		} catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	};

	return (
		<div className="max-w-[960px] mx-auto px-3 py-3 sm:px-6 sm:py-5">
			<button type="button" onClick={() => navigate("/agents")} className="text-sm text-muted mb-3 inline-flex items-center gap-1 hover:text-ink">&larr; Back</button>
			<h2 className="font-display text-xl font-bold mb-4">Create Agent</h2>
			<div className="bg-panel border border-line rounded-xl p-4">
				<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
					<div><label className="text-xs text-muted font-semibold block mb-1">Slug</label><input value={slug} onChange={e => setSlug(e.target.value)} placeholder="my-agent" /></div>
					<div><label className="text-xs text-muted font-semibold block mb-1">Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="My Agent" /></div>
				</div>
				<div className="grid grid-cols-2 gap-3 mt-3 max-sm:grid-cols-1">
					<div><label className="text-xs text-muted font-semibold block mb-1">Category</label><select value={cat} onChange={e => setCat(e.target.value)}>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
					<div><label className="text-xs text-muted font-semibold block mb-1">Model</label><select value={model} onChange={e => setModel(e.target.value)}>{MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></div>
				</div>
				<div className="mt-3"><label className="text-xs text-muted font-semibold block mb-1">Description</label><input value={desc} onChange={e => setDesc(e.target.value)} placeholder="What does this agent do?" /></div>
				<div className="grid grid-cols-2 gap-3 mt-3 max-sm:grid-cols-1">
					<div><label className="text-xs text-muted font-semibold block mb-1">Personality</label><textarea value={personality} onChange={e => setPersonality(e.target.value)} placeholder="How should the agent behave?" /></div>
					<div><label className="text-xs text-muted font-semibold block mb-1">Goal</label><textarea value={goal} onChange={e => setGoal(e.target.value)} placeholder="What should the agent accomplish?" /></div>
				</div>
				<div className="flex gap-2 mt-4">
					<button type="button" onClick={create} className="text-sm px-4 py-2 rounded-xl bg-accent text-white font-bold hover:bg-accent-hover">Create</button>
					<button type="button" onClick={() => navigate("/agents")} className="text-sm px-3 py-2 rounded-xl border border-line text-muted font-semibold">Cancel</button>
				</div>
				{error && <div className="text-red text-sm mt-2">{error}</div>}
			</div>
		</div>
	);
}
