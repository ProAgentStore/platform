import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { CodingRepo, CodingSession, CodingEngine } from "./types";
import { renderMd, formatTime } from "@proagentstore/sdk/ui";
import { usePolling } from "@proagentstore/sdk/hooks";
import { useVoice } from "@proagentstore/sdk/hooks";
import { useCodingLoop } from "./use-coding-loop";
import { ArrowLeft, Trash2, Copy, Repeat, Square, Mic, MicOff, Volume2, AudioLines, Send, Wrench, Settings, ChevronDown } from "lucide-react";

/** Render terminal output: colorize lines + format inline code/bold/JSON */
function renderTerminal(text: string): string {
	// Extract and format JSON blocks inline
	let s = text.replace(/(?:^|\n)(\{[\s\S]*?\}|\[[\s\S]*?\])(?=\n|$)/g, (match) => {
		try {
			const obj = JSON.parse(match.trim());
			const pretty = JSON.stringify(obj, null, 2);
			const esc = pretty.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
			return `\n<code style="color:#94a3b8;font-size:0.75em">${esc}</code>\n`;
		} catch { return match; }
	});

	return s.split("\n").map((line) => {
		let e = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		// Skip already-formatted code blocks
		if (line.startsWith("<code")) return line;
		// Inline bold
		e = e.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
		// Inline code
		e = e.replace(/`([^`]+)`/g, '<code style="background:#1e1e2e;padding:1px 4px;border-radius:3px;font-size:0.85em">$1</code>');
		// Headings (### → bold colored)
		if (/^\s*#{1,4}\s+/.test(line)) {
			const heading = e.replace(/^\s*#+\s+/, "");
			return `<strong style="color:#7dd3fc;font-size:1.05em">${heading}</strong>`;
		}
		// Prompt lines (cyan)
		if (/^\s*❯/.test(line)) return `<span style="color:#67e8f9">${e}</span>`;
		// Error lines (red)
		if (/^\s*\[error\]|^Error:|^✗|^FAIL/i.test(line)) return `<span style="color:#f87171">${e}</span>`;
		// Tool/system lines (amber)
		if (/^\s*⚙|^\s*\[info\]|^\s*\[warn\]|^\[/.test(line)) return `<span style="color:#fbbf24">${e}</span>`;
		// Continuation/result lines (dim)
		if (/^\s*↳|^\s*│|^\s*└|^\s*├/.test(line)) return `<span style="color:#94a3b8">${e}</span>`;
		// Success lines (green)
		if (/^\s*✓|^\s*✔|^PASS|^Done/i.test(line)) return `<span style="color:#4ade80">${e}</span>`;
		// Bullet points
		if (/^\s*[-*]\s+/.test(line)) return `<span style="color:#c4b5fd">${e}</span>`;
		// Default
		return `<span style="color:#d6d6e0">${e}</span>`;
	}).join("\n");
}

interface Props {
	instanceId: string;
	initialSessionId?: string;
	onHeaderOverride?: (content: ReactNode | null) => void;
}

interface TimelineEntry {
	role?: string;
	type?: string;
	content?: string;
	text?: string;
	seq?: number;
	createdAt?: string;
}

export default function CodingTab({ instanceId, initialSessionId, onHeaderOverride }: Props) {
	const navigate = useNavigate();
	const [repos, setRepos] = useState<CodingRepo[]>([]);
	const [sessions, setSessions] = useState<CodingSession[]>([]);
	const [engines, setEngines] = useState<CodingEngine[]>([]);
	const [defaultEngine, setDefaultEngine] = useState("claude");
	const [runnerOnline, setRunnerOnline] = useState<boolean | null>(null);

	// Session view state
	const [openSession, setOpenSession] = useState<CodingSession | null>(null);
	const [view, setView] = useState<"summary" | "terminal">("summary");
	const [terminalText, setTerminalText] = useState("(waiting...)");
	const [termAutoScroll, setTermAutoScroll] = useState(true);
	const [summaryHistory, setSummaryHistory] = useState<{ role: string; content: string; time?: string }[]>([]);

	// Loop (extracted hook)
	const loop = useCodingLoop({
		instanceId,
		sessionId: openSession?.id ?? null,
		onMessage: (msg) => setSummaryHistory((prev) => [...prev, msg]),
	});
	loop.syncHistory(summaryHistory);
	const [summaryBusy, setSummaryBusy] = useState(false);
	const [chatInput, setChatInput] = useState("");
	const [termInput, setTermInput] = useState("");
	const [addRepoInput, setAddRepoInput] = useState("");
	const [showAddRepo, setShowAddRepo] = useState(false);
	const [settingsRepoId, setSettingsRepoId] = useState<string | null>(null);
	const [loopPresets] = useState([
		{ id: "bugs", label: "Fix bugs", objective: "Find and fix all bugs. Run tests after each fix. Commit when all pass." },
		{ id: "quality", label: "Quality check", objective: "Run a full code quality audit: type check, lint, find code smells, dead code, and fix issues found. Commit improvements." },
		{ id: "security", label: "Security audit", objective: "Audit the codebase for security vulnerabilities: injection, auth gaps, secrets exposure, SSRF, XSS. Fix critical issues and report." },
		{ id: "refactor", label: "Refactor", objective: "Identify large or complex files. Break them into smaller, well-named modules. Keep all tests passing." },
		{ id: "tests", label: "Add tests", objective: "Find untested code paths. Write tests for the most critical functions. Aim for meaningful coverage, not 100%." },
	]);
	const [repoStatuses, setRepoStatuses] = useState<Record<string, string>>({});
	const threadRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<HTMLPreElement>(null);

	// Voice: wire to Co-pilot sendInstruction
	const sendInstructionRef = useRef<(text: string) => void>(() => {});
	const voice = useVoice(instanceId, {
		onSend: (text) => sendInstructionRef.current(text),
	});

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
		(async () => {
			await loadCoding();
		})();
	}, [loadCoding]);

	// Auto-open session on mount — prefer URL session, fall back to first active
	const autoOpenedRef = useRef(false);
	useEffect(() => {
		if (autoOpenedRef.current || !sessions.length) return;
		const target = initialSessionId
			? sessions.find((s) => s.id === initialSessionId)
			: sessions.find((s) => s.status === "active");
		if (target) {
			autoOpenedRef.current = true;
			openTerminal(target);
		}
	}, [sessions]); // eslint-disable-line react-hooks/exhaustive-deps

	// Repo status polling (3s) — use ref for sessions to avoid interval restarts
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;
	const hasActiveSessions = sessions.some((s) => s.status === "active");

	const pollStatuses = useCallback(async () => {
		const activeSessions = sessionsRef.current.filter((s) => s.status === "active");
		if (!activeSessions.length) return;
		const results = await Promise.allSettled(
			activeSessions.map((s) =>
				api<{ runState?: string; runnerConnected?: boolean }>(
					`/v1/instances/${instanceId}/coding/sessions/${s.id}/capture`,
				).then((d) => ({ repoId: s.repoId, state: d.runState || "idle", connected: d.runnerConnected }))
			),
		);
		const statuses: Record<string, string> = {};
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (r.status === "fulfilled") {
				statuses[r.value.repoId] = r.value.state;
				if (r.value.connected !== undefined) setRunnerOnline(r.value.connected);
			} else {
				statuses[activeSessions[i].repoId] = "offline";
			}
		}
		setRepoStatuses(statuses);
	}, [instanceId]);

	usePolling(pollStatuses, 3000, hasActiveSessions && !openSession);

	// Terminal polling (1.5s when a session is open)
	const termTextRef = useRef(terminalText);
	termTextRef.current = terminalText;
	const pollTerminal = useCallback(async () => {
		if (!openSession) return;
		try {
			const d = await api<{ pane?: string; runState?: string }>(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/capture`);
			const newText = d.pane ?? "(waiting for output...)";
			// Skip update if text unchanged or user is selecting text
			if (newText === termTextRef.current) return;
			const sel = window.getSelection();
			if (sel && sel.toString().length > 0 && termRef.current?.contains(sel.anchorNode)) return;
			setTerminalText(newText);
		} catch {}
	}, [instanceId, openSession]);

	usePolling(pollTerminal, 1500, !!openSession);

	// Summary polling (4.5s)
	const pollSummary = useCallback(async () => {
		if (!openSession) return;
		try {
			const d = await api<{ chat?: TimelineEntry[]; timeline?: TimelineEntry[] }>(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/timeline`);
			const entries = (d.chat || d.timeline || [])
				.filter((e) => e.type === "chat_user" || e.type === "chat_assistant" || e.type === "chat_system" || e.type === "system" || e.type === "command")
				.map((e) => ({
					role: e.type === "chat_user" || e.type === "command" ? "user" : e.type === "chat_system" || e.type === "system" ? "system" : "assistant",
					content: e.content || e.text || "",
					time: e.createdAt,
				}));
			if (entries.length > 0) setSummaryHistory(entries);
		} catch {}
	}, [instanceId, openSession]);

	usePolling(pollSummary, 4500, !!openSession && view === "summary");

	// Scroll on new messages (co-pilot)
	useEffect(() => {
		if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
	}, [summaryHistory]);

	// Auto-scroll terminal when new output arrives or view switches to terminal
	useEffect(() => {
		if (termAutoScroll && termRef.current) {
			requestAnimationFrame(() => {
				if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
			});
		}
	}, [terminalText, termAutoScroll, view]);

	const openTerminal = async (session: CodingSession) => {
		setOpenSession(session);
		setView("summary");
		setSummaryHistory([]);
		navigate(`/instances/${instanceId}/coding/${session.id}`, { replace: true });
		setTerminalText("(waiting...)");
		// Ensure session is live
		try {
			await api(`/v1/instances/${instanceId}/coding/sessions/${session.id}/start`, { method: "POST" });
		} catch {}
		// Load history (chat + system + command messages)
		try {
			const d = await api<{ chat?: TimelineEntry[]; timeline?: TimelineEntry[] }>(`/v1/instances/${instanceId}/coding/sessions/${session.id}/timeline`);
			const entries = (d.chat || d.timeline || [])
				.filter((e) => e.type === "chat_user" || e.type === "chat_assistant" || e.type === "chat_system" || e.type === "system" || e.type === "command")
				.map((e) => ({
					role: e.type === "chat_user" || e.type === "command" ? "user" : e.type === "chat_system" || e.type === "system" ? "system" : "assistant",
					content: e.content || e.text || "",
					time: e.createdAt,
				}));
			setSummaryHistory(entries);
		} catch (e) {
			console.error("[coding] timeline load failed:", e);
		}
	};

	const closeTerminal = () => {
		setOpenSession(null);
		setSummaryHistory([]);
		navigate(`/instances/${instanceId}/coding`, { replace: true });
	};

	// Watch the Engine after delegation — poll until idle, then auto-summarize
	const watcherRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const voiceRef = useRef(voice);
	voiceRef.current = voice;
	const watchForFinish = useCallback((sid: string) => {
		if (watcherRef.current) clearTimeout(watcherRef.current);
		let attempts = 0;
		const MAX_ATTEMPTS = 60; // ~3 min max watch time
		const poll = async () => {
			attempts++;
			if (attempts > MAX_ATTEMPTS) {
				setSummaryHistory((prev) => [...prev, { role: "system", content: "Stopped watching — Engine is taking too long. Check the Terminal view." }]);
				return;
			}
			try {
				const d = await api<{ pane?: string; runState?: string }>(`/v1/instances/${instanceId}/coding/sessions/${sid}/capture`);
				const state = d.runState || "idle";
				if (state === "thinking" || state === "working") {
					watcherRef.current = setTimeout(poll, 3000);
					return;
				}
				// Engine finished — get a completion summary
				const summary = await api<{ reply?: string }>(`/v1/instances/${instanceId}/coding/sessions/${sid}/explain`, {
					method: "POST",
					// persist:false — the durable server watch workflow already saves this
					// summary; we only need it here to show + speak (avoids a duplicate bubble).
					body: JSON.stringify({ finished: true, persist: false }),
				});
				if (summary.reply) {
					setSummaryHistory((prev) => [...prev, { role: "assistant", content: summary.reply! }]);
					voiceRef.current.maybeSpeakResponse(summary.reply);
				}
			} catch {
				setSummaryHistory((prev) => [...prev, { role: "system", content: "Lost connection to the Engine — check your runner." }]);
			}
		};
		watcherRef.current = setTimeout(poll, 4000);
	}, [instanceId]);

	// Cleanup watcher on unmount
	useEffect(() => () => { if (watcherRef.current) clearTimeout(watcherRef.current); }, []);

	const doSendInstruction = async (msg: string) => {
		if (!msg.trim() || !openSession) return;
		setSummaryHistory((prev) => [...prev, { role: "user", content: msg }]);
		setSummaryBusy(true);
		try {
			const d = await api<{ reply?: string; response?: string; delegated?: boolean }>(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/agent`, {
				method: "POST",
				body: JSON.stringify({ message: msg }),
			});
			const reply = d.reply || d.response;
			if (reply) {
				setSummaryHistory((prev) => [...prev, { role: "assistant", content: reply }]);
				voice.maybeSpeakResponse(reply);
			} else {
				setSummaryHistory((prev) => [...prev, { role: "assistant", content: "No response — the session may need to be started first." }]);
				voice.maybeSpeakResponse(""); // no reply — still resume the mic so convo mode doesn't wedge
			}
			// If delegated, watch for the Engine to finish and auto-report
			if (d.delegated) {
				watchForFinish(openSession.id);
			}
		} catch (e) {
			setSummaryHistory((prev) => [...prev, { role: "assistant", content: `Error: ${e instanceof Error ? e.message : String(e)}` }]);
			voice.maybeSpeakResponse(""); // failed send — resume the mic so convo mode doesn't wedge
		}
		setSummaryBusy(false);
	};
	sendInstructionRef.current = doSendInstruction;

	const sendInstruction = () => {
		if (!chatInput.trim()) return;
		const msg = chatInput.trim();
		setChatInput("");
		doSendInstruction(msg);
	};

	const sendTerminalMessage = async () => {
		if (!termInput.trim() || !openSession) return;
		const msg = termInput.trim();
		setTermInput("");
		try {
			await api(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/message`, {
				method: "POST",
				body: JSON.stringify({ text: msg }),
			});
		} catch (e) {
			console.error("[terminal] send failed:", e);
			alert("Terminal send failed: " + (e instanceof Error ? e.message : String(e)));
		}
	};


	const addRepo = async () => {
		const val = addRepoInput.trim();
		if (!val) return;
		// Detect input type: local path vs clone URL vs owner/repo
		const body: Record<string, string> = {};
		if (val.startsWith("~") || val.startsWith("/")) {
			body.localPath = val;
		} else if (val.includes("://") || val.includes(".git")) {
			body.cloneUrl = val;
		} else if (val.includes("/")) {
			body.githubRepo = val;
			body.cloneUrl = `https://github.com/${val}.git`;
		} else {
			body.name = val;
		}
		try {
			await api(`/v1/instances/${instanceId}/coding/repos`, {
				method: "POST",
				body: JSON.stringify(body),
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

	const restartSession = async () => {
		if (!openSession) return;
		try {
			await api(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/restart`, { method: "POST" });
			setTerminalText("(restarting CLI...)");
			setSummaryHistory([]);
		} catch (e) {
			alert("Restart failed: " + (e instanceof Error ? e.message : String(e)));
		}
	};

	// End current session + start a brand new one (no --resume, clean state)
	const freshStart = async () => {
		if (!openSession) return;
		const repoId = openSession.repoId;
		try {
			await api(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/end`, { method: "POST" });
			const d = await api<{ session: CodingSession }>(`/v1/instances/${instanceId}/coding/sessions`, {
				method: "POST",
				body: JSON.stringify({ repoId, engineId: defaultEngine }),
			});
			if (d.session) {
				await loadCoding();
				openTerminal(d.session);
			}
		} catch (e) {
			alert("Fresh start failed: " + (e instanceof Error ? e.message : String(e)));
		}
	};

	const copySummaryJson = async () => {
		if (!openSession) return;
		try {
			const d = await api<{ chat?: TimelineEntry[]; timeline?: TimelineEntry[] }>(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/timeline?full=1`);
			// Copy only the last 10 messages (history is kept server-side; the clipboard
			// just gets the recent context).
			const entries = (d.chat || d.timeline || [])
				.slice(-10)
				.map((e) => ({
					type: e.type,
					role: e.role,
					content: e.content || e.text || "",
					seq: e.seq,
				}));
			await navigator.clipboard.writeText(JSON.stringify({ sessionId: openSession.id, count: entries.length, timeline: entries }, null, 2));
		} catch (e) {
			alert("Copy failed: " + (e instanceof Error ? e.message : String(e)));
		}
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

	const [repoMenuOpen, setRepoMenuOpen] = useState(false);
	const reposRef = useRef(repos);
	reposRef.current = repos;
	const switchToRepo = (r: CodingRepo) => {
		setRepoMenuOpen(false);
		const active = getActiveSession(r.id);
		if (active) openTerminal(active);
		else startSession(r.id);
	};

	// Push session header override to parent when session is open
	const openRepo = openSession ? repos.find((r) => getActiveSession(r.id)?.id === openSession.id) : null;
	useEffect(() => {
		if (!openSession || !onHeaderOverride) return;
		onHeaderOverride(
			<div className="flex items-center gap-2 min-w-0">
				<button type="button" onClick={closeTerminal} title="All repos" className="text-muted hover:text-ink shrink-0"><ArrowLeft size={16} /></button>
				<div className="relative shrink-0">
					<button type="button" onClick={() => setRepoMenuOpen((v) => !v)} title="Switch repo" className="flex items-center gap-1 text-sm font-semibold hover:text-accent max-w-[11rem]">
						<span className="truncate">{openRepo?.name || openSession.repoId}</span>
						<ChevronDown size={14} className="shrink-0 text-muted" />
					</button>
					{repoMenuOpen && (
						<>
							<button type="button" aria-label="Close menu" onClick={() => setRepoMenuOpen(false)} className="fixed inset-0 z-40 cursor-default" />
							<div className="absolute top-full left-0 mt-1 z-50 min-w-52 max-h-72 overflow-auto bg-panel border border-line rounded-lg shadow-lg py-1">
								<button type="button" onClick={() => { setRepoMenuOpen(false); closeTerminal(); }} className="w-full text-left px-3 py-1.5 text-xs font-bold text-muted hover:bg-panel-hover flex items-center gap-1.5"><ArrowLeft size={12} /> All repos</button>
								<div className="border-t border-line my-1" />
								{reposRef.current.map((r) => {
									const st = repoStatuses[r.id];
									const current = r.id === openSession.repoId;
									return (
										<button key={r.id} type="button" onClick={() => switchToRepo(r)} className={`w-full text-left px-3 py-1.5 text-sm hover:bg-panel-hover flex items-center justify-between gap-2 ${current ? "text-accent font-bold" : ""}`}>
											<span className="truncate">{r.name}</span>
											{current ? <span className="text-accent text-xs shrink-0">●</span> : (st === "thinking" || st === "working") ? <span className="text-amber-500 text-[0.6rem] shrink-0">working</span> : null}
										</button>
									);
								})}
							</div>
						</>
					)}
				</div>
				<div className="flex border border-line rounded-lg overflow-hidden shrink-0">
					<button type="button" onClick={() => setView("summary")} className={`px-2 py-1 text-xs font-bold ${view === "summary" ? "bg-accent-soft text-accent" : "text-muted"}`}>Co-pilot</button>
					<button type="button" onClick={() => setView("terminal")} className={`px-2 py-1 text-xs font-bold ${view === "terminal" ? "bg-accent-soft text-accent" : "text-muted"}`}>Terminal</button>
				</div>
				<div className="ml-auto flex gap-1 shrink-0">
					<button type="button" onClick={copySummaryJson} title="Copy conversation as JSON" className="text-xs px-1.5 py-1 rounded-lg border border-line text-muted font-semibold hover:border-accent hover:text-accent flex items-center gap-1"><Copy size={12} /><span className="hidden sm:inline">Copy</span></button>
					<button type="button" onClick={freshStart} title="Fresh start" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent hidden sm:block">Fresh</button>
					<button type="button" onClick={restartSession} title="Restart CLI" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent hidden sm:block">Restart</button>
					<button type="button" onClick={endSession} title="End session" className="text-xs px-1.5 py-1 rounded-md border border-red text-red font-semibold">End</button>
				</div>
			</div>
		);
		return () => onHeaderOverride(null);
		// Deps so this only re-runs when the header's VISIBLE content changes. With no
		// deps it was a render storm: each run handed setChildHeader a fresh element →
		// re-rendered the parent → this child → effect again, continuously.
	}, [openSession, onHeaderOverride, openRepo?.name, view, repoMenuOpen]);

	// ── Session open: full-screen terminal/co-pilot ──
	if (openSession) {
		return (
			<div className="flex flex-col h-full">

				{/* Co-pilot view */}
				{view === "summary" && (
					<div className="flex flex-col flex-1 min-h-0">
						{/* Input bar — top, always visible. Compact input, big controls. */}
						<div className="flex gap-1.5 px-2 py-1.5 shrink-0 items-center border-b border-line">
							<div className="flex-1 min-w-0 relative">
								<input
									value={voice.interim || chatInput}
									onChange={(e) => { if (!voice.interim) setChatInput(e.target.value); }}
									onKeyDown={(e) => { if (e.key === "Enter" && !voice.interim) sendInstruction(); }}
									placeholder={voice.micOn ? "Listening — speak now…" : voice.convoOn ? "Conversation mode — just talk" : "Ask or tell the agent…"}
									readOnly={!!voice.interim}
									className={`w-full bg-panel border rounded-lg px-2.5 py-1.5 text-sm transition-colors ${voice.interim ? "border-accent text-accent font-semibold" : voice.micOn ? "border-green" : "border-line"}`}
								/>
								{voice.micOn && (
									<div className="absolute bottom-0 left-2 right-2 h-1 rounded-full overflow-hidden bg-line/50">
										<div className="h-full bg-green rounded-full transition-all" style={{ width: `${Math.round(voice.audioLevel * 100)}%`, transitionDuration: "50ms" }} />
									</div>
								)}
							</div>
							<button type="button" onClick={sendInstruction} disabled={!!voice.interim} aria-label="Send" className="px-3 py-2 bg-accent text-white rounded-lg font-bold disabled:opacity-40 shrink-0">
								<Send size={17} />
							</button>
						</div>
						{/* Live transcript — show the user exactly what's being heard. */}
						{voice.interim && (
							<div className="px-3 py-1.5 shrink-0 text-sm text-accent font-semibold border-b border-line bg-accent-soft/40 truncate">🎙 {voice.interim}</div>
						)}
						{/* Controls bar — larger tap targets */}
						<div className="flex gap-1.5 px-2 py-1.5 shrink-0 items-center">
							<button type="button" onClick={voice.toggleMic} title="Push to talk" className={`px-2.5 py-2 border rounded-lg transition-colors ${voice.micOn ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
								<Mic size={17} />
							</button>
							<button type="button" onClick={voice.toggleSpeak} title="Auto-speak" className={`px-2.5 py-2 border rounded-lg transition-colors ${voice.speakOn ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
								<Volume2 size={17} />
							</button>
							<button type="button" onClick={voice.toggleConvo} title="Hands-free voice" className={`px-2.5 py-2 border rounded-lg transition-colors ${voice.convoOn ? "border-green bg-green/15 text-green" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
								<AudioLines size={17} />
							</button>
							{voice.convoOn && (
								<button type="button" onClick={voice.toggleMute} title={voice.muted ? "Unmute" : "Mute"} className={`px-2.5 py-2 border rounded-lg transition-colors ${voice.muted ? "border-red bg-red/15 text-red" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
									<MicOff size={17} />
								</button>
							)}
							{loop.loopOn ? (
								<button type="button" onClick={loop.stop} title={`Loop ${loop.loopIteration}/${loop.loopMax}`} className="px-2.5 py-2 border border-green bg-green/15 text-green rounded-lg relative">
									<Square size={17} />
									<span className="absolute -top-1 -right-1 text-[0.55rem] bg-green text-white rounded-full px-1 font-bold leading-tight">{loop.loopIteration}</span>
								</button>
							) : (
								<button type="button" onClick={() => loop.setShowLoopForm(!loop.showLoopForm)} title="Loop" className={`px-2.5 py-2 border rounded-lg ${loop.showLoopForm ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
									<Repeat size={17} />
								</button>
							)}
							<button type="button" onClick={async () => {
								if (!openSession || !confirm("Clear co-pilot chat history?")) return;
								try { await api(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/timeline`, { method: "DELETE" }); } catch {}
								setSummaryHistory([]);
							}} title="Clear chat" className="px-2.5 py-2 border border-line rounded-lg text-red hover:bg-red/10 transition-colors">
								<Trash2 size={17} />
							</button>
						</div>
						{/* Loop form with presets */}
						{loop.showLoopForm && !loop.loopOn && (
							<div className="bg-panel border border-line rounded-xl p-3 mx-2 mb-1 flex flex-col gap-2">
								<div className="flex flex-wrap gap-1.5">
									{loopPresets.map((p) => (
										<button key={p.id} type="button" onClick={() => loop.setLoopObjective(p.objective)} className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${loop.loopObjective === p.objective ? "border-accent bg-accent-soft text-accent font-bold" : "border-line text-muted hover:border-accent hover:text-accent"}`}>{p.label}</button>
									))}
								</div>
								<textarea
									value={loop.loopObjective}
									onChange={(e) => loop.setLoopObjective(e.target.value)}
									onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); loop.start(); } }}
									placeholder="Or type a custom objective..."
									className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-sm resize-none"
									rows={2}
								/>
								<div className="flex items-center gap-2 justify-between">
									<label className="text-xs text-muted flex items-center gap-1.5">Max iterations: <input type="number" value={loop.loopMax} onChange={(e) => loop.setLoopMax(Math.max(1, Math.min(50, parseInt(e.target.value) || 10)))} className="w-14 bg-panel border border-line rounded px-2 py-1 text-xs" min={1} max={50} /></label>
									<div className="flex gap-1.5">
										<button type="button" onClick={() => loop.setShowLoopForm(false)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Cancel</button>
										<button type="button" onClick={loop.start} disabled={!loop.loopObjective.trim()} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold disabled:opacity-40">Start Loop</button>
									</div>
								</div>
							</div>
						)}
						{/* Messages */}
						<div ref={threadRef} className="flex-1 overflow-y-auto flex flex-col gap-2 px-2 py-2 chat-scroll">
							{summaryHistory.map((m, i) => {
								// Tool calls: collapsed chip
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
								if (m.role === "system") {
									return (
										<div key={i} className="bg-yellow/10 text-yellow self-center rounded-full px-4 py-1.5 text-xs border border-yellow/15">
											<span className="whitespace-pre-wrap">{m.content}</span>
										</div>
									);
								}
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
										<button type="button" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(m.content); }} className="absolute top-1 right-1.5 opacity-0 group-hover:opacity-100 text-[0.65rem] px-1.5 py-0.5 rounded bg-black/50 text-muted transition-opacity" title="Copy"><Copy size={12} /></button>
										{m.role === "user" && <div className="text-[0.65rem] opacity-70 mb-0.5 font-bold flex items-center justify-between gap-3"><span>You</span>{m.time && <span className="font-normal opacity-80">{formatTime(m.time)}</span>}</div>}
										{m.role === "assistant" && <div className="text-[0.65rem] text-accent mb-0.5 font-bold flex items-center justify-between gap-3"><span>Co-pilot</span>{m.time && <span className="font-normal text-muted">{formatTime(m.time)}</span>}</div>}
										{m.role === "assistant" ? (
											<div className="msg-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
										) : (
											<span className="whitespace-pre-wrap">{m.content}</span>
										)}
									</div>
								);
							})}
							{summaryBusy && <div className="text-muted text-sm flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-accent animate-pulse" />Thinking...</div>}
						</div>
					</div>
				)}

				{/* Terminal view */}
				{view === "terminal" && (
					<div className="flex flex-col flex-1 min-h-0 relative">
						<div className="flex gap-1 px-2 py-2 shrink-0 items-center border-b border-line">
							<input
								value={termInput}
								onChange={(e) => setTermInput(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") sendTerminalMessage(); }}
								placeholder="Send a message to the Engine..."
								className="flex-1 min-w-0 bg-panel border border-line rounded-xl px-3 py-2.5 text-sm"
							/>
							<button type="button" onClick={sendTerminalMessage} aria-label="Send" className="px-3 py-2.5 bg-accent text-white rounded-xl font-bold text-sm">
								<Send size={14} />
							</button>
						</div>
						<pre
							ref={termRef}
							className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-[#0b0b0f] text-xs leading-snug p-3 m-0 select-text"
							style={{ wordBreak: "break-word", whiteSpace: "pre-wrap" }}
							onScroll={() => {
								if (!termRef.current) return;
								const el = termRef.current;
								const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
								setTermAutoScroll(atBottom);
							}}
							dangerouslySetInnerHTML={{ __html: renderTerminal(terminalText) }}
						/>
						{!termAutoScroll && (
							<button
								type="button"
								onClick={() => {
									if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
									setTermAutoScroll(true);
								}}
								className="absolute bottom-4 right-4 bg-accent text-white text-xs px-3 py-1.5 rounded-full shadow-lg font-bold animate-bounce"
							>
								New output below
							</button>
						)}
					</div>
				)}
			</div>
		);
	}

	// ── Repos list view ──
	return (
		<div className="px-2 py-2 sm:px-4 sm:py-3 overflow-auto flex-1">
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
								className="flex-1 min-w-[180px] bg-panel border border-line rounded-xl px-3 py-2 text-sm"
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
								<div key={r.id} className="bg-paper border border-line rounded-lg p-3">
									<div className="flex justify-between items-center gap-3">
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
												{r.instructions && <span className="text-[0.6rem] px-1 py-0.5 bg-accent-soft text-accent rounded font-bold">Rules</span>}
											</div>
										</div>
										<div className="flex gap-1.5 shrink-0 items-center">
											{active ? (
												<button type="button" onClick={() => openTerminal(active)} className="text-xs px-2.5 py-1 rounded-md bg-accent text-white font-bold">Open</button>
											) : (
												<button type="button" onClick={() => startSession(r.id)} className="text-xs px-2.5 py-1 rounded-lg border border-line text-muted font-semibold hover:border-accent hover:text-accent">Start</button>
											)}
											<button type="button" onClick={() => setSettingsRepoId(r.id)} title="Repo settings" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent"><Settings size={14} /></button>
											<button type="button" onClick={() => deleteRepo(r.id)} title="Delete repo" className="text-xs px-1.5 py-1 text-red"><Trash2 size={14} /></button>
										</div>
									</div>
								</div>
							);
						})
					)}
				</div>
			</div>
			{settingsRepoId && (() => {
				const repo = repos.find((r) => r.id === settingsRepoId);
				return repo ? (
					<RepoSettingsModal repo={repo} instanceId={instanceId} onClose={() => setSettingsRepoId(null)} onSaved={loadCoding} />
				) : null;
			})()}
		</div>
	);
}

