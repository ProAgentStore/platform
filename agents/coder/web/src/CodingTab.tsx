import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { CodingRepo, CodingSession, CodingEngine } from "./types";
import { usePolling } from "@proagentstore/sdk/hooks";
import { useVoice } from "@proagentstore/sdk/hooks";
import { useCodingLoop } from "./use-coding-loop";
import CopilotView from "./CopilotView";
import TerminalView from "./TerminalView";
import ReposList from "./ReposList";
import RepoSettingsModal from "./RepoSettingsModal";
import EnginesModal from "./EnginesModal";
import { ArrowLeft, Copy, Settings, ChevronDown, Eye, SquareTerminal, Plus } from "lucide-react";

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
	audioKey?: string;
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
	const [summaryHistory, setSummaryHistory] = useState<{ role: string; content: string; time?: string; audioKey?: string }[]>([]);

	// Work mode (instance-wide): "direct" (type each Loop objective) or "issues" (source it
	// from the next open GitHub issue, approve-per-issue). Persisted server-side.
	const [workMode, setWorkModeState] = useState<"direct" | "issues">("direct");
	useEffect(() => {
		let live = true;
		api<{ workMode?: "direct" | "issues" }>(`/v1/instances/${instanceId}/coding/work-mode`)
			.then((d) => { if (live && (d.workMode === "issues" || d.workMode === "direct")) setWorkModeState(d.workMode); })
			.catch(() => {});
		return () => { live = false; };
	}, [instanceId]);
	const setWorkMode = (mode: "direct" | "issues") => {
		setWorkModeState(mode);
		api(`/v1/instances/${instanceId}/coding/work-mode`, { method: "PUT", body: JSON.stringify({ workMode: mode }) }).catch(() => {});
	};

	// Loop (extracted hook)
	const loop = useCodingLoop({
		instanceId,
		sessionId: openSession?.id ?? null,
		repoId: openSession?.repoId ?? null,
		workMode,
		onMessage: (msg) => setSummaryHistory((prev) => [...prev, msg]),
	});
	loop.syncHistory(summaryHistory);
	const [summaryBusy, setSummaryBusy] = useState(false);
	const [chatInput, setChatInput] = useState("");
	const [termInput, setTermInput] = useState("");
	const [addRepoInput, setAddRepoInput] = useState("");
	const [showAddRepo, setShowAddRepo] = useState(false);
	const [settingsRepoId, setSettingsRepoId] = useState<string | null>(null);
	const [showEngines, setShowEngines] = useState(false);
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

	// Voice: wire to Co-pilot sendInstruction (meta.audioKey = saved recording for replay)
	const sendInstructionRef = useRef<(text: string, audioKey?: string) => void>(() => {});
	const voice = useVoice(instanceId, {
		onSend: (text, meta) => sendInstructionRef.current(text, meta?.audioKey),
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
					audioKey: e.audioKey,
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
					audioKey: e.audioKey,
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

	const doSendInstruction = async (msg: string, audioKey?: string) => {
		if (!msg.trim() || !openSession) return;
		setSummaryHistory((prev) => [...prev, { role: "user", content: msg, time: new Date().toISOString(), audioKey }]);
		setSummaryBusy(true);
		try {
			const d = await api<{ reply?: string; response?: string; delegated?: boolean }>(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/agent`, {
				method: "POST",
				body: JSON.stringify({ message: msg, audioKey }),
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

	const clearChat = async () => {
		if (!openSession || !confirm("Clear co-pilot chat history?")) return;
		try { await api(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/timeline`, { method: "DELETE" }); } catch {}
		setSummaryHistory([]);
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

	// "Work on this" (Issues panel): pre-fill an objective from the issue, open the repo's
	// session, and let the user review + send. Never auto-runs (approve-first). Fetch the
	// issue body so the objective carries the full context to the Engine.
	const workOnIssue = async (repo: CodingRepo, issue: { number: number; title: string }) => {
		let body = "";
		try {
			const d = await api<{ issue?: { body?: string } }>(`/v1/instances/${instanceId}/coding/repos/${repo.id}/issues/${issue.number}`);
			body = d.issue?.body ? `\n\n${d.issue.body}` : "";
		} catch {}
		const objective = `Fix issue #${issue.number}: ${issue.title}${body}`;
		const active = getActiveSession(repo.id);
		if (active) await openTerminal(active);
		else await startSession(repo.id);
		setChatInput(objective);
	};

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
				{/* Labeled on mobile so the way back to the repos list (where "+ Add repo"
				    lives) is obvious — a bare arrow was too easy to miss in the crowded bar. */}
				<button type="button" onClick={closeTerminal} title="All repos" className="flex items-center gap-1 text-muted hover:text-ink shrink-0 -ml-1 px-1 py-1"><ArrowLeft size={16} /><span className="text-xs font-semibold sm:hidden">Repos</span></button>
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
								<div className="border-t border-line my-1" />
								{/* One-tap path to the add-repo form from inside a session (esp. mobile,
								    where the repos-list "+ Add" was hard to reach). */}
								<button type="button" onClick={() => { setRepoMenuOpen(false); closeTerminal(); setShowAddRepo(true); }} className="w-full text-left px-3 py-1.5 text-sm text-accent font-semibold hover:bg-panel-hover flex items-center gap-1.5"><Plus size={13} /> Add a repo</button>
							</div>
						</>
					)}
				</div>
				{/* Icon-only on mobile (saves space); icon + label from sm up. */}
				<div className="flex border border-line rounded-lg overflow-hidden shrink-0">
					<button type="button" onClick={() => setView("summary")} title="Co-pilot" aria-label="Co-pilot" aria-pressed={view === "summary"} className={`flex items-center gap-1 px-2 py-1 text-xs font-bold ${view === "summary" ? "bg-accent-soft text-accent" : "text-muted"}`}><Eye size={14} /><span className="hidden sm:inline">Co-pilot</span></button>
					<button type="button" onClick={() => setView("terminal")} title="Terminal" aria-label="Terminal" aria-pressed={view === "terminal"} className={`flex items-center gap-1 px-2 py-1 text-xs font-bold ${view === "terminal" ? "bg-accent-soft text-accent" : "text-muted"}`}><SquareTerminal size={14} /><span className="hidden sm:inline">Terminal</span></button>
				</div>
				<div className="ml-auto flex gap-1 shrink-0">
					<button type="button" onClick={() => setSettingsRepoId(openRepo?.id || openSession.repoId)} title="Repo settings" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent"><Settings size={13} /></button>
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

	const settingsModal = settingsRepoId
		? (() => {
				const repo = repos.find((r) => r.id === settingsRepoId);
				return repo ? (
					<RepoSettingsModal repo={repo} instanceId={instanceId} onClose={() => setSettingsRepoId(null)} onSaved={loadCoding} />
				) : null;
			})()
		: null;

	// Claude Code signed-out CTA — the headless engine surfaces a login error in its
	// transcript when the runner machine has no (or expired) Claude credentials.
	const claudeSignedOut =
		openSession?.clientType === "claude" &&
		/not logged in|please run \/login|invalid api key|oauth token (is |has )?(expired|revoked)/i.test(terminalText);

	// ── Session open: full-screen terminal/co-pilot ──
	if (openSession) {
		return (
			<div className="flex flex-col h-full">
				{claudeSignedOut && (
					<div className="bg-orange-50 border border-amber-500 rounded-lg p-2.5 m-2 text-sm text-orange-900">
						<b>Claude Code is signed out on your runner.</b> Run <code>claude setup-token</code> on any machine (it opens a browser),
						save the token under <button type="button" onClick={() => navigate("/profile")} className="underline font-semibold">Profile → API keys → Claude Code</button>,
						then <button type="button" onClick={restartSession} className="underline font-semibold">Restart</button> this session.
					</div>
				)}
				{view === "summary" && (
					<CopilotView
						instanceId={instanceId}
						voice={voice}
						loop={loop}
						workMode={workMode}
						onSetWorkMode={setWorkMode}
						chatInput={chatInput}
						setChatInput={setChatInput}
						sendInstruction={sendInstruction}
						summaryHistory={summaryHistory}
						summaryBusy={summaryBusy}
						threadRef={threadRef}
						loopPresets={loopPresets}
						onClearChat={clearChat}
					/>
				)}
				{view === "terminal" && (
					<TerminalView
						termInput={termInput}
						setTermInput={setTermInput}
						sendTerminalMessage={sendTerminalMessage}
						terminalText={terminalText}
						termRef={termRef}
						termAutoScroll={termAutoScroll}
						setTermAutoScroll={setTermAutoScroll}
					/>
				)}
				{settingsModal}
			</div>
		);
	}

	// ── Repos list view ──
	return (
		<>
			<ReposList
				instanceId={instanceId}
				repos={repos}
				sessions={sessions}
				repoStatuses={repoStatuses}
				runnerOnline={runnerOnline}
				showAddRepo={showAddRepo}
				setShowAddRepo={setShowAddRepo}
				addRepoInput={addRepoInput}
				setAddRepoInput={setAddRepoInput}
				addRepo={addRepo}
				openTerminal={openTerminal}
				startSession={startSession}
				deleteRepo={deleteRepo}
				setSettingsRepoId={setSettingsRepoId}
				repoLabel={repoLabel}
				getActiveSession={getActiveSession}
				onWorkOnIssue={workOnIssue}
				onOpenEngines={() => setShowEngines(true)}
			/>
			{settingsModal}
			{showEngines && (
				<EnginesModal
					instanceId={instanceId}
					engines={engines}
					defaultEngineId={defaultEngine}
					onClose={() => setShowEngines(false)}
					onSaved={loadCoding}
				/>
			)}
		</>
	);
}
