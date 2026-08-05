import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { CodingRepo, CodingSession, CodingEngine } from "./types";
import { usePolling } from "@proagentstore/sdk/hooks";
import { useVoice } from "@proagentstore/sdk/hooks";
import { useCodingLoop } from "./use-coding-loop";
import { repoTitle } from "./repo-title";
import CopilotView from "./CopilotView";
import TerminalView from "./TerminalView";
import ReposList from "./ReposList";
import RepoIssues from "./RepoIssues";
import RepoSettingsModal from "./RepoSettingsModal";
import EnginesModal from "./EnginesModal";
import BuildsPanel from "./BuildsPanel";
import { ArrowLeft, Copy, Settings, FolderCog, ChevronDown, Eye, Square, SquareTerminal, Plus, FolderGit2, Hammer, CircleDot, Cpu, RotateCw } from "lucide-react";

interface Props {
	instanceId: string;
	initialSessionId?: string;
	onHeaderOverride?: (content: ReactNode | null) => void;
	/**
	 * This agent owns exactly ONE repo (capabilities.surfaceOptions.coding.repos === "single").
	 * Hides add-repo and the repo list: a Repo Coder is one agent per repository, and rendering
	 * affordances it can never use is what made a configured agent look like the hardcoded Coder.
	 */
	singleRepo?: boolean;
	/**
	 * Does this agent have a Co-pilot — a SECOND conversation scoped to one session?
	 *
	 * False for a configurable Repo Coder: one chat per agent. Its Assistant carries the same
	 * repo/git/issue read tools from the registry, so nothing is lost but the second brain. True
	 * (default) for the legacy hardcoded Coder, which is deliberately left exactly as it was.
	 */
	copilot?: boolean;
}

