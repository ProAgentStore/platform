import type { CodingRepo, CodingSession } from "./types";
import { Trash2, Settings } from "lucide-react";
import RepoIssues from "./RepoIssues";

/** The all-repos landing view: add-repo form, runner CTA, and one row per repo. */
export default function ReposList({
	instanceId,
	repos, sessions, repoStatuses, runnerOnline,
	showAddRepo, setShowAddRepo, addRepoInput, setAddRepoInput, addRepo,
	openTerminal, startSession, deleteRepo, setSettingsRepoId,
	repoLabel, getActiveSession, onWorkOnIssue,
}: {
	instanceId: string;
	repos: CodingRepo[];
	sessions: CodingSession[];
	repoStatuses: Record<string, string>;
	runnerOnline: boolean | null;
	showAddRepo: boolean;
	setShowAddRepo: (v: boolean) => void;
	addRepoInput: string;
	setAddRepoInput: (v: string) => void;
	addRepo: () => void;
	openTerminal: (s: CodingSession) => void;
	startSession: (repoId: string) => void;
	deleteRepo: (repoId: string) => void;
	setSettingsRepoId: (id: string) => void;
	repoLabel: (r: CodingRepo) => string;
	getActiveSession: (repoId: string) => CodingSession | undefined;
	onWorkOnIssue: (repo: CodingRepo, issue: { number: number; title: string }) => void;
}) {
	const activeCount = sessions.filter((s) => s.status === "active").length;
	return (
		<div className="px-2 py-2 sm:px-4 sm:py-3 overflow-auto flex-1">
			{/* Repos section */}
			<div className="bg-panel border border-line rounded-xl p-3">
				<div className="flex justify-between items-center gap-2">
					<span className="text-ink font-bold text-[0.95rem]">Repositories</span>
					<button type="button" onClick={() => setShowAddRepo(!showAddRepo)} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted font-semibold">+ Add</button>
				</div>

				{/* Activity strip */}
				{activeCount > 0 && (
					<div className="text-xs text-muted mt-1.5">
						{activeCount} active session{activeCount !== 1 ? "s" : ""}
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
