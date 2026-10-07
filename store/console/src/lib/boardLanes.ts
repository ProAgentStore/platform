/**
 * The issue lanes of a coder's board (#895), as the console shows them. The API derives each card's
 * `lane` (`workers/api/src/lib/board-lanes.ts`, the one rule); this only orders and labels them.
 */
export const LANES = [
	{ id: "backlog", title: "Backlog", color: "#a3a3a3" },
	{ id: "parked", title: "Parked — needs a person", color: "#f97316" },
	{ id: "queued", title: "Queued", color: "#eab308" },
	{ id: "running", title: "Running", color: "#3b82f6" },
	{ id: "waiting_on_human", title: "Waiting on you", color: "#f59e0b" },
	{ id: "failed", title: "Failed", color: "#ef4444" },
	{ id: "done", title: "Done", color: "#22c55e" },
] as const;

export type LaneId = (typeof LANES)[number]["id"];

/** The fields a lane view reads off a board card. */
export interface LaneCard {
	jobKey: string;
	lane?: string | null;
	priority?: number;
	githubIssue?: { number: number; repo?: string };
	updatedAt: string;
}

/**
 * Cards grouped by lane. The backlog is ordered as the issue asks — most urgent label first, then the
 * oldest issue; every other lane newest first. A card with no lane is not an issue-lane card and is left out.
 */
export function groupByLane<T extends LaneCard>(cards: readonly T[]): Map<LaneId, T[]> {
	const out = new Map<LaneId, T[]>(LANES.map((l) => [l.id, []]));
	for (const c of cards) {
		const lane = out.get(c.lane as LaneId);
		if (lane) lane.push(c);
	}
	const backlog = out.get("backlog") ?? [];
	backlog.sort((a, b) => (a.priority ?? 4) - (b.priority ?? 4) || (a.githubIssue?.number ?? 0) - (b.githubIssue?.number ?? 0));
	for (const [id, list] of out) if (id !== "backlog") list.sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
	return out;
}

/** The repos a board's issue cards belong to — the repo filter's choices. */
export function issueRepos(cards: readonly LaneCard[]): string[] {
	return [...new Set(cards.map((c) => c.githubIssue?.repo).filter((r): r is string => !!r))].sort();
}

/** An issue named by meaning, not by number alone: "app#12 Slow startup". */
export function issueLabel(issue: { number: number; title: string; repo?: string }): string {
	const repo = issue.repo ? issue.repo.split("/").pop() : "";
	return `${repo}#${issue.number} ${issue.title}`.trim();
}

/** `POST /v1/instances/:id/board/issues/sync` (#895): what each GitHub-bound repo's sync did. */
export interface BoardIssueSyncResult {
	repos: Array<{ repoId: string; githubRepo: string; unreadable: boolean; created: number; updated: number; seen: number }>;
}
