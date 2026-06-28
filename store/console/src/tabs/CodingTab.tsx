import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../lib/api";
import type { CodingRepo, CodingSession, CodingEngine } from "../lib/types";
import { mdLite, formatTime } from "../lib/markdown";
import { usePolling } from "../hooks/usePolling";
import { ArrowLeft, Trash2, Satellite, Plus } from "lucide-react";

interface Props {
	instanceId: string;
}

interface TimelineEntry {
	role?: string;
	type?: string;
	content?: string;
	text?: string;
	seq?: number;
}

export default function CodingTab({ instanceId }: Props) {
	const [repos, setRepos] = useState<CodingRepo[]>([]);
	const [sessions, setSessions] = useState<CodingSession[]>([]);
	const [engines, setEngines] = useState<CodingEngine[]>([]);
	const [defaultEngine, setDefaultEngine] = useState("claude");
	const [runnerOnline, setRunnerOnline] = useState<boolean | null>(null);

	// Session view state
	const [openSession, setOpenSession] = useState<CodingSession | null>(null);
	const [view, setView] = useState<"summary" | "terminal">("summary");
	const [terminalText, setTerminalText] = useState("(waiting...)");
	const [summaryHistory, setSummaryHistory] = useState<{ role: string; content: string }[]>([]);
	const [summaryBusy, setSummaryBusy] = useState(false);
	const [chatInput, setChatInput] = useState("");
	const [termInput, setTermInput] = useState("");
	const [overseerInput, setOverseerInput] = useState("");
	const [overseerReply, setOverseerReply] = useState("");
	const [addRepoInput, setAddRepoInput] = useState("");
	const [showAddRepo, setShowAddRepo] = useState(false);
	const [repoStatuses, setRepoStatuses] = useState<Record<string, string>>({});
	const threadRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<HTMLPreElement>(null);

	const loadCoding = useCallback(async () => {
		try {
			const [repoData, sessionData, engineData] = await Promise.all([
				api<{ repos: CodingRepo[] }>(`/v1/instances/${instanceId}/coding/repos`),
				api<{ sessions: CodingSession[] }>(`/v1/instances/${instanceId}/coding/sessions`),
				api<{ engines: CodingEngine[]; defaultEngineId?: string }>(`/v1/instances/${instanceId}/coding/engines`),
			]);
			setRepos(repoData.repos || []);
			setSessions(sessionData.sessions || []);
			setEngines(engineData.engines || []);
			if (engineData.defaultEngineId) setDefaultEngine(engineData.defaultEngineId);
		} catch {}
	}, [instanceId]);

	useEffect(() => {
		loadCoding();
	}, [loadCoding]);

	// Repo status polling (3s)
	const pollStatuses = useCallback(async () => {
		const activeSessions = sessions.filter((s) => s.status === "active");
		if (!activeSessions.length) return;
		const results = await Promise.allSettled(
			activeSessions.map((s) =>
				api<{ runState?: string; runnerConnected?: boolean }>(
					`/v1/instances/${instanceId}/coding/sessions/${s.id}/capture`,
				).then((d) => ({ repoId: s.repoId, state: d.runState || "idle", connected: d.runnerConnected }))
			),
		);
		const statuses: Record<string, string> = {};
		for (const r of results) {
			if (r.status === "fulfilled") {
				statuses[r.value.repoId] = r.value.state;
				if (r.value.connected !== undefined) setRunnerOnline(r.value.connected);
			} else {
				// Find the session for this rejected promise by index
				const idx = results.indexOf(r);
				statuses[activeSessions[idx].repoId] = "offline";
			}
		}
		setRepoStatuses(statuses);
	}, [instanceId, sessions]);

	usePolling(pollStatuses, 3000, sessions.some((s) => s.status === "active") && !openSession);

	// Terminal polling (1.5s when a session is open)
	const pollTerminal = useCallback(async () => {
		if (!openSession) return;
		try {
			const d = await api<{ pane?: string; runState?: string }>(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/capture`);
			if (d.pane) setTerminalText(d.pane);
		} catch {}
	}, [instanceId, openSession]);

	usePolling(pollTerminal, 1500, !!openSession && view === "terminal");

	// Summary polling (4.5s)
	const pollSummary = useCallback(async () => {
		if (!openSession) return;
		try {
			const d = await api<{ timeline: TimelineEntry[] }>(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/timeline`);
			const entries = (d.timeline || [])
				.filter((e) => e.type === "chat_user" || e.type === "chat_assistant")
				.map((e) => ({ role: e.type === "chat_user" ? "user" : "assistant", content: e.content || e.text || "" }));
			if (entries.length > 0) setSummaryHistory(entries);
		} catch {}
	}, [instanceId, openSession]);

	usePolling(pollSummary, 4500, !!openSession && view === "summary");

	// Scroll on new messages
	useEffect(() => {
		if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
	}, [summaryHistory]);

	const openTerminal = async (session: CodingSession) => {
		setOpenSession(session);
		setView("summary");
		setSummaryHistory([]);
		setTerminalText("(waiting...)");
		// Ensure session is live
		try {
			await api(`/v1/instances/${instanceId}/coding/sessions/${session.id}/start`, { method: "POST" });
		} catch {}
		// Load history
		try {
			const d = await api<{ timeline: TimelineEntry[] }>(`/v1/instances/${instanceId}/coding/sessions/${session.id}/timeline`);
			const entries = (d.timeline || [])
				.filter((e) => e.type === "chat_user" || e.type === "chat_assistant")
				.map((e) => ({ role: e.type === "chat_user" ? "user" : "assistant", content: e.content || e.text || "" }));
			if (entries.length > 0) setSummaryHistory(entries);
		} catch {}
	};

	const closeTerminal = () => {
		setOpenSession(null);
		setSummaryHistory([]);
	};

	const sendInstruction = async () => {
		if (!chatInput.trim() || !openSession) return;
		const msg = chatInput.trim();
		setChatInput("");
		setSummaryHistory((prev) => [...prev, { role: "user", content: msg }]);
		setSummaryBusy(true);
		try {
			const d = await api<{ reply?: string }>(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/explain`, {
				method: "POST",
				body: JSON.stringify({ question: msg }),
			});
			if (d.reply) setSummaryHistory((prev) => [...prev, { role: "assistant", content: d.reply! }]);
		} catch (e) {
			setSummaryHistory((prev) => [...prev, { role: "assistant", content: `Error: ${e instanceof Error ? e.message : String(e)}` }]);
		}
		setSummaryBusy(false);
	};

	const sendTerminalMessage = async () => {
		if (!termInput.trim() || !openSession) return;
		const msg = termInput.trim();
		setTermInput("");
		try {
			await api(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/message`, {
				method: "POST",
				body: JSON.stringify({ message: msg }),
			});
		} catch {}
	};

	const askOverseer = async () => {
		if (!overseerInput.trim()) return;
		const msg = overseerInput.trim();
		setOverseerInput("");
		setOverseerReply("Thinking...");
		try {
			const d = await api<{ reply?: string }>(`/v1/instances/${instanceId}/coding/overseer`, {
				method: "POST",
				body: JSON.stringify({ message: msg }),
			});
			setOverseerReply(d.reply || "No response");
		} catch (e) {
			setOverseerReply(`Error: ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const addRepo = async () => {
		if (!addRepoInput.trim()) return;
		try {
			await api(`/v1/instances/${instanceId}/coding/repos`, {
				method: "POST",
				body: JSON.stringify({ path: addRepoInput.trim() }),
			});
			setAddRepoInput("");
			setShowAddRepo(false);
			loadCoding();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const deleteRepo = async (repoId: string) => {
		if (!confirm("Delete this repo?")) return;
		await api(`/v1/instances/${instanceId}/coding/repos/${repoId}`, { method: "DELETE" });
		loadCoding();
	};

	const startSession = async (repoId: string) => {
		try {
			const d = await api<{ session: CodingSession }>(`/v1/instances/${instanceId}/coding/sessions`, {
				method: "POST",
				body: JSON.stringify({ repoId, engineId: defaultEngine }),
			});
			if (d.session) {
				loadCoding();
				openTerminal(d.session);
			}
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const endSession = async () => {
		if (!openSession) return;
		await api(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/end`, { method: "POST" });
		closeTerminal();
		loadCoding();
	};

	const getActiveSession = (repoId: string) => sessions.find((s) => s.repoId === repoId && s.status === "active");

	const repoLabel = (r: CodingRepo) => {
		const active = getActiveSession(r.id);
		const st = repoStatuses[r.id];
		if (!active) return runnerOnline === false ? "Runner offline" : "Ready";
		if (st === "thinking" || st === "working") return "Working...";
		if (st === "idle") return "Ready";
		if (st === "offline") return "Runner offline";
		return "Active";
	};

	// ── Session open: full-screen terminal/co-pilot ──
	if (openSession) {
		const repo = repos.find((r) => getActiveSession(r.id)?.id === openSession.id);
		return (
			<div className="flex flex-col h-[calc(100dvh-120px)] min-h-[340px]">
				{/* Header bar */}
				<div className="flex items-center gap-2 mb-2 flex-wrap">
					<button type="button" onClick={closeTerminal} className="text-sm text-muted hover:text-ink"><ArrowLeft size={16} /></button>
					<span className="text-sm font-semibold truncate">{repo?.name || openSession.repoId}</span>
					<div className="flex border border-line rounded-lg overflow-hidden">
						<button type="button" onClick={() => setView("summary")} className={`px-2.5 py-1 text-xs font-bold ${view === "summary" ? "bg-accent-soft text-accent" : "text-muted"}`}>Agent</button>
						<button type="button" onClick={() => setView("terminal")} className={`px-2.5 py-1 text-xs font-bold ${view === "terminal" ? "bg-accent-soft text-accent" : "text-muted"}`}>Terminal</button>
					</div>
					<div className="ml-auto flex gap-1.5">
						<button type="button" onClick={endSession} className="text-xs px-2 py-1 rounded-md border border-red text-red font-semibold">End</button>
					</div>
				</div>

				{/* Agent view */}
				{view === "summary" && (
					<div className="flex flex-col flex-1 min-h-0">
						<div ref={threadRef} className="flex-1 overflow-y-auto bg-panel border border-line rounded-lg p-3 flex flex-col gap-3 chat-scroll">
							{summaryHistory.map((m, i) => (
								<div key={i} className={`max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed ${m.role === "user" ? "bg-accent text-white self-end rounded-br-sm" : "bg-paper border border-line self-start rounded-bl-sm"}`}>
									{m.role === "assistant" ? (
										<div className="msg-md" dangerouslySetInnerHTML={{ __html: mdLite(m.content) }} />
									) : (
										<span className="whitespace-pre-wrap">{m.content}</span>
									)}
								</div>
							))}
							{summaryBusy && <div className="text-muted text-xs flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />Thinking...</div>}
						</div>
						<div className="flex gap-1.5 mt-2 shrink-0">
							<input
								value={chatInput}
								onChange={(e) => setChatInput(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") sendInstruction(); }}
								placeholder="Ask about it, or tell it to do something..."
								className="flex-1 min-w-0"
							/>
							<button type="button" onClick={sendInstruction} className="px-3 py-2 bg-accent text-white rounded-xl font-bold text-sm">Send</button>
						</div>
					</div>
				)}

				{/* Terminal view */}
				{view === "terminal" && (
					<div className="flex flex-col flex-1 min-h-0">
						<pre ref={termRef} className="flex-1 min-h-0 overflow-auto bg-[#0b0b0f] text-[#d6d6e0] text-xs leading-snug p-2.5 rounded-lg whitespace-pre-wrap break-words m-0">
							{terminalText}
						</pre>
						<div className="flex gap-1.5 mt-2 shrink-0">
							<input
								value={termInput}
								onChange={(e) => setTermInput(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") sendTerminalMessage(); }}
								placeholder="Type a message to the CLI..."
								className="flex-1 min-w-0"
							/>
							<button type="button" onClick={sendTerminalMessage} className="px-3 py-2 bg-accent text-white rounded-xl font-bold text-sm">Send</button>
						</div>
					</div>
				)}
			</div>
		);
	}

	// ── Repos list view ──
	return (
		<div>
			{/* Overseer */}
			<div className="bg-panel border border-line rounded-xl p-3 mb-3">
				<div className="flex gap-1.5 items-center">
					<span title="The Overseer sees all your repos" className="shrink-0"><Satellite size={16} className="text-muted" /></span>
					<input
						value={overseerInput}
						onChange={(e) => setOverseerInput(e.target.value)}
						onKeyDown={(e) => { if (e.key === "Enter") askOverseer(); }}
						placeholder="Ask across all repos, or tell one to do something..."
						className="flex-1 min-w-[120px]"
					/>
					<button type="button" onClick={askOverseer} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Ask</button>
				</div>
				{overseerReply && (
					<div className="text-sm leading-relaxed mt-2 bg-paper border border-line rounded-lg p-2.5" dangerouslySetInnerHTML={{ __html: mdLite(overseerReply) }} />
				)}
			</div>

			{/* Repos section */}
			<div className="bg-panel border border-line rounded-xl p-3">
				<div className="flex justify-between items-center gap-2">
					<span className="text-ink font-bold text-[0.95rem]">Repositories</span>
					<button type="button" onClick={() => setShowAddRepo(!showAddRepo)} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted font-semibold">+ Add</button>
				</div>

				{/* Activity strip */}
				{sessions.filter((s) => s.status === "active").length > 0 && (
					<div className="text-xs text-muted mt-1.5">
						{sessions.filter((s) => s.status === "active").length} active session{sessions.filter((s) => s.status === "active").length !== 1 ? "s" : ""}
					</div>
				)}

				{/* Add repo form */}
				{showAddRepo && (
					<div className="mt-3">
						<div className="flex gap-1.5 flex-wrap">
							<input
								value={addRepoInput}
								onChange={(e) => setAddRepoInput(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") addRepo(); }}
								placeholder="~/dev/my-repo or owner/repo or clone URL"
								className="flex-1 min-w-[180px]"
							/>
							<button type="button" onClick={addRepo} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Add</button>
						</div>
						<p className="text-xs text-muted mt-1.5">
							<b>Best for dev:</b> point at a repo you already have (<code>~/dev/my-repo</code>) — the agent works in your real checkout.
						</p>
					</div>
				)}

				{/* Runner offline CTA */}
				{runnerOnline === false && (
					<div className="bg-orange-50 border border-amber-500 rounded-lg p-2.5 mt-3 text-sm text-orange-900">
						<b>Your machine isn't connected.</b> Start the runner:
						<code className="block mt-1.5 bg-white border border-amber-500 rounded-md p-1.5 text-sm">pags up</code>
					</div>
				)}

				{/* Repo list */}
				<div className="flex flex-col gap-1.5 mt-3">
					{repos.length === 0 ? (
						<p className="text-center py-4 text-muted-soft text-sm">No repos yet. Add one above.</p>
					) : (
						repos.map((r) => {
							const active = getActiveSession(r.id);
							const status = repoStatuses[r.id];
							return (
								<div key={r.id} className="bg-paper border border-line rounded-lg p-3 flex justify-between items-center gap-3">
									<div className="min-w-0">
										<div className="font-semibold text-sm truncate">{r.name}</div>
										<div className="text-xs text-muted mt-0.5 flex items-center gap-1.5">
											{status === "thinking" || status === "working" ? (
												<span className="inline-block w-2.5 h-2.5 border-2 border-line border-t-amber-500 rounded-full animate-spin" />
											) : active ? (
												<span className={`w-2 h-2 rounded-full ${status === "offline" ? "bg-muted" : "bg-green"}`} />
											) : (
												<span className="w-2 h-2 rounded-full bg-muted" />
											)}
											{repoLabel(r)}
										</div>
									</div>
									<div className="flex gap-1.5 shrink-0">
										{active ? (
											<button type="button" onClick={() => openTerminal(active)} className="text-xs px-2.5 py-1 rounded-md bg-accent text-white font-bold">Open</button>
										) : (
											<button type="button" onClick={() => startSession(r.id)} className="text-xs px-2.5 py-1 rounded-md border border-line text-muted font-semibold hover:border-accent hover:text-accent">Start</button>
										)}
										<button type="button" onClick={() => deleteRepo(r.id)} className="text-xs px-1.5 py-1 text-red"><Trash2 size={14} /></button>
									</div>
								</div>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