// Remember the repo the user was last working on, per instance, so returning to the Coding
// tab (without a deep-linked session in the URL) restores THAT repo instead of defaulting to
// whichever active session happens to be first in the list. Keyed by repoId (stable — a
// session can end/restart with a new id, but the repo persists).
const lastRepoKey = (instanceId: string) => `coder:lastRepo:${instanceId}`;
function saveLastRepo(instanceId: string, repoId: string) {
	try { localStorage.setItem(lastRepoKey(instanceId), repoId); } catch { /* storage unavailable */ }
}
function loadLastRepo(instanceId: string): string | null {
	try { return localStorage.getItem(lastRepoKey(instanceId)); } catch { return null; }
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

/** Returned by /capture when the engine is waiting for a human to sign in. */
type AuthPrompt = { kind: "oauth-url" | "menu" | "unknown"; url: string | null; evidence: string; guidance: string };

export default function CodingTab({ instanceId, initialSessionId, onHeaderOverride, singleRepo = false, copilot = true }: Props) {
	const navigate = useNavigate();
	const [repos, setRepos] = useState<CodingRepo[]>([]);
	const [sessions, setSessions] = useState<CodingSession[]>([]);
	const [engines, setEngines] = useState<CodingEngine[]>([]);
	const [defaultEngine, setDefaultEngine] = useState("claude");
	const [runnerOnline, setRunnerOnline] = useState<boolean | null>(null);

	// Session view state
	const [openSession, setOpenSession] = useState<CodingSession | null>(null);
	// With no Co-pilot there is only one view, and it is the terminal.
	const [view, setView] = useState<"summary" | "terminal">(copilot ? "summary" : "terminal");
	const [terminalText, setTerminalText] = useState("(waiting...)");
	// Last persisted tmux snapshot (coding_timeline, DB) — shown in the Terminal view when
	// the session has no LIVE pane (ended, or the runner isn't attached), so the terminal
	// history you saw before doesn't vanish to a blank screen. `terminalLive` tracks whether
	// what's on screen is the live pane vs this saved fallback.
	const [savedTerminal, setSavedTerminal] = useState("");
	const [terminalLive, setTerminalLive] = useState(false);
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
	// Landing view toggle: the repos list vs. the Builds status panel (CODER-004).
	const [landingView, setLandingView] = useState<"repos" | "builds">("repos");
	/**
	 * The single-repo agent's surface: three views, one nav row, always visible.
	 *
	 * A one-repo Coder had `Repos | Builds` where "Repos" was one repo, Issues were nested inside
	 * that repo's card, and the terminal took over the whole header — so opening it hid every
	 * other view behind a back arrow. Terminal / Issues / Builds are the three things this agent
	 * actually has, so they are the navigation.
	 */
	const [soloView, setSoloView] = useState<"terminal" | "issues" | "builds">("terminal");
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

	// Auto-associate local checkouts with their GitHub owner/repo (attempted once each per
	// mount) so build status shows for repos run from a local path. No-op when offline.
	const detectAttemptedRef = useRef<Set<string>>(new Set());

	const loadCoding = useCallback(async () => {
		try {
			const [repoData, sessionData, engineData] = await Promise.all([
				api<{ repos: CodingRepo[] }>(`/v1/instances/${instanceId}/coding/repos`),
				api<{ sessions: CodingSession[] }>(`/v1/instances/${instanceId}/coding/sessions`),
				api<{ engines: CodingEngine[]; defaultEngineId?: string }>(`/v1/instances/${instanceId}/coding/engines`),
			]);
			const repos = repoData.repos || [];
			setRepos(repos);
			setSessions(sessionData.sessions || []);
			setEngines(engineData.engines || []);
			if (engineData.defaultEngineId) setDefaultEngine(engineData.defaultEngineId);

			// Local repos with no GitHub association → ask the runner to read their `origin`
			// remote and store owner/repo, so the Builds panel can query Actions for them.
			const needDetect = repos.filter((r) => r.workdir && !r.githubRepo && !detectAttemptedRef.current.has(r.id));
			if (needDetect.length) {
				let found = false;
				await Promise.all(needDetect.map(async (r) => {
					detectAttemptedRef.current.add(r.id);
					try {
						const d = await api<{ githubRepo?: string | null }>(`/v1/instances/${instanceId}/coding/repos/${r.id}/detect-github`, { method: "POST" });
						if (d.githubRepo) found = true;
					} catch { /* offline / non-github — leave as local-only */ }
				}));
				if (found) {
					const fresh = await api<{ repos: CodingRepo[] }>(`/v1/instances/${instanceId}/coding/repos`).catch(() => null);
					if (fresh?.repos) setRepos(fresh.repos);
				}
			}
		} catch {}
	}, [instanceId]);

	useEffect(() => {
		(async () => {
			await loadCoding();
		})();
	}, [loadCoding]);

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
	// Engine sign-in relay (#coding-auth): the CLI's OAuth uses a LOOPBACK redirect, so the
	// browser must be on the runner machine — opening the link here would redirect to this
	// laptop's localhost, where nothing is listening.
	const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
	const [signinMsg, setSigninMsg] = useState("");
	const startSignin = useCallback(async () => {
		if (!openSession) return;
		setSigninMsg("Opening the sign-in page on your runner machine…");
		try {
			const r = await api<{ ok: boolean; guidance?: string }>(
				`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/signin`,
				{ method: "POST" },
			);
			setSigninMsg(r.ok ? "Opened — take over the browser to finish signing in." : (r.guidance ?? "Use the terminal below to choose an option."));
		} catch (e) {
			setSigninMsg(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId, openSession]);

	const termTextRef = useRef(terminalText);
	termTextRef.current = terminalText;
	const savedTerminalRef = useRef(savedTerminal);
	savedTerminalRef.current = savedTerminal;
	const pollTerminal = useCallback(async () => {
		if (!openSession) return;
		try {
			const d = await api<{ pane?: string; runState?: string; authPrompt?: AuthPrompt; runnerConnected?: boolean }>(
				`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/capture`,
			);
			// An engine blocked on sign-in is otherwise indistinguishable from a dead session:
			// idle state, a pane that stops changing, no error anywhere.
			setAuthPrompt(d.authPrompt ?? null);
			// The header badge reads `repoStatuses[repoId]`, and the only other writer
			// (`pollStatuses`) is DISABLED while a session is open — so the badge added to say
			// Working/Idle sat on "Idle" for the whole session while the pane visibly scrolled.
			// This response already carries runState; write it. Must be BEFORE the
			// unchanged-text early return below, or a stable pane re-freezes the badge.
			setRepoStatuses((s) => (s[openSession.repoId] === (d.runState || "idle") ? s : { ...s, [openSession.repoId]: d.runState || "idle" }));
			if (typeof d.runnerConnected === "boolean") setRunnerOnline(d.runnerConnected);
			const live = (d.pane || "").trim() ? (d.pane as string) : "";
			// No live tmux (ended session / detached runner) → fall back to the last saved
			// snapshot from the DB instead of blanking the terminal.
			const newText = live || savedTerminalRef.current || "(waiting for output...)";
			setTerminalLive(!!live);
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

	usePolling(pollSummary, 4500, copilot && !!openSession && view === "summary");

	// Co-pilot auto-scroll now lives in CopilotView, gated on the user's scroll position (#132)
	// — a new message no longer yanks the view down while the user is reading history.

	// Auto-scroll terminal when new output arrives or view switches to terminal
	useEffect(() => {
		if (!terminalText && view !== "terminal") return;
		if (termAutoScroll && termRef.current) {
			requestAnimationFrame(() => {
				if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
			});
		}
	}, [terminalText, termAutoScroll, view]);

	// Auto-open runs at most ONCE per mount. Any open/close latches this so a later `sessions`
	// refresh (loadCoding on start/end/add) can't re-run the restore effect and re-open a
	// session the user has since closed (or yank them off the Terminal view).
	const autoOpenedRef = useRef(false);
	const openTerminal = useCallback(async (session: CodingSession) => {
		autoOpenedRef.current = true;
		setOpenSession(session);
		saveLastRepo(instanceId, session.repoId); // remember this repo for next visit
		setView(copilot ? "summary" : "terminal");
		setSummaryHistory([]);
		navigate(`/instances/${instanceId}/coding/${session.id}`, { replace: true });
		setTerminalText("(waiting...)");
		setSavedTerminal("");
		setTerminalLive(false);
		// Ensure session is live
		try {
			await api(`/v1/instances/${instanceId}/coding/sessions/${session.id}/start`, { method: "POST" });
		} catch {}
		// Load history — ?full=1 so we get BOTH the chat AND the persisted terminal snapshots.
		try {
			const d = await api<{ chat?: TimelineEntry[]; timeline?: TimelineEntry[] }>(`/v1/instances/${instanceId}/coding/sessions/${session.id}/timeline?full=1`);
			const entries = (d.chat || d.timeline || [])
				.filter((e) => e.type === "chat_user" || e.type === "chat_assistant" || e.type === "chat_system" || e.type === "system" || e.type === "command")
				.map((e) => ({
					role: e.type === "chat_user" || e.type === "command" ? "user" : e.type === "chat_system" || e.type === "system" ? "system" : "assistant",
					content: e.content || e.text || "",
					time: e.createdAt,
					audioKey: e.audioKey,
				}));
			setSummaryHistory(entries);
			// Last persisted tmux snapshot → the Terminal view's DB fallback. Show it right
			// away so the terminal isn't blank before the first live capture; a live pane
			// (if the session is running) overwrites it on the next poll.
			const lastTerm = (d.timeline || []).filter((e) => e.type === "terminal").slice(-1)[0];
			const saved = (lastTerm?.content || lastTerm?.text || "").trim();
			if (saved) { setSavedTerminal(saved); setTerminalText(saved); }
		} catch (e) {
			console.error("[coding] timeline load failed:", e);
		}
	}, [instanceId, navigate, copilot]);

	// Auto-open a session on mount ONLY for a deep link (URL session id) or the repo the user
	// was last working on (persisted). With neither, land on the repo LIST view (openSession
	// stays null) rather than auto-opening whatever active session happens to be first — that
	// yanked users into a session they didn't ask for.
	useEffect(() => {
		if (autoOpenedRef.current || !sessions.length) return;
		let target: CodingSession | undefined;
		if (initialSessionId) {
			target = sessions.find((s) => s.id === initialSessionId);
		} else if (singleRepo) {
			// One repo: attach to its live session, always. There is nothing to disambiguate and
			// nothing to hide — the terminal renders INSIDE the Terminal tab, with Issues and
			// Builds still one click away. (This was briefly disabled, back when opening a session
			// took over the whole page and buried the other views; the solo layout removed that
			// reason, and leaving it off just meant a live session sat behind an "Open session"
			// button on the tab whose entire purpose is to show it.)
			target = sessions.find((s) => s.status === "active");
		} else {
			// Multi-repo: restore the last repo you were in — a real question when there are
			// several — but only if it still has a live session.
			const lastRepo = loadLastRepo(instanceId);
			target = lastRepo ? sessions.find((s) => s.repoId === lastRepo && s.status === "active") : undefined;
		}
		if (target) {
			autoOpenedRef.current = true;
			openTerminal(target);
		}
	}, [sessions, initialSessionId, instanceId, openTerminal, singleRepo]);

	const closeTerminal = useCallback(() => {
		autoOpenedRef.current = true; // stay on the list — don't let a sessions refresh re-open
		setOpenSession(null);
		setSummaryHistory([]);
		navigate(`/instances/${instanceId}/coding`, { replace: true });
	}, [instanceId, navigate]);

	// Watch the Engine after delegation — poll until idle, then auto-summarize
	const watcherRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const voiceRef = useRef(voice);
	voiceRef.current = voice;
	// Track the open session so a watcher started for one session can't dump its completion
	// summary (or speak it) into a DIFFERENT session's Co-pilot thread after the user switches
	// repos/sessions. The durable server-side watch still persists the summary to the right
	// session's timeline, so bailing here loses nothing.
	const openSessionRef = useRef<string | null>(null);
	openSessionRef.current = openSession?.id ?? null;
	const watchForFinish = useCallback((sid: string) => {
		if (watcherRef.current) clearTimeout(watcherRef.current);
		let attempts = 0;
		const MAX_ATTEMPTS = 60; // ~3 min max watch time
		const poll = async () => {
			if (openSessionRef.current !== sid) return; // user switched away — stop watching this one
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
				// Always surface a closing message when the engine goes idle. Previously, if
				// /explain returned an empty reply the session ended SILENTLY (no bubble) — the
				// "session-end message sometimes not shown" bug (#122). Fall back to a clear
				// system note so the user never just sees the agent go quiet.
				const reply = summary.reply?.trim();
				if (reply) {
					setSummaryHistory((prev) => [...prev, { role: "assistant", content: reply }]);
					voiceRef.current.maybeSpeakResponse(reply);
				} else {
					setSummaryHistory((prev) => [...prev, { role: "system", content: "The engine finished and is now idle. Open the Terminal view for the full output." }]);
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

	// Delete is confirmed in the repo settings sheet (RepoSettingsModal); this just
	// performs it, closes the sheet, and refreshes the list.
	const deleteRepo = async (repoId: string) => {
		await api(`/v1/instances/${instanceId}/coding/repos/${repoId}`, { method: "DELETE" });
		setSettingsRepoId(null);
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

		// Hand the issue to the LOOP, which dispatches to the Pilot and actually drives the engine
		// (#210) — and whose instructions now appear in the Assistant thread, so the work is
		// visible rather than happening behind a terminal.
		//
		// It used to call setChatInput, which only ever fed the Co-pilot's box. With the Co-pilot
		// declared off for a configurable Repo Coder (#209) that box no longer renders, so "Work on
		// this" opened an empty terminal and dropped the objective on the floor. My regression.
		//
		// Not the Assistant chat directly: a Repo Coder declares `drive:false`, so its chat would
		// TALK about the issue and change nothing — the exact failure #210 exists to prevent.
		try {
			await api(`/v1/instances/${instanceId}/loop`, {
				method: "POST",
				body: JSON.stringify({ objective, maxIterations: 10 }),
			});
			// Land where the work is now reported, so it is not silent again.
			navigate(`/instances/${instanceId}`);
		} catch {
			// Keep the objective rather than losing it: the Co-pilot box still exists on the legacy
			// multi-repo Coder, and on a configurable one the terminal is at least open and focused.
			setChatInput(objective);
		}
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
	const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
	const reposRef = useRef(repos);
	reposRef.current = repos;
	const switchToRepo = (r: CodingRepo) => {
		setRepoMenuOpen(false);
		setSessionMenuOpen(false);
		const active = getActiveSession(r.id);
		if (active) openTerminal(active);
		else startSession(r.id);
	};

	// Push session header override to parent when session is open
	const openRepo = openSession ? repos.find((r) => getActiveSession(r.id)?.id === openSession.id) : null;
	// Status of the currently-open session, for the header badge (CODER-005). A primitive
	// string (not the repoStatuses object) so the header effect re-pushes only when the status
	// actually changes — depending on the object would re-fire every 3s poll (a render storm).
	const openStatus = openSession
		? repoStatuses[openSession.repoId] || (runnerOnline === false ? "offline" : "idle")
		: "idle";
	// biome-ignore lint/correctness/useExhaustiveDependencies: event handlers intentionally read current component state; the header only needs to refresh when visible header state changes.
	useEffect(() => {
		// NOT for the single-repo surface. That view keeps the normal instance header and carries
		// its own Terminal/Issues/Builds row, so taking the header over would replace the tab bar,
		// stack two sets of chrome, and hide the very navigation the solo view exists to keep.
		if (singleRepo || !openSession || !onHeaderOverride) return;
		onHeaderOverride(
			<div className="flex items-center gap-1 sm:gap-2 min-w-0 w-full">
				<button type="button" onClick={closeTerminal} title={singleRepo ? "Back" : "All repos"} aria-label={singleRepo ? "Back" : "All repos"} className="flex items-center justify-center text-muted hover:text-ink shrink-0 -ml-1 w-7 h-8 sm:w-auto sm:h-auto sm:px-1 sm:py-1"><ArrowLeft size={16} /></button>
				<div className="relative min-w-0 shrink">
					{/* A one-repo agent has nothing to switch TO. The dropdown listed a single repo
					    and offered "Add a repo" that ReposList then refuses to render — a button
					    that closed your terminal and showed nothing. It is also the multi-repo
					    mental model the Lead/Repo-Coder split exists to remove: you switch repos by
					    switching AGENTS now. Plain label instead. */}
					{singleRepo ? (
						<span className="block truncate text-sm font-semibold max-w-[5.75rem] sm:max-w-[11rem]">{openRepo ? repoTitle(openRepo) : openSession.repoId}</span>
					) : (
					<button type="button" onClick={() => setRepoMenuOpen((v) => !v)} title="Switch repo" className="flex items-center gap-1 text-sm font-semibold hover:text-accent w-full max-w-[5.75rem] sm:max-w-[11rem] min-w-0">
						<span className="truncate">{openRepo ? repoTitle(openRepo) : openSession.repoId}</span>
						<ChevronDown size={14} className="shrink-0 text-muted" />
					</button>
					)}
					{repoMenuOpen && (
						<>
							<button type="button" aria-label="Close menu" onClick={() => setRepoMenuOpen(false)} className="fixed inset-0 z-40 cursor-default" />
							<div className="absolute top-full left-0 mt-1 z-50 min-w-52 max-h-72 overflow-auto bg-panel border border-line rounded-lg shadow-lg py-1">
								<button type="button" onClick={() => { setRepoMenuOpen(false); closeTerminal(); }} className="w-full text-left px-3 py-1.5 text-xs font-bold text-muted hover:bg-panel-hover flex items-center gap-1.5"><ArrowLeft size={12} /> All repos</button>
								{/* Reach the Builds status view from inside a session (otherwise it's only on the
								    landing view, which the auto-open-session flow skips past). */}
								<button type="button" onClick={() => { setRepoMenuOpen(false); setLandingView("builds"); closeTerminal(); }} className="w-full text-left px-3 py-1.5 text-xs font-bold text-muted hover:bg-panel-hover flex items-center gap-1.5"><Hammer size={12} /> Build status</button>
								<div className="border-t border-line my-1" />
								{reposRef.current.map((r) => {
									const st = repoStatuses[r.id];
									const current = r.id === openSession.repoId;
									return (
										<button key={r.id} type="button" onClick={() => switchToRepo(r)} className={`w-full text-left px-3 py-1.5 text-sm hover:bg-panel-hover flex items-center justify-between gap-2 ${current ? "text-accent font-bold" : ""}`}>
											<span className="truncate">{repoTitle(r)}</span>
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
				<AgentStatusBadge status={openStatus} />
				{/* Icon-only on mobile (saves space); icon + label from sm up. */}
				{copilot && (
				<div className="flex border border-line rounded-lg overflow-hidden shrink-0">
					<button type="button" onClick={() => setView("summary")} title="Co-pilot" aria-label="Co-pilot" aria-pressed={view === "summary"} className={`flex items-center justify-center gap-1 w-8 sm:w-auto sm:px-2 py-1 text-xs font-bold ${view === "summary" ? "bg-accent-soft text-accent" : "text-muted"}`}><Eye size={14} /><span className="hidden sm:inline">Co-pilot</span></button>
					<button type="button" onClick={() => setView("terminal")} title="Terminal" aria-label="Terminal" aria-pressed={view === "terminal"} className={`flex items-center justify-center gap-1 w-8 sm:w-auto sm:px-2 py-1 text-xs font-bold ${view === "terminal" ? "bg-accent-soft text-accent" : "text-muted"}`}><SquareTerminal size={14} /><span className="hidden sm:inline">Terminal</span></button>
				</div>
				)}
				<div className="ml-auto flex gap-1 shrink-0">
					{/* Agent settings = the instance-level Settings tab. While a coding session is
					    open, CodingTab overrides the parent header (which holds the tab bar), so this
					    is the way back to it. Labeled on desktop (primary), and in the mobile menu. */}
					<button type="button" onClick={() => navigate(`/instances/${instanceId}/settings`)} title="Agent settings" aria-label="Agent settings" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent hidden sm:flex items-center gap-1"><Settings size={13} /><span>Settings</span></button>
					<div className="relative">
						<button type="button" onClick={() => setSessionMenuOpen((v) => !v)} title="Session settings" aria-label="Session settings" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent sm:hidden"><Settings size={13} /></button>
						<button type="button" onClick={() => setSettingsRepoId(openRepo?.id || openSession.repoId)} title="Repo settings" aria-label="Repo settings" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent hidden sm:flex items-center gap-1"><FolderCog size={13} /><span>Repo</span></button>
						{sessionMenuOpen && (
							<>
								<button type="button" aria-label="Close session menu" onClick={() => setSessionMenuOpen(false)} className="fixed inset-0 z-40 cursor-default sm:hidden" />
								<div className="absolute right-0 top-full mt-1 z-50 min-w-44 bg-panel border border-line rounded-lg shadow-lg py-1 sm:hidden">
									<button type="button" onClick={() => { setSessionMenuOpen(false); navigate(`/instances/${instanceId}/settings`); }} className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-panel-hover flex items-center gap-2"><Settings size={14} /> Agent settings</button>
									<button type="button" onClick={() => { setSessionMenuOpen(false); setSettingsRepoId(openRepo?.id || openSession.repoId); }} className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-panel-hover flex items-center gap-2"><FolderCog size={14} /> Repo settings</button>
									<div className="border-t border-line my-1" />
									<button type="button" onClick={() => { setSessionMenuOpen(false); endSession(); }} className="w-full text-left px-3 py-2 text-sm text-red hover:bg-red/10 flex items-center gap-2"><Square size={14} /> Stop session</button>
								</div>
							</>
						)}
					</div>
					<button type="button" onClick={copySummaryJson} title="Copy conversation as JSON" className="text-xs px-1.5 py-1 rounded-lg border border-line text-muted font-semibold hover:border-accent hover:text-accent hidden sm:flex items-center gap-1"><Copy size={12} /><span>Copy</span></button>
					<button type="button" onClick={freshStart} title="Fresh start" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent hidden sm:block">Fresh</button>
					<button type="button" onClick={restartSession} title="Restart CLI" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent hidden sm:block">Restart</button>
					<button type="button" onClick={endSession} title="End session" aria-label="End session" className="text-xs px-1.5 py-1 rounded-md border border-red text-red font-semibold hidden sm:block"><Square size={13} /></button>
				</div>
			</div>
		);
		return () => onHeaderOverride(null);
		// Deps so this only re-runs when the header's VISIBLE content changes. With no
		// deps it was a render storm: each run handed setChildHeader a fresh element →
		// re-rendered the parent → this child → effect again, continuously.
	}, [openSession, onHeaderOverride, openRepo?.name, view, repoMenuOpen, sessionMenuOpen, openStatus, singleRepo]);

	const settingsModal = settingsRepoId
		? (() => {
				const repo = repos.find((r) => r.id === settingsRepoId);
				return repo ? (
					<RepoSettingsModal repo={repo} instanceId={instanceId} onClose={() => setSettingsRepoId(null)} onSaved={loadCoding} onDelete={() => deleteRepo(repo.id)} />
				) : null;
			})()
		: null;

	// Claude Code signed-out CTA — the headless engine surfaces a login error in its
	// transcript when the runner machine has no (or expired) Claude credentials.
	const claudeSignedOut =
		openSession?.clientType === "claude" &&
		/not logged in|please run \/login|invalid api key|oauth token (is |has )?(expired|revoked)/i.test(terminalText);

	// ── Single-repo agent: one surface, three views, navigation never hidden ──
	//
	// Guarded on the DATA as well as the declaration. `repos: "single"` is what the agent says;
	// an instance could still hold two rows (added before the declaration, or by the API), and a
	// solo view showing `repos[0]` would make the other one unreachable. In that case fall through
	// to the list, which still hides add-repo.
	if (singleRepo && repos.length <= 1) {
		const solo = repos[0];
		const tab = (id: typeof soloView, label: string, Icon: typeof SquareTerminal) => (
			<button
				type="button"
				onClick={() => setSoloView(id)}
				aria-pressed={soloView === id}
				className={`flex items-center gap-1 px-2.5 py-1 text-xs font-bold ${soloView === id ? "bg-accent-soft text-accent" : "text-muted hover:text-accent"}`}
			>
				<Icon size={13} /> {label}
			</button>
		);
		return (
			<div className="flex flex-col h-full min-h-0">
				<div className="px-2 pt-2 sm:px-4 sm:pt-3 flex items-center gap-2 flex-wrap">
					<div className="inline-flex border border-line rounded-lg overflow-hidden shrink-0">
						{tab("terminal", "Terminal", SquareTerminal)}
						{tab("issues", "Issues", CircleDot)}
						{tab("builds", "Builds", Hammer)}
					</div>
					{solo && <span className="text-xs text-muted truncate min-w-0">{repoTitle(solo)} · {repoLabel(solo)}</span>}
					<div className="ml-auto flex gap-1 shrink-0">
						<button type="button" onClick={() => setShowEngines(true)} title="CLI engines & sign-in" aria-label="CLI engines" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent"><Cpu size={13} /></button>
						{solo && <button type="button" onClick={() => setSettingsRepoId(solo.id)} title="Repo settings" aria-label="Repo settings" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent"><FolderCog size={13} /></button>}
						{/* The session actions the header takeover used to hold. Without these the solo
						    view could start a session and never stop it. */}
						{openSession && <button type="button" onClick={copySummaryJson} title="Copy conversation as JSON" aria-label="Copy conversation as JSON" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent"><Copy size={13} /></button>}
						{openSession && <button type="button" onClick={restartSession} title="Restart the CLI" aria-label="Restart the CLI" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent"><RotateCw size={13} /></button>}
						{openSession && <button type="button" onClick={endSession} title="End session" aria-label="End session" className="text-xs px-1.5 py-1 rounded-md border border-red text-red font-semibold"><Square size={13} /></button>}
					</div>
				</div>

				{claudeSignedOut && soloView === "terminal" && (
					<div className="bg-orange-50 border border-amber-500 rounded-lg p-2.5 m-2 text-sm text-orange-900">
						<b>Claude Code is signed out on your runner.</b> Run <code>claude setup-token</code> on any machine (it opens a browser),
						save the token under <button type="button" onClick={() => navigate("/profile")} className="underline font-semibold">Profile → API keys → Claude Code</button>,
						then <button type="button" onClick={restartSession} className="underline font-semibold">Restart</button> this session.
					</div>
				)}

				{soloView === "terminal" && (
					openSession ? (
						<TerminalView
							termInput={termInput}
							setTermInput={setTermInput}
							sendTerminalMessage={sendTerminalMessage}
							terminalText={terminalText}
							termRef={termRef}
							termAutoScroll={termAutoScroll}
							setTermAutoScroll={setTermAutoScroll}
							stale={!terminalLive && !!savedTerminal}
						/>
					) : (
						<div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
							{!solo ? (
								<p className="text-sm text-muted-soft">No repository set yet — add its path in <b>Settings → Agent settings</b>.</p>
							) : runnerOnline === false ? (
								<>
									<p className="text-sm text-muted">Your machine isn't connected.</p>
									<code className="bg-panel border border-line rounded-md px-2 py-1 text-sm">pags up</code>
								</>
							) : (
								<>
									{/* No "Open session": a live one is attached automatically above, so the
									    only reason to be here is that there ISN'T one. */}
									<p className="text-sm text-muted">No session running.</p>
									<button type="button" onClick={() => startSession(solo.id)} className="text-sm px-4 py-2 rounded-lg bg-accent text-white font-bold">
										Start a session
									</button>
								</>
							)}
						</div>
					)
				)}
				{soloView === "issues" && (
					<div className="flex-1 min-h-0 overflow-auto px-2 py-2 sm:px-4 sm:py-3">
						{solo?.githubRepo ? (
							<div className="bg-panel border border-line rounded-xl p-3">
								<RepoIssues instanceId={instanceId} repo={solo} onWorkOnIssue={workOnIssue} startOpen />
							</div>
						) : (
							<p className="text-center py-6 text-muted-soft text-sm">This repo isn't connected to GitHub, so it has no issues to show.</p>
						)}
					</div>
				)}
				{soloView === "builds" && <BuildsPanel instanceId={instanceId} />}
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
			</div>
		);
	}

	// ── Session open: full-screen terminal/co-pilot (multi-repo) ──
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
				{copilot && view === "summary" && (
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
				{/* Sign-in relay (#coding-auth). Shown in BOTH views: a blocked engine looks like a
				    dead session, and the owner is as likely to be on the co-pilot view as the
				    terminal when they notice nothing is happening. */}
				{authPrompt && (
					<div className="mb-2 rounded-lg border border-orange/40 bg-orange/10 px-3 py-2">
						<div className="text-sm font-semibold">This engine is waiting for you to sign in</div>
						<p className="text-xs text-muted mt-0.5">{authPrompt.guidance}</p>
						{authPrompt.evidence && (
							<pre className="text-[0.65rem] text-muted mt-1 whitespace-pre-wrap break-all">{authPrompt.evidence}</pre>
						)}
						{authPrompt.kind === "oauth-url" && (
							<button
								type="button"
								onClick={startSignin}
								className="mt-2 text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold"
							>
								Open sign-in on my runner
							</button>
						)}
						{signinMsg && <div className="text-xs text-muted mt-1.5">{signinMsg}</div>}
					</div>
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
						stale={!terminalLive && !!savedTerminal}
					/>
				)}
				{settingsModal}
			</div>
		);
	}

	// ── Repos list / Builds view ──
	return (
		<div className="flex flex-col h-full">
			{/* Repos | Builds toggle (mirrors the Co-pilot | Terminal segmented control). */}
			<div className="px-2 pt-2 sm:px-4 sm:pt-3">
				<div className="inline-flex border border-line rounded-lg overflow-hidden shrink-0">
					<button type="button" onClick={() => setLandingView("repos")} aria-pressed={landingView === "repos"}
						className={`flex items-center gap-1 px-2.5 py-1 text-xs font-bold ${landingView === "repos" ? "bg-accent-soft text-accent" : "text-muted hover:text-accent"}`}>
						<FolderGit2 size={13} /> Repos
					</button>
					<button type="button" onClick={() => setLandingView("builds")} aria-pressed={landingView === "builds"}
						className={`flex items-center gap-1 px-2.5 py-1 text-xs font-bold ${landingView === "builds" ? "bg-accent-soft text-accent" : "text-muted hover:text-accent"}`}>
						<Hammer size={13} /> Builds
					</button>
				</div>
			</div>
			{landingView === "repos" ? (
				<ReposList
					singleRepo={singleRepo}
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
					setSettingsRepoId={setSettingsRepoId}
					repoLabel={repoLabel}
					getActiveSession={getActiveSession}
					onWorkOnIssue={workOnIssue}
					onOpenEngines={() => setShowEngines(true)}
				/>
			) : (
				<BuildsPanel instanceId={instanceId} />
			)}
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
		</div>
	);
}

/**
 * Working / Idle / Error badge for the open session (CODER-005). Derived from the session's
 * runState (`repoStatuses`) + runner connectivity. Compact on mobile: the coloured dot is
 * always shown (with a tooltip); the text label appears from `sm` up so it fits the 48px header.
 */
function AgentStatusBadge({ status }: { status: string }) {
	const working = status === "thinking" || status === "working";
	const error = status === "offline";
	const label = working ? "Working" : error ? "Error" : "Idle";
	const base = "inline-flex items-center gap-1 text-[0.6rem] font-bold px-1.5 py-0.5 rounded shrink-0";
	if (working) {
		return (
			<span className={`${base} bg-amber-500/15 text-amber-600`} title={label}>
				<span className="inline-block w-2 h-2 border-2 border-amber-500/40 border-t-amber-600 rounded-full animate-spin" />
				<span className="hidden sm:inline">{label}</span>
			</span>
		);
	}
	return (
		<span className={`${base} ${error ? "bg-red/15 text-red" : "bg-green/15 text-green"}`} title={label}>
			<span className={`w-2 h-2 rounded-full ${error ? "bg-red" : "bg-green"}`} />
			<span className="hidden sm:inline">{label}</span>
		</span>
	);
}
