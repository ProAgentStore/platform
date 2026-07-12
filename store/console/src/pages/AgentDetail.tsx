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

	// Subscriber settings schema — typed fields subscribers set on their instance's
	// Settings tab; values are injected into the chat prompt. Options edited as one
	// `value | Label` per line.
	type SField = { id: string; label: string; type: string; description: string; optionsText: string; defaultValue: string; voiceLanguage: boolean };
	const [sFields, setSFields] = useState<SField[]>([]);
	const loadSettingsSchema = useCallback(async () => {
		try {
			const d = await api<{ settingsSchema?: Array<{ id: string; label: string; type: string; description?: string; options?: Array<{ value: string; label: string }>; default?: string | number | boolean; voiceLanguage?: boolean }> }>(`/v1/agents/${id}/settings-schema`);
			setSFields((d.settingsSchema || []).map((f) => ({
				id: f.id,
				label: f.label,
				type: f.type,
				description: f.description || "",
				optionsText: (f.options || []).map((o) => (o.label === o.value ? o.value : `${o.value} | ${o.label}`)).join("\n"),
				defaultValue: f.default === undefined ? "" : String(f.default),
				voiceLanguage: f.voiceLanguage === true,
			})));
		} catch { /* none */ }
	}, [id]);
	const saveSettingsSchema = async () => {
		const wire = sFields.map((f) => {
			const options = f.optionsText.split("\n").flatMap((line) => {
				const [value, label] = line.split("|").map((s) => s.trim());
				return value ? [{ value, label: label || value }] : [];
			});
			let def: string | number | boolean | undefined;
			if (f.defaultValue.trim()) {
				if (f.type === "number") def = Number(f.defaultValue);
				else if (f.type === "toggle") def = f.defaultValue.trim() === "true";
				else def = f.defaultValue.trim();
			}
			return { id: f.id.trim(), label: f.label.trim(), type: f.type, description: f.description.trim() || undefined, options: f.type === "select" ? options : undefined, default: def, voiceLanguage: f.type === "select" && f.voiceLanguage ? true : undefined };
		});
		try {
			await api(`/v1/agents/${id}/settings-schema`, { method: "PUT", body: JSON.stringify({ settingsSchema: wire }) });
			await loadSettingsSchema(); // re-set from the server so the creator sees exactly what was kept
			alert("Subscriber settings saved.");
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
		else if (tab === "settings") { loadVersions(); loadSurfaces(); loadSettingsSchema(); }
	}, [tab, loadKnowledge, loadMemory, loadTasks, loadAnalytics, loadVersions, loadSettingsSchema]);

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

					{/* Subscriber settings (typed per-instance settings schema) */}
					<div className="bg-panel border border-line rounded-xl p-4 mb-4">
						<h3 className="text-base font-semibold mb-1">Subscriber settings</h3>
						<p className="text-xs text-muted mb-3">Typed settings each subscriber sets on their instance's Settings tab — injected into every chat as authoritative configuration (e.g. a tutor's target language). For selects, one option per line as <code>value | Label</code>.</p>
						<div className="flex flex-col gap-3">
							{sFields.map((f, i) => (
								<div key={i} className="border border-line rounded-lg p-2.5 flex flex-col gap-1.5">
									<div className="flex gap-2 flex-wrap">
										<input value={f.id} onChange={e => setSFields(fs => fs.map((x, j) => j === i ? { ...x, id: e.target.value } : x))} placeholder="id (e.g. target_language)" className="flex-1 min-w-32 bg-paper border border-line rounded px-2 py-1 text-sm font-mono" />
										<input value={f.label} onChange={e => setSFields(fs => fs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder="Label" className="flex-1 min-w-32 bg-paper border border-line rounded px-2 py-1 text-sm" />
										<select value={f.type} onChange={e => setSFields(fs => fs.map((x, j) => j === i ? { ...x, type: e.target.value } : x))} className="bg-paper border border-line rounded px-2 py-1 text-sm">
											<option value="select">select</option>
											<option value="text">text</option>
											<option value="number">number</option>
											<option value="toggle">toggle</option>
										</select>
										<button type="button" onClick={() => setSFields(fs => fs.filter((_, j) => j !== i))} className="text-red text-xs px-1.5">Remove</button>
									</div>
									<input value={f.description} onChange={e => setSFields(fs => fs.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} placeholder="Description shown under the label (optional)" className="bg-paper border border-line rounded px-2 py-1 text-sm" />
									<div className="flex gap-2 flex-wrap items-start">
										{f.type === "select" && (
											<textarea value={f.optionsText} onChange={e => setSFields(fs => fs.map((x, j) => j === i ? { ...x, optionsText: e.target.value } : x))} placeholder={"zh-CN | Chinese (Mandarin)\nes-ES | Spanish"} className="flex-1 min-w-48 min-h-[64px] bg-paper border border-line rounded px-2 py-1 text-sm font-mono" />
										)}
										<input value={f.defaultValue} onChange={e => setSFields(fs => fs.map((x, j) => j === i ? { ...x, defaultValue: e.target.value } : x))} placeholder={f.type === "toggle" ? "default: true / false" : "default (optional)"} className="w-44 bg-paper border border-line rounded px-2 py-1 text-sm" />
										{f.type === "select" && (
											<label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer mt-1">
												<input type="checkbox" checked={f.voiceLanguage} onChange={e => setSFields(fs => fs.map((x, j) => j === i ? { ...x, voiceLanguage: e.target.checked } : x))} className="w-3.5 h-3.5 accent-accent" />
												Drives voice language (option values must be BCP-47 tags like zh-CN)
											</label>
										)}
									</div>
								</div>
							))}
							{sFields.length === 0 && <div className="text-xs text-muted-soft">No subscriber settings yet — add a field to give subscribers typed configuration.</div>}
						</div>
						<div className="flex gap-2 mt-3">
							<button type="button" onClick={() => setSFields(fs => [...fs, { id: "", label: "", type: "select", description: "", optionsText: "", defaultValue: "", voiceLanguage: false }])} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">+ Add field</button>
							<button type="button" onClick={saveSettingsSchema} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Save settings</button>
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
	type BuilderPlan = {
		intent: string;
		action: "create_agent" | "scaffold_agent";
		agent: {
			slug: string;
			name: string;
			description: string;
			category: string;
			model: string;
			personality: string;
			goal: string;
		};
		template?: "worker" | "cron" | "api";
		runtime?: { kind: "hosted" | "browser" | "coder"; reason: string };
		connectors: Array<{ provider: string; reason: string; requiredGrant: string }>;
		suggestedSurfaces: string[];
		warnings: string[];
		dryRun: { endpoint: string; method: string; body: Record<string, unknown> };
	};
	const [prompt, setPrompt] = useState("");
	const [plan, setPlan] = useState<BuilderPlan | null>(null);
	const [planning, setPlanning] = useState(false);
	const [executing, setExecuting] = useState(false);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [error, setError] = useState("");

	const updateAgent = (patch: Partial<BuilderPlan["agent"]>) => {
		setPlan(current => current ? { ...current, agent: { ...current.agent, ...patch } } : current);
	};

	const buildPlan = async () => {
		if (!prompt.trim()) { setError("Describe the agent you want to create."); return; }
		setPlanning(true);
		setError("");
		try {
			const res = await api<{ plan: BuilderPlan }>("/v1/agent-builder/plan", {
				method: "POST",
				body: JSON.stringify({ prompt }),
			});
			setPlan(res.plan);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setPlanning(false);
		}
	};

	const execute = async () => {
		if (!plan) return;
		setExecuting(true);
		setError("");
		try {
			const res = await api<{ result: { agentId: string } }>("/v1/agent-builder/execute", {
				method: "POST",
				body: JSON.stringify({ plan }),
			});
			if (res.result?.agentId) navigate(`/agents/${res.result.agentId}`);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setExecuting(false);
		}
	};

	return (
		<div className="max-w-[960px] mx-auto px-3 py-3 sm:px-6 sm:py-5">
			<button type="button" onClick={() => navigate("/agents")} className="text-sm text-muted mb-3 inline-flex items-center gap-1 hover:text-ink">&larr; Back</button>
			<h2 className="font-display text-xl font-bold mb-2">Create Agent</h2>
			<p className="text-sm text-muted mb-4">Describe what you want. ProAgentStore will choose the right creation path, then show a plan before anything is created.</p>

			<div className="bg-panel border border-line rounded-xl p-4 mb-4">
				<label htmlFor="agent-builder-prompt" className="text-xs text-muted font-semibold block mb-1">Agent prompt</label>
				<textarea
					id="agent-builder-prompt"
					value={prompt}
					onChange={e => setPrompt(e.target.value)}
					placeholder="Create an agent that reviews Google Docs in a project folder and summarizes contract risks."
					className="min-h-[120px]"
				/>
				<div className="flex gap-2 mt-4">
					<button type="button" onClick={buildPlan} disabled={planning} className="text-sm px-4 py-2 rounded-xl bg-accent text-white font-bold hover:bg-accent-hover disabled:opacity-60">{planning ? "Planning..." : "Plan Agent"}</button>
					<button type="button" onClick={() => navigate("/agents")} className="text-sm px-3 py-2 rounded-xl border border-line text-muted font-semibold">Cancel</button>
				</div>
				{error && <div className="text-red text-sm mt-2">{error}</div>}
			</div>

			{plan && (
				<div className="bg-panel border border-line rounded-xl p-4">
					<div className="flex items-start justify-between gap-3 mb-4 max-sm:flex-col">
						<div>
							<div className="text-xs uppercase tracking-wide text-accent font-bold mb-1">Review plan</div>
							<h3 className="font-display text-lg font-bold">{plan.agent.name}</h3>
							<p className="text-sm text-muted mt-1">{plan.agent.description}</p>
						</div>
						<div className="flex gap-2 text-xs font-bold">
							<span className="px-2 py-1 rounded-lg bg-accent-soft text-purple-400">{plan.action === "scaffold_agent" ? "Scaffold" : "Draft chat"}</span>
							<span className="px-2 py-1 rounded-lg bg-panel-2 border border-line text-muted">{plan.runtime?.kind || "hosted"}</span>
						</div>
					</div>

					<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
						<div><label htmlFor="agent-builder-slug" className="text-xs text-muted font-semibold block mb-1">Slug</label><input id="agent-builder-slug" value={plan.agent.slug} onChange={e => updateAgent({ slug: e.target.value })} /></div>
						<div><label htmlFor="agent-builder-name" className="text-xs text-muted font-semibold block mb-1">Name</label><input id="agent-builder-name" value={plan.agent.name} onChange={e => updateAgent({ name: e.target.value })} /></div>
					</div>
					<div className="mt-3"><label htmlFor="agent-builder-description" className="text-xs text-muted font-semibold block mb-1">Description</label><input id="agent-builder-description" value={plan.agent.description} onChange={e => updateAgent({ description: e.target.value })} /></div>
					<div className="grid grid-cols-2 gap-3 mt-3 max-sm:grid-cols-1">
						<div><label htmlFor="agent-builder-category" className="text-xs text-muted font-semibold block mb-1">Category</label><select id="agent-builder-category" value={plan.agent.category} onChange={e => updateAgent({ category: e.target.value })}>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
						<div><label htmlFor="agent-builder-template" className="text-xs text-muted font-semibold block mb-1">Template</label><input id="agent-builder-template" value={plan.template || "none"} readOnly /></div>
					</div>

					<div className="mt-4 grid grid-cols-3 gap-3 max-md:grid-cols-1">
						<div className="border border-line rounded-lg p-3">
							<div className="text-xs text-muted font-bold mb-1">Surfaces</div>
							<div className="text-sm">{plan.suggestedSurfaces.join(", ")}</div>
						</div>
						<div className="border border-line rounded-lg p-3">
							<div className="text-xs text-muted font-bold mb-1">Runtime</div>
							<div className="text-sm">{plan.runtime?.kind || "hosted"}</div>
						</div>
						<div className="border border-line rounded-lg p-3">
							<div className="text-xs text-muted font-bold mb-1">Connectors</div>
							<div className="text-sm">{plan.connectors.length ? plan.connectors.map(c => c.provider).join(", ") : "none"}</div>
						</div>
					</div>

					{plan.connectors.length > 0 && (
						<div className="mt-4 border border-amber/30 bg-amber/10 rounded-lg p-3">
							<div className="text-sm font-bold text-amber mb-1">Connector grants needed after creation</div>
							<ul className="text-sm text-muted list-disc pl-5">
								{plan.connectors.map(c => <li key={`${c.provider}-${c.requiredGrant}`}>{c.provider}: grant a {c.requiredGrant}. {c.reason}</li>)}
							</ul>
						</div>
					)}

					{plan.warnings.length > 0 && (
						<div className="mt-4 text-sm text-muted">
							{plan.warnings.map(w => <div key={w}>- {w}</div>)}
						</div>
					)}

					<button type="button" onClick={() => setShowAdvanced(v => !v)} className="mt-4 text-sm text-muted hover:text-ink">{showAdvanced ? "Hide advanced" : "Show advanced"}</button>
					{showAdvanced && (
						<div className="grid grid-cols-2 gap-3 mt-3 max-sm:grid-cols-1">
							<div><label htmlFor="agent-builder-model" className="text-xs text-muted font-semibold block mb-1">Model</label><select id="agent-builder-model" value={plan.agent.model} onChange={e => updateAgent({ model: e.target.value })}>{MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></div>
							<div><label htmlFor="agent-builder-action" className="text-xs text-muted font-semibold block mb-1">Action</label><input id="agent-builder-action" value={plan.action} readOnly /></div>
							<div><label htmlFor="agent-builder-personality" className="text-xs text-muted font-semibold block mb-1">Personality</label><textarea id="agent-builder-personality" value={plan.agent.personality} onChange={e => updateAgent({ personality: e.target.value })} /></div>
							<div><label htmlFor="agent-builder-goal" className="text-xs text-muted font-semibold block mb-1">Goal</label><textarea id="agent-builder-goal" value={plan.agent.goal} onChange={e => updateAgent({ goal: e.target.value })} /></div>
						</div>
					)}

					<div className="flex gap-2 mt-5">
						<button type="button" onClick={execute} disabled={executing} className="text-sm px-4 py-2 rounded-xl bg-accent text-white font-bold hover:bg-accent-hover disabled:opacity-60">{executing ? "Creating..." : "Approve and Create"}</button>
						<button type="button" onClick={() => setPlan(null)} className="text-sm px-3 py-2 rounded-xl border border-line text-muted font-semibold">Revise prompt</button>
					</div>
				</div>
			)}
		</div>
	);
}
