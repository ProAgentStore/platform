import type { ReactNode } from "react";
import { CircleDot } from "lucide-react";
import Button from "./Button";
import { LANES, type LaneCard, groupByLane } from "../lib/boardLanes";

/** The board's Issues view (#895): one column per lane the API derived, backlog in priority order. */
export function BoardLanesView<T extends LaneCard>({ items, renderCard }: { items: readonly T[]; renderCard: (item: T) => ReactNode }) {
	const byLane = groupByLane(items);
	return (
		<div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3 items-start mb-4">
			{LANES.map((lane) => {
				const laneItems = byLane.get(lane.id) ?? [];
				return (
					<div key={lane.id} className="border border-line rounded-xl bg-panel/55 min-h-[120px]">
						<div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-line">
							<div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide">
								<span className="w-2.5 h-2.5 rounded-full" style={{ background: lane.color }} />
								{lane.title}
							</div>
							<span className="text-2xs text-muted border border-line rounded-full px-1.5 py-0.5 font-bold">{laneItems.length}</span>
						</div>
						<div className="flex flex-col gap-2 p-2.5">{laneItems.length === 0 ? <div className="text-center text-muted-soft text-sm py-4">None</div> : laneItems.map(renderCard)}</div>
					</div>
				);
			})}
		</div>
	);
}

/** The view toggle's third button — shown only on a board that has GitHub issues. */
export function IssuesViewButton({ active, onClick }: { active: boolean; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} title="GitHub issues by lane" aria-pressed={active} className={`flex items-center gap-1 px-2 py-1.5 text-xs font-bold ${active ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel-hover"}`}>
			<CircleDot size={13} />
			<span className="hidden sm:inline">Issues</span>
		</button>
	);
}

/** The repo filter (only for a board with more than one repo) and "Sync issues". */
export function IssueControls({ repos, repo, onRepo, onSync }: { repos: readonly string[]; repo: string; onRepo: (r: string) => void; onSync: () => void }) {
	return (
		<>
			{repos.length > 1 && (
				<select value={repo} onChange={(e) => onRepo(e.target.value)} aria-label="Filter by repository" className="text-xs bg-panel border border-line rounded-lg px-2 py-1.5 text-muted max-w-[12rem]">
					<option value="">All repos</option>
					{repos.map((r) => (
						<option key={r} value={r}>
							{r}
						</option>
					))}
				</select>
			)}
			<Button size="md" onClick={onSync} title="Bring the board up to date with GitHub's issues now">
				Sync issues
			</Button>
		</>
	);
}
