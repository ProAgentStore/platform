import { useState, useRef, useEffect } from "react";
import { api } from "@proagentstore/sdk/client";
import { createTts, type VoiceTts } from "@proagentstore/sdk/hooks";
import type { CodingRepo, CodingSession } from "./types";
import { Settings, Cpu, Play, Square, Loader2 } from "lucide-react";
import RepoIssues from "./RepoIssues";

type TimelineEntry = { type?: string; content?: string; text?: string };

/** The all-repos landing view: add-repo form, runner CTA, and one row per repo. */
export default function ReposList({
	instanceId,
	repos, sessions, repoStatuses, runnerOnline,
	singleRepo = false, showAddRepo, setShowAddRepo, addRepoInput, setAddRepoInput, addRepo,
	openTerminal, startSession, setSettingsRepoId,
	repoLabel, getActiveSession, onWorkOnIssue, onOpenEngines,
}: {
	instanceId: string;
	repos: CodingRepo[];
	sessions: CodingSession[];
	repoStatuses: Record<string, string>;
	runnerOnline: boolean | null;
	/** One-repo agent: hide add-repo and the "Repositories" header row. */
	singleRepo?: boolean;
	showAddRepo: boolean;
	setShowAddRepo: (v: boolean) => void;
	addRepoInput: string;
	setAddRepoInput: (v: string) => void;
	addRepo: () => void;
	openTerminal: (s: CodingSession) => void;
	startSession: (repoId: string) => void;
	setSettingsRepoId: (id: string) => void;
	repoLabel: (r: CodingRepo) => string;
	getActiveSession: (repoId: string) => CodingSession | undefined;
	onWorkOnIssue: (repo: CodingRepo, issue: { number: number; title: string }) => void;
	onOpenEngines: () => void;
}) {
	// Overview play button (#124): speak a repo's last co-pilot (assistant) message with the
	// instance's TTS voice — without opening the session. Single-flight: only ONE repo plays at
	// a time (a new play or a second click on the same repo stops the current one).
	const ttsRef = useRef<VoiceTts | null>(null);
	const playGenRef = useRef(0);
	const [audio, setAudio] = useState<{ id: string; phase: "loading" | "playing" } | null>(null);
	useEffect(() => () => { ttsRef.current?.cancel(); }, []); // stop on unmount

	// Prefer the live session; fall back to any (e.g. ended) session for the repo.
	const sessionFor = (repoId: string) => getActiveSession(repoId) || sessions.find((s) => s.repoId === repoId);

	const togglePlay = async (repo: CodingRepo) => {
		if (audio?.id === repo.id) { ttsRef.current?.cancel(); setAudio(null); return; } // same button → stop
		const session = sessionFor(repo.id);
		if (!session) return;
		const myGen = ++playGenRef.current; // supersede any in-flight/playing repo
		ttsRef.current?.cancel();
		setAudio({ id: repo.id, phase: "loading" });
		let text = "";
		try {
			const d = await api<{ chat?: TimelineEntry[]; timeline?: TimelineEntry[] }>(`/v1/instances/${instanceId}/coding/sessions/${session.id}/timeline`);
			const msgs = (d.chat || d.timeline || []).filter((e) => e.type === "chat_assistant");
			const last = msgs[msgs.length - 1];
			text = (last?.content || last?.text || "").trim();
		} catch {}
		if (playGenRef.current !== myGen) return; // another repo took over during the fetch
		if (!text) { setAudio(null); return; } // no assistant message yet — nothing to play
		setAudio({ id: repo.id, phase: "playing" });
		try {
			const tts = ttsRef.current ?? (ttsRef.current = await createTts(instanceId));
			if (playGenRef.current !== myGen) return;
			await tts.unlock(); // iOS: prime inside the click gesture
			await tts.speak(text); // resolves when playback ends
		} catch {}
		if (playGenRef.current === myGen) setAudio(null); // finished/failed (not superseded)
	};

	const activeCount = sessions.filter((s) => s.status === "active").length;
	return (
		<div className="px-2 py-2 sm:px-4 sm:py-3 overflow-auto flex-1">
			{/* Repos section */}
			<div className="bg-panel border border-line rounded-xl p-3">
				<div className="flex justify-between items-center gap-2">
					<span className="text-ink font-bold text-[0.95rem]">{singleRepo ? "Repository" : "Repositories"}</span>
					<div className="flex gap-1.5">
						<button type="button" onClick={onOpenEngines} title="CLI engines & sign-in" className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted font-semibold flex items-center gap-1"><Cpu size={13} /><span className="hidden sm:inline">Engines</span></button>
						{/* A one-repo agent cannot use this — its repo comes from its settings. */}
						{!singleRepo && (
							<button type="button" onClick={() => setShowAddRepo(!showAddRepo)} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted font-semibold">+ Add</button>
						)}
					</div>
				</div>

				{/* Activity strip */}
				{activeCount > 0 && (
					<div className="text-xs text-muted mt-1.5">
						{activeCount} active session{activeCount !== 1 ? "s" : ""}
					</div>
				)}

				{/* Add repo form */}
				{showAddRepo && !singleRepo && (
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
											{(() => {
												const phase = audio?.id === r.id ? audio.phase : null;
												return (
													<button
														type="button"
														onClick={() => togglePlay(r)}
														disabled={!sessionFor(r.id)}
														title={phase === "playing" ? "Stop" : phase === "loading" ? "Loading…" : "Play last message"}
														aria-label={phase === "playing" ? "Stop playback" : "Play last message"}
														className={`text-xs px-1.5 py-1 rounded-md border text-muted disabled:opacity-40 ${phase ? "border-accent text-accent" : "border-line hover:border-accent hover:text-accent"}`}
													>
														{phase === "loading" ? <Loader2 size={14} className="animate-spin" /> : phase === "playing" ? <Square size={14} /> : <Play size={14} />}
													</button>
												);
											})()}
											<button type="button" onClick={() => setSettingsRepoId(r.id)} title="Repo settings" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent"><Settings size={14} /></button>
										</div>
									</div>
									{r.githubRepo && <RepoIssues instanceId={instanceId} repo={r} onWorkOnIssue={onWorkOnIssue} />}
								</div>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