function RepoSettingsModal({ repo, instanceId, onClose, onSaved }: {
	repo: CodingRepo;
	instanceId: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState(repo.name);
	const [rules, setRules] = useState(repo.instructions || "");
	const [dev, setDev] = useState(repo.urls?.dev || "");
	const [staging, setStaging] = useState(repo.urls?.staging || "");
	const [prod, setProd] = useState(repo.urls?.prod || "");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		// Load the latest saved rules (the list may be stale).
		api<{ instructions: string }>(`/v1/instances/${instanceId}/coding/repos/${repo.id}/instructions`)
			.then((d) => setRules(d.instructions || ""))
			.catch(() => {});
	}, [instanceId, repo.id]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const save = async () => {
		setSaving(true);
		try {
			await api(`/v1/instances/${instanceId}/coding/repos/${repo.id}`, {
				method: "PUT",
				body: JSON.stringify({ name: name.trim() || repo.name, urls: { dev: dev.trim(), staging: staging.trim(), prod: prod.trim() } }),
			});
			await api(`/v1/instances/${instanceId}/coding/repos/${repo.id}/instructions`, {
				method: "PUT",
				body: JSON.stringify({ instructions: rules }),
			});
			repo.instructions = rules;
			onSaved();
			onClose();
		} catch (e) {
			alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
		}
		setSaving(false);
	};

	return (
		<div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
			<div className="bg-panel border border-line rounded-t-xl sm:rounded-xl w-full sm:max-w-lg max-h-[88vh] overflow-auto p-4">
				<div className="flex items-center justify-between gap-3 mb-3">
					<h3 className="text-base font-bold flex items-center gap-1.5"><Settings size={16} /> Repo settings</h3>
					<button type="button" onClick={onClose} className="text-muted hover:text-ink text-lg leading-none">✕</button>
				</div>

				<label className="block text-xs font-bold text-muted mb-1">Name</label>
				<input value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-sm mb-3" />

				{/* Read-only details */}
				<div className="grid grid-cols-2 gap-2 mb-3">
					{repo.githubRepo && <Detail label="GitHub" value={repo.githubRepo} />}
					{repo.workdir && <Detail label="Folder" value={repo.workdir} />}
					{repo.cloneStatus && <Detail label="Clone status" value={repo.cloneStatus} />}
					<Detail label="Repo id" value={repo.id} />
				</div>

				<label className="block text-xs font-bold text-muted mb-1">Special instructions (rules for this repo)</label>
				<textarea
					value={rules}
					onChange={(e) => setRules(e.target.value)}
					placeholder="e.g. Always create feature branches. Never push to main. Use conventional commits. Run tests before committing."
					className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-xs min-h-[90px] resize-y mb-3"
					rows={4}
				/>

				<label className="block text-xs font-bold text-muted mb-1">Launch URLs (optional)</label>
				<input value={dev} onChange={(e) => setDev(e.target.value)} placeholder="Dev URL" className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-xs mb-1.5" />
				<input value={staging} onChange={(e) => setStaging(e.target.value)} placeholder="Staging URL" className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-xs mb-1.5" />
				<input value={prod} onChange={(e) => setProd(e.target.value)} placeholder="Production URL" className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-xs" />

				<div className="flex gap-2 justify-end mt-4">
					<button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-line text-muted font-semibold">Cancel</button>
					<button type="button" onClick={save} disabled={saving} className="text-xs px-3 py-1.5 rounded-md bg-accent text-white font-bold disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
				</div>
			</div>
		</div>
	);
}

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div className="bg-paper border border-line rounded-lg p-2 min-w-0">
			<div className="text-[0.6rem] uppercase tracking-wide text-muted-soft mb-0.5">{label}</div>
			<div className="text-xs text-ink break-words font-mono">{value}</div>
		</div>
	);
}
