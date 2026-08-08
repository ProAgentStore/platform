import { useState, useRef, useEffect } from "react";
import { api } from "@proagentstore/sdk/client";
import { createTts, type VoiceTts } from "@proagentstore/sdk/hooks";
import type { CodingRepo, CodingSession } from "./types";
import { Settings, Cpu, Play, Square, Loader2, RefreshCw } from "lucide-react";
import AddRepoForm from "./AddRepoForm";
import RepoIssues from "./RepoIssues";
import PullsPanel from "./PullsPanel";
import { repoProviderBadge, repoTitle } from "./repo-title";
import { isEngineBusy } from "./engine-busy";
import { repoOpenAction } from "./repo-open";
import { repoFreshnessLabel, staleListNotice, type RecheckReport } from "./repo-freshness";

type TimelineEntry = { type?: string; content?: string; text?: string };

/**
 * The MULTI-repo landing: add-repo, runner CTA, one row per repo.
 *
 * A single-repo agent no longer arrives here at all — CodingTab gives it Terminal / Issues /
 * Builds directly, because a list exists so you can CHOOSE and it has nothing to choose between.
 * `singleRepo` survives only for the misconfiguration case (declared single, two rows in data),
 * where the list is the honest fallback but add-repo still must not appear.
 */
export default function ReposList({
	instanceId,
	repos, sessions, repoStatuses, runnerOnline, recheck, onRepoRechecked,
	singleRepo = false, showAddRepo, setShowAddRepo, addRepoInput, setAddRepoInput, addRepo,
	openRepo, openingRepoId, setSettingsRepoId,
	repoLabel, getActiveSession, onWorkOnIssue, onOpenEngines,
}: {
	instanceId: string;
	repos: CodingRepo[];
	sessions: CodingSession[];
	repoStatuses: Record<string, string>;
	runnerOnline: boolean | null;
	/** What the last `GET …/coding/repos` managed to re-check, and why not when it did not (#440). */
	recheck?: RecheckReport;
	/** A single repo's row after an on-demand re-check, so the card updates without a full reload. */
	onRepoRechecked?: (repo: CodingRepo) => void;
	/** One-repo agent: hide add-repo and the "Repositories" header row. */
	singleRepo?: boolean;
	showAddRepo: boolean;
	setShowAddRepo: (v: boolean) => void;
	addRepoInput: string;
	setAddRepoInput: (v: string) => void;
	addRepo: () => void;
	/**
	 * Open this repo — ensuring a session if there isn't a live one (#408). ONE action, because
	 * "does this repo currently have a session" is a cache question the platform answers better
	 * than the user does; see ./repo-open.
	 */
	openRepo: (repoId: string) => void;
	/** The repo whose engine is being started right now, so the row can say so instead of hanging. */
	openingRepoId: string | null;
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
			let tts = ttsRef.current;
			if (!tts) {
				tts = await createTts(instanceId);
				ttsRef.current = tts;
			}
			if (playGenRef.current !== myGen) return;
			await tts.unlock(); // iOS: prime inside the click gesture
			await tts.speak(text); // resolves when playback ends
		} catch {}
		if (playGenRef.current === myGen) setAudio(null); // finished/failed (not superseded)
	};

	// On-demand re-check (#440). The escape hatch from a verdict that is wrong or simply old: the
	// list's own re-check only runs when a runner connection resolves at that instant, which for a
	// pinned agent whose machine is elsewhere is never — and it said nothing when it did not.
	const [rechecking, setRechecking] = useState<string | null>(null);
	const [verdicts, setVerdicts] = useState<Record<string, string>>({});
	const recheckRepo = async (repoId: string) => {
		setRechecking(repoId);
		try {
			const d = await api<{ repo?: CodingRepo; checked?: boolean; verdict?: { detail?: string }; reason?: string }>(
				`/v1/instances/${instanceId}/coding/repos/${repoId}/recheck`,
				{ method: "POST" },
			);
			if (d.repo) onRepoRechecked?.(d.repo);
			// The server's own sentence, never a locally composed one — the same wording the agent
			// is given to relay, so the console and the chat cannot describe one directory two ways.
			setVerdicts((v) => ({ ...v, [repoId]: d.checked ? d.verdict?.detail || "Checked — the checkout is there." : d.reason || d.verdict?.detail || "Nobody could look at this path." }));
		} catch {
			setVerdicts((v) => ({ ...v, [repoId]: "The re-check could not be sent. Try again in a moment." }));
		} finally {
			setRechecking(null);
		}
	};

	/** One repo, rendered identically whether it is alone or a row in the list. */
	const RepoCard = ({ r, bare }: { r: CodingRepo; bare?: boolean }) => {
		const active = getActiveSession(r.id);
		const status = repoStatuses[r.id];
		const phase = audio?.id === r.id ? audio.phase : null;
		// The machine looked at this local path and it is not usable (#405). The remedy sits
		// BESIDE the repo, the way #378 put the offline runner's remedy beside the terminal —
		// a row that reads "Ready" over an empty directory is how an agent ends up inventing
		// the code it cannot see.
		const unusable = r.cloneStatus === "needs_attention";
		return (
			<div className={bare ? "" : "bg-paper border border-line rounded-lg p-3"}>
				<div className="flex justify-between items-center gap-3">
					<div className="min-w-0">
						<div className="font-semibold text-sm truncate flex items-center gap-1.5">
							{/* ONE identity rule: the hosted coordinate when there is one, else the folder
							    name — see repo-title.ts. The badge names the HOST (#221): it used to say
							    `local` for anything without a githubRepo, so a working GitLab repo was
							    labelled as having no remote at all. */}
							{repoTitle(r)}
							{repoProviderBadge(r) && (
								<span className="text-2xs px-1 py-0.5 bg-line/60 text-muted rounded font-bold shrink-0">{repoProviderBadge(r)}</span>
							)}
						</div>
						<div className="text-xs text-muted mt-0.5 flex items-center gap-1.5">
							{isEngineBusy(status) ? (
								<span className="inline-block w-2.5 h-2.5 border-2 border-line border-t-amber-500 rounded-full animate-spin" />
							) : (
								<span className={`w-2 h-2 rounded-full ${unusable ? "bg-red" : active && status !== "offline" ? "bg-green" : "bg-muted"}`} />
							)}
							{repoLabel(r)}
							{r.instructions && <span className="text-2xs px-1 py-0.5 bg-accent-soft text-accent rounded font-bold">Rules</span>}
						</div>
					</div>
					<div className="flex gap-1.5 shrink-0 items-center">
						{(() => {
							const a = repoOpenAction({ hasActiveSession: !!active, opening: openingRepoId === r.id, runnerOnline });
							return (
								// No aria-label: the visible word IS the accessible name, and overriding it with
								// "Open <repo>" would make the control unaddressable by the name a user (or a
								// test) reads off the screen — the row already announces which repo it is.
								<button type="button" onClick={() => openRepo(r.id)} disabled={a.disabled} title={a.title}
									className="text-xs px-2.5 py-1 rounded-md bg-accent text-white font-bold disabled:opacity-60">
									{a.label}
								</button>
							);
						})()}
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
						<button type="button" onClick={() => setSettingsRepoId(r.id)} title="Repo settings" className="text-xs px-1.5 py-1 rounded-md border border-line text-muted hover:border-accent hover:text-accent"><Settings size={14} /></button>
					</div>
				</div>
				{unusable && (
					<div data-testid={`repo-unusable-${r.id}`} className="mt-2 bg-red/10 border border-red/40 text-red rounded-lg p-2 text-xs">
						{/* The server's own sentence — it names the path and the condition, and it is the
						    same one the agent is given to relay, so the console and the chat cannot say
						    two different things about one directory. `break-words` because a checkout
						    path is long and this card is 320px wide on a phone. */}
						<p className="break-words">{r.cloneError || "This path could not be used on your machine."}</p>
						<p className="mt-1 text-muted break-words">
							Point it at the real checkout (⚙ Repo settings) or remove it. The agent cannot read code that isn't there.
						</p>
					</div>
				)}
				{/* HOW OLD the verdict above is, and the way to replace it (#440). Only for a repo
				    that has a folder on a machine — a cloned repo has no checkout to look at.
				    `flex-wrap` because "never checked" plus the button is wider than a 320px card. */}
				{r.workdir && (
					<div className="mt-1.5 flex items-center gap-2 flex-wrap text-2xs text-muted-soft">
						<span>{repoFreshnessLabel(r)}</span>
						<button
							type="button"
							onClick={() => recheckRepo(r.id)}
							disabled={rechecking === r.id}
							title="Ask the machine to look at this folder now"
							// Deliberately NOT a boxed button: this sits inside a 2xs metadata line
							// beside "checked 4 min ago", where a bordered pill would outweigh the
							// fact it qualifies — and `agents/coder/web` has no shared <Button> yet,
							// so drawing one here would add a fifteenth shape to a tree the
							// control-shapes ratchet is holding still until its turn (#366/#367).
							// The vertical padding IS the tap target: `text-2xs` gives a 12px line box, so
							// `py-1` measured 23.98px in WebKit — under WCAG 2.5.8's 24px minimum by a
							// sixteenth of a pixel, which is the kind of miss only a measurement finds.
							className="inline-flex items-center gap-1 px-1 py-1.5 text-muted hover:text-accent underline underline-offset-2 disabled:opacity-60"
						>
							<RefreshCw size={11} className={rechecking === r.id ? "animate-spin" : ""} />
							Re-check
						</button>
						{verdicts[r.id] && <span className="basis-full break-words text-muted">{verdicts[r.id]}</span>}
					</div>
				)}
				{r.githubRepo && <RepoIssues instanceId={instanceId} repo={r} onWorkOnIssue={onWorkOnIssue} />}
				{/* Pulls sits with Issues, collapsed (#401): nested in a repo card it is one of several
				    things, and an expanded PR list per repo would poll GitHub for every row on the page. */}
				{r.githubRepo && <PullsPanel instanceId={instanceId} repo={r} />}
			</div>
		);
	};

	// "The platform checked and it is broken" vs "nobody has looked since Monday" — one sentence,
	// and it is the difference between a diagnosis and a memory (#440). Distinct from the offline
	// CTA below: that one is about the machine, this one is about what the rows below are worth.
	const staleNotice = staleListNotice(recheck, repos.filter((r) => r.workdir).length);

	const offlineCta = runnerOnline === false && (
		<div className="bg-yellow/10 border border-yellow/40 text-yellow rounded-lg p-2.5 mt-3 text-sm">
			<b>Your machine isn't connected.</b> Start the runner:
			<code className="block mt-1.5 bg-paper border border-line text-ink rounded-md p-1.5 text-sm">pags up</code>
		</div>
	);

	const enginesButton = (
		<button type="button" onClick={onOpenEngines} title="CLI engines & sign-in" className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted font-semibold flex items-center gap-1">
			<Cpu size={13} /><span className="hidden sm:inline">Engines</span>
		</button>
	);

	/**
	 * A one-repo agent hides add-repo at ONE repo and must show it at ZERO (#411).
	 *
	 * Hiding it unconditionally was right about the steady state and wrong about the empty one: it
	 * used to be paired with a `repo` SETTING that seeded the row, and that setting is gone (it was
	 * read by nothing after the first save, which is the bug this ticket came from). Without this,
	 * a single-repo agent that deletes its repo has no way to add another — not in the repo list,
	 * not in settings, nowhere but the API by hand.
	 */
	const needsFirstRepo = singleRepo && repos.length === 0;
	return (
		<div className="px-2 py-2 sm:px-4 sm:py-3 overflow-auto flex-1">
			<div className="bg-panel border border-line rounded-xl p-3">
				<div className="flex justify-between items-center gap-2">
					<span className="text-ink font-bold text-base">{singleRepo ? "Repository" : "Repositories"}</span>
					<div className="flex gap-1.5">
						{enginesButton}
						{/* A one-repo agent that HAS its repo cannot use this — one is its maximum. */}
						{!singleRepo && (
							<button type="button" onClick={() => setShowAddRepo(!showAddRepo)} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted font-semibold">+ Add</button>
						)}
					</div>
				</div>

				{/* Open by default when there is no repo: with nothing else on the panel, a form the
				    user must first reveal with a button that is not there is not an affordance. */}
				{((showAddRepo && !singleRepo) || needsFirstRepo) && (
					<AddRepoForm className="mt-3" value={addRepoInput} onChange={setAddRepoInput} onAdd={addRepo} />
				)}

				{offlineCta}

				{staleNotice && (
					<p data-testid="repos-stale-notice" className="mt-3 text-xs text-muted break-words">
						{staleNotice}
					</p>
				)}

				<div className="flex flex-col gap-1.5 mt-3">
					{repos.length === 0 ? (
						// Was "add its path in Settings → Agent settings" — a sign pointing at a field
						// that no code read and that no longer exists (#411). The form above IS the
						// affordance now, for one repo and for many.
						<p className="text-center py-4 text-muted-soft text-sm">
							{singleRepo ? "No repository yet. Add one above." : "No repos yet. Add one above."}
						</p>
					) : (
						repos.map((r) => <RepoCard key={r.id} r={r} />)
					)}
				</div>
			</div>
		</div>
	);
}
