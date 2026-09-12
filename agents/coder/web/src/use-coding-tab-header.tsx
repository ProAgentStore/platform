import { useEffect, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import { ArrowLeft, ChevronDown, Copy, Eye, FolderCog, Hammer, Plus, Settings, Square, SquareTerminal } from "lucide-react";
import type { CodingRepo, CodingSession } from "./types";
import type { RepoState } from "./repo-status";
import { isEngineBusy } from "./engine-busy";
import { repoForSession } from "./session-open";
import { repoTitle } from "./repo-title";
import AgentStatusBadge from "./AgentStatusBadge";

/**
 * The multi-repo session header, pushed into the console shell's own 48px bar.
 *
 * A hook rather than a component because the effect, its cleanup and its dependency array are one
 * mechanism: the header is handed UPWARDS through `onHeaderOverride`, so what stops it re-rendering
 * the parent forever is the dep list at the bottom, and separating that from the JSX it guards is
 * how the render storm in the comment there comes back.
 *
 * It takes 25 values, which is the honest count of what a header showing repo, engine state, view
 * toggle and five session actions has to read. They are passed rather than re-derived: every one is
 * state CodingTab already owns, and a second source for any of them is a second answer.
 */
export function useCodingTabHeader({
	instanceId, singleRepo, copilot, openSession, repos, openState, onHeaderOverride,
	view, setView, reposRef, repoStatuses,
	repoMenuOpen, setRepoMenuOpen, sessionMenuOpen, setSessionMenuOpen,
	setLandingView, setShowAddRepo, setSettingsRepoId,
	closeTerminal, switchToRepo,
	copySummaryJson, freshStart, restartSession, endSession, navigate,
}: {
	instanceId: string;
	singleRepo: boolean;
	copilot: boolean;
	openSession: CodingSession | null;
	repos: CodingRepo[];
	openState: RepoState;
	onHeaderOverride?: (content: ReactNode | null) => void;
	view: "summary" | "terminal";
	setView: (v: "summary" | "terminal") => void;
	/** Read inside the dropdown so a repo list refresh does not re-run the effect. */
	reposRef: { current: CodingRepo[] };
	repoStatuses: Record<string, string>;
	repoMenuOpen: boolean;
	setRepoMenuOpen: Dispatch<SetStateAction<boolean>>;
	sessionMenuOpen: boolean;
	setSessionMenuOpen: Dispatch<SetStateAction<boolean>>;
	setLandingView: (v: "repos" | "builds") => void;
	setShowAddRepo: (v: boolean) => void;
	setSettingsRepoId: (id: string | null) => void;
	closeTerminal: () => void;
	switchToRepo: (r: CodingRepo) => void;
	copySummaryJson: () => void;
	freshStart: () => void;
	restartSession: () => void;
	endSession: () => void;
	navigate: NavigateFunction;
}) {
	// Push session header override to parent when session is open. The repo is looked up by the
	// session's own `repoId` (./session-open) — asking which repo has this as its ACTIVE session
	// answered "none" for an ENDED one, and the header then printed a raw UUID in place of the
	// repo's name.
	const openRepo = repoForSession(repos, openSession);
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
								<button type="button" aria-label="Close menu" onClick={() => setRepoMenuOpen(false)} className="fixed inset-0 z-40 cursor-default">
									<span className="sr-only">Close menu</span>
								</button>
								<div className="absolute top-full left-0 mt-1 z-50 min-w-52 max-h-72 overflow-auto bg-panel border border-line rounded-lg shadow-lg py-1">
									<button
										type="button"
										onClick={() => { setRepoMenuOpen(false); closeTerminal(); }}
										className="w-full text-left px-3 py-1.5 text-xs font-bold text-muted hover:bg-panel-hover flex items-center gap-1.5"
									>
										<ArrowLeft size={12} /> All repos
									</button>
									{/* Reach the Builds status view from inside a session (otherwise it's only on the
									    landing view, which the auto-open-session flow skips past). */}
									<button
										type="button"
										onClick={() => { setRepoMenuOpen(false); setLandingView("builds"); closeTerminal(); }}
										className="w-full text-left px-3 py-1.5 text-xs font-bold text-muted hover:bg-panel-hover flex items-center gap-1.5"
									>
										<Hammer size={12} /> Build status
									</button>
									<div className="border-t border-line my-1" />
									{reposRef.current.map((r) => {
									const st = repoStatuses[r.id];
									const current = r.id === openSession.repoId;
									return (
										<button key={r.id} type="button" onClick={() => switchToRepo(r)} className={`w-full text-left px-3 py-1.5 text-sm hover:bg-panel-hover flex items-center justify-between gap-2 ${current ? "text-accent font-bold" : ""}`}>
											<span className="truncate">{repoTitle(r)}</span>
											{current ? <span className="text-accent text-xs shrink-0">●</span> : (isEngineBusy(st)) ? <span className="text-amber-500 text-2xs shrink-0">working</span> : null}
										</button>
									);
								})}
									<div className="border-t border-line my-1" />
									{/* One-tap path to the add-repo form from inside a session (esp. mobile,
									    where the repos-list "+ Add" was hard to reach). */}
									<button
										type="button"
										onClick={() => { setRepoMenuOpen(false); closeTerminal(); setShowAddRepo(true); }}
										className="w-full text-left px-3 py-1.5 text-sm text-accent font-semibold hover:bg-panel-hover flex items-center gap-1.5"
									>
										<Plus size={13} /> Add a repo
									</button>
								</div>
							</>
						)}
				</div>
				<AgentStatusBadge state={openState} />
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
									<button type="button" aria-label="Close session menu" onClick={() => setSessionMenuOpen(false)} className="fixed inset-0 z-40 cursor-default sm:hidden">
										<span className="sr-only">Close session menu</span>
									</button>
									<div className="absolute right-0 top-full mt-1 z-50 min-w-44 bg-panel border border-line rounded-lg shadow-lg py-1 sm:hidden">
										<button
											type="button"
											onClick={() => { setSessionMenuOpen(false); navigate(`/instances/${instanceId}/settings`); }}
											className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-panel-hover flex items-center gap-2"
										>
											<Settings size={14} /> Agent settings
										</button>
										<button
											type="button"
											onClick={() => { setSessionMenuOpen(false); setSettingsRepoId(openRepo?.id || openSession.repoId); }}
											className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-panel-hover flex items-center gap-2"
										>
											<FolderCog size={14} /> Repo settings
										</button>
										<div className="border-t border-line my-1" />
										<button
											type="button"
											onClick={() => { setSessionMenuOpen(false); endSession(); }}
											className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-danger-soft flex items-center gap-2"
										>
											<Square size={14} /> Stop session
										</button>
									</div>
								</>
							)}
					</div>
					<button type="button" onClick={copySummaryJson} title="Copy conversation as JSON" className="text-xs px-1.5 py-1 rounded-lg border border-line text-muted font-semibold hover:border-accent hover:text-accent hidden sm:flex items-center gap-1"><Copy size={12} /><span>Copy</span></button>
					<button type="button" onClick={freshStart} title="Fresh start" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent hidden sm:block">Fresh</button>
					<button type="button" onClick={restartSession} title="Restart CLI" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent hidden sm:block">Restart</button>
					<button type="button" onClick={endSession} title="End session" aria-label="End session" className="text-xs px-1.5 py-1 rounded-md border border-danger text-danger font-semibold hidden sm:block"><Square size={13} /></button>
				</div>
			</div>
		);
		return () => onHeaderOverride(null);
		// Deps so this only re-runs when the header's VISIBLE content changes. With no
		// deps it was a render storm: each run handed setChildHeader a fresh element →
		// re-rendered the parent → this child → effect again, continuously.
	}, [openSession, onHeaderOverride, openRepo?.name, view, repoMenuOpen, sessionMenuOpen, openState, singleRepo]);
}
