/**
 * The issue lanes of a coder's board (#895) — where a card stands, derived, never stored.
 *
 * A board column is an agent's own status vocabulary (`boardColumns`); a LANE is the platform's one
 * reading of a card that may be a GitHub issue: is it untouched backlog, waiting for a person by label,
 * queued, being worked, waiting on an answer, done (issue closed), or failed. It is computed from three
 * facts the board already holds — the issue's cached state and labels, the latest run linked to it, and
 * the card's status — so it cannot drift from them.
 *
 * Pure, and imports only pure helpers: the console and MCP describe the same lanes from the same table.
 */
import { severityFromLabels } from "./admin-github-issues.js";
import { isNeedsHumanLabel } from "./fleet-snapshot.js";

export const BOARD_LANES = ["backlog", "parked", "queued", "running", "waiting_on_human", "failed", "done"] as const;
export type BoardLane = (typeof BOARD_LANES)[number];

/** What each lane means, in the words the console and MCP show. */
export const LANE_TITLES: Record<BoardLane, string> = {
	backlog: "Backlog",
	parked: "Parked (needs a person)",
	queued: "Queued",
	running: "Running",
	waiting_on_human: "Waiting on you",
	failed: "Failed",
	done: "Done",
};

/** The issue, as the board's cache holds it. */
export interface LaneIssue {
	state: string;
	labels: readonly string[];
}

/** The newest run linked to the card's ticket, as `agent_loop_runs` holds it. */
export interface LaneRun {
	status: string;
	/** The park reason while `running` (`RUN_WAIT_REASONS`), or null. */
	waitingReason?: string | null;
}

/** Parks a PERSON clears: an answer (`decision`), a takeover (`human`), a CLI sign-in (`engine_auth`). */
const WAITING_ON_HUMAN = new Set(["decision", "human", "engine_auth"]);
const FAILED_STATUSES = new Set(["failed", "blocked", "expired", "rejected"]);
const DONE_STATUSES = new Set(["completed", "done", "succeeded", "submitted"]);
const QUEUED_STATUSES = new Set(["queued", "needs_approval", "pending"]);

/**
 * The lane, first match wins, in the order a reader should act:
 *
 *   1. done            — the issue is closed (whatever any run says: the work is over);
 *   2. waiting_on_human — the linked run is parked on a person, or the card says `needs_human`;
 *   3. running         — the linked run (or the card) is running. Live work is never hidden behind a
 *                        label: a run on a needs-person issue still shows where it is;
 *   4. parked          — the issue carries a needs-person label (`isNeedsHumanLabel`), so it is out of
 *                        the backlog and out of automatic pickup until a person takes it;
 *   5. failed          — the linked run ended failed/escalated, or the card failed;
 *   6. queued          — the card is queued / awaiting approval;
 *   7. backlog         — an open issue no run has touched;
 *   then the card's own status (done/failed) for a card that is not an issue, else null — a card in a
 *   column the lanes have no word for (e.g. `cancelled`, an apply pipeline stage) has no lane.
 */
export function laneFor(input: { issue?: LaneIssue | null; run?: LaneRun | null; status: string }): BoardLane | null {
	const { issue, run, status } = input;
	if (issue && issue.state === "closed") return "done";
	if (run?.status === "running" && run.waitingReason && WAITING_ON_HUMAN.has(run.waitingReason)) return "waiting_on_human";
	if (run?.status === "needs_human" || status === "needs_human") return "waiting_on_human";
	if (run?.status === "running" || status === "running") return "running";
	if (issue?.labels.some(isNeedsHumanLabel)) return "parked";
	if (run && FAILED_STATUSES.has(run.status)) return "failed";
	if (QUEUED_STATUSES.has(status)) return "queued";
	if (issue && !run) return "backlog";
	if (DONE_STATUSES.has(status) || run?.status === "completed") return "done";
	if (FAILED_STATUSES.has(status)) return "failed";
	return null;
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, none: 4 } as const;

/** 0 (most urgent) … 4 (unlabelled), read from P0/P1/…, `priority:high`, `severity/critical` labels. */
export function issuePriority(labels: readonly string[]): number {
	return SEVERITY_RANK[severityFromLabels([...labels])];
}

/** Backlog order: priority label first, then the oldest issue (lowest number). */
export function compareBacklog(a: { labels: readonly string[]; number: number }, b: { labels: readonly string[]; number: number }): number {
	return issuePriority(a.labels) - issuePriority(b.labels) || a.number - b.number;
}

/**
 * The card status an issue card shows when no runtime task carries one — so the agent's ordinary
 * columns (`columnForStatus`) still place it, and the ticket queue reads the same word.
 */
export function statusForIssueCard(lane: BoardLane | null, run: LaneRun | null): string {
	if (lane === "done") return "completed";
	if (lane === "waiting_on_human") return "needs_human";
	if (lane === "running") return "running";
	if (lane === "failed") return "failed";
	if (lane === "parked") return "blocked";
	// Backlog is `queued` too: the open issue is waiting to be worked, so it sits in the ordinary
	// Waiting column, and a ticket a person releases to the queue (#864) is one it can pick up.
	if (lane === "queued" || lane === "backlog") return "queued";
	return run?.status ?? "";
}
