/**
 * One status per instance, for a whole fleet at once (#961). Pure: every fact is fetched by the
 * route (`routes/instances-fleet.ts`) and every judgement is made here, so each verdict below is
 * asserted directly.
 *
 * ── What "decision_blocked" can honestly mean today (#960)
 *
 * The investigation found that a coding run's `needs_input` pause records as `waitingReason: human`
 * — exactly like a hard block — and that no client can deliver an answer to it. So a parked coding
 * run is reported HARD-blocked here, because that is what it is in practice. The one pause that is
 * both recorded and answerable from a conversation is a remote MCP server's elicitation
 * (`mcp_input_requests`, answered with `answer_instance_mcp_input_request`), and that is the only
 * thing that made an instance decision_blocked until #960 gave the Pilot a real decision verb: a
 * coding run parked on `decision` (its `ask_owner` / `request_user_info`, answered with
 * answer_instance_input) is now the second input.
 */
import type { InstanceHealth } from "./instance-activity.js";
import type { IssueSummary } from "./github-issues.js";

export const FLEET_STATUSES = ["decision_blocked", "idle_needs_work", "hard_blocked", "working", "unknown", "idle"] as const;
export type FleetStatus = (typeof FLEET_STATUSES)[number];

/** Labels that mean "a person has to do this", so an agent picking it up would only stall on it. */
export function isNeedsHumanLabel(label: string): boolean {
	return /^(needs[- _]?human|human[- _]?only|blocked(\b|[- _:].*))$/i.test(label.trim());
}

/** A repo's open issues as the snapshot reports them. */
export interface IssueTally {
	repos: string[];
	/** Every repo bound could be read. False means the counts are a floor, not a total. */
	readable: boolean;
	unreadRepos: string[];
	open: number;
	/** At least one repo had more open issues than one page holds; `open` is then a floor. */
	openMore: boolean;
	actionable: number;
	needsHuman: number;
	/** A few actionable issues, so a caller can hand one over without another call. */
	next: Array<{ repo: string; number: number; title: string; url: string }>;
}

export interface RepoIssues {
	repo: string;
	issues: IssueSummary[];
	hasMore: boolean;
	unreadable: boolean;
}

export const NEXT_ISSUES = 3;

/** Fold the repos an instance is bound to into one tally. */
export function tallyIssues(repos: readonly RepoIssues[]): IssueTally {
	const t: IssueTally = { repos: repos.map((r) => r.repo), readable: true, unreadRepos: [], open: 0, openMore: false, actionable: 0, needsHuman: 0, next: [] };
	for (const r of repos) {
		if (r.unreadable) {
			t.readable = false;
			t.unreadRepos.push(r.repo);
			continue;
		}
		t.open += r.issues.length;
		t.openMore ||= r.hasMore;
		for (const i of r.issues) {
			if (i.labels.some(isNeedsHumanLabel)) t.needsHuman++;
			else {
				t.actionable++;
				if (t.next.length < NEXT_ISSUES) t.next.push({ repo: r.repo, number: i.number, title: i.title, url: i.url });
			}
		}
	}
	return t;
}

export interface FleetFacts {
	health: InstanceHealth;
	/** The open run's park reason (`RUN_WAIT_REASONS`), or null. */
	waitingReason: string | null;
	queueDepth: number;
	/** Pending, unexpired MCP elicitations — the answerable-in-chat asks. */
	decisions: number;
	/** The open run's question when it is parked on `decision` (#960), or null. */
	runQuestion?: { question: string; taskId: string } | null;
	/** Pending owner secure inputs — a secret to type into the console, not a conversation. */
	ownerSecrets: number;
	/** Null when the instance has no GitHub repo bound — there is no backlog to report. */
	issues: IssueTally | null;
}

/** Parks a person has to clear by hand: a session takeover, or a CLI sign-in on the machine. */
const HARD_PARKS = new Set(["human", "engine_auth"]);

/**
 * The verdict, and the sentence that justifies it. First match wins, in the order a reader should
 * act: a question waiting on them, then anything stuck, then work in flight, then the backlog.
 */
export function deriveFleetStatus(f: FleetFacts): { status: FleetStatus; reason: string } {
	if (f.health === "waiting" && f.waitingReason === "decision") {
		const q = f.runQuestion;
		return {
			status: "decision_blocked",
			reason: q
				? `The run is waiting for your answer: "${q.question}" — answer with answer_instance_input (task_id ${q.taskId}).`
				: "The run is waiting for your answer to a question — open its board card, or answer with answer_instance_input.",
		};
	}
	if (f.decisions > 0) {
		return { status: "decision_blocked", reason: `${f.decisions} question${f.decisions === 1 ? "" : "s"} waiting for your answer — answer with answer_instance_mcp_input_request.` };
	}
	if (f.health === "waiting" && f.waitingReason && HARD_PARKS.has(f.waitingReason)) {
		return {
			status: "hard_blocked",
			reason:
				f.waitingReason === "engine_auth"
					? "The run is paused until the coding CLI is signed in on its machine."
					: "The run is paused for a person to take over its session — this cannot be answered from chat (#960).",
		};
	}
	if (f.health === "stalled") return { status: "hard_blocked", reason: "The run is open but nothing has ticked — someone has to look at the machine." };
	if (f.ownerSecrets > 0) return { status: "hard_blocked", reason: `${f.ownerSecrets} secret value${f.ownerSecrets === 1 ? "" : "s"} waiting to be entered in the console.` };
	if (f.health === "working" || f.health === "waiting") return { status: "working", reason: f.health === "waiting" ? "The run is parked and resumes on its own." : "A run is in progress." };
	if (f.queueDepth > 0) return { status: "working", reason: `${f.queueDepth} objective${f.queueDepth === 1 ? "" : "s"} queued to start.` };
	const i = f.issues;
	if (!i) return { status: "idle", reason: "Idle, and no GitHub repository is bound — there is no backlog to read." };
	if (i.actionable > 0) return { status: "idle_needs_work", reason: `Idle with ${i.actionable}${i.openMore ? "+" : ""} open issue${i.actionable === 1 ? "" : "s"} it could take.` };
	if (!i.readable) return { status: "unknown", reason: `Idle, but the open issues of ${i.unreadRepos.join(", ")} could not be read, so whether there is work is unknown.` };
	if (i.needsHuman > 0) return { status: "hard_blocked", reason: `Idle; every open issue (${i.needsHuman}) is labelled for a person.` };
	return { status: "idle", reason: "Idle with no open issues." };
}

/** Most-needs-attention first, so a caller can stop reading once it reaches what it can skip. */
export function fleetOrder(a: FleetStatus, b: FleetStatus): number {
	return FLEET_STATUSES.indexOf(a) - FLEET_STATUSES.indexOf(b);
}
