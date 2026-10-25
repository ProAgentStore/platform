/**
 * What the owner sees of CI runners in machine status (#1113 follow-up 7, #1213): each runner's health, each repo's routing
 * mode, and the stuck-queued-job watcher's verdicts.
 *
 * Pure — it reads facts the callers fetched (GitHub's runner list, the org's minutes, the queued runs) and decides what they
 * mean. Nothing here talks to GitHub, so the same rules serve the status views today and the reconciliation loop when it runs
 * (#1211): a job stuck on a route is judged the same way wherever it is noticed.
 */
import { desiredRoute } from "./runner-reconcile.js";
import { GITHUB_HOSTED_LABEL, type MinutesState, nodeRunnerLabel, type RepoVisibility, RUNNER_UNAVAILABLE_LABEL, type RoutingReason, type RunnerRoutingMode } from "./runner-routing.js";
import type { StartFailure } from "./github-actions.js";

// ── Runner health ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One runner as GitHub reports it. */
export interface CiRunnerFacts {
	id: number;
	status: string;
	busy: boolean;
	labels: string[];
}

export interface CiRunnerHealth {
	/** GitHub has a runner of this name. False: nothing is installed for CI here, or it was removed. */
	registered: boolean;
	online: boolean;
	busy: boolean;
	labels: string[];
	/** Carries exactly this machine's own label, so a job routed to it reaches this machine and no other. */
	pinScoped: boolean;
	/** Online, idle-or-busy, pin-scoped, and not marked unavailable: jobs routed to the node's label can run here. */
	routable: boolean;
	/** One sentence for a person. */
	summary: string;
}

/** The health of the runner a machine registered, from what GitHub says about it. `facts` null = GitHub has none by that name. */
export function ciRunnerHealth(facts: CiRunnerFacts | null, node: string): CiRunnerHealth {
	if (!facts) return { registered: false, online: false, busy: false, labels: [], pinScoped: false, routable: false, summary: `No CI runner is registered for ${node}; its jobs run on GitHub-hosted runners.` };
	const online = facts.status === "online";
	const unavailable = facts.labels.includes(RUNNER_UNAVAILABLE_LABEL);
	// GitHub adds the OS and CPU labels and the machine its capability labels (has-*), so judge only the routing labels: exactly one
	// `pags-<node>` label, and it is this machine's own.
	const nodeLabels = facts.labels.filter((l) => l.startsWith("pags-") && l !== RUNNER_UNAVAILABLE_LABEL);
	const pinScoped = nodeLabels.length === 1 && nodeLabels[0] === safeNodeLabel(node);
	const routable = online && pinScoped && !unavailable;
	const summary = !online
		? `${node}'s CI runner is offline.`
		: unavailable
			? `${node}'s CI runner is online but marked unavailable (the machine reported it is not ready), so nothing is routed to it.`
			: !pinScoped
				? `${node}'s CI runner is online but does not carry exactly its own label, so jobs cannot be routed to it safely.`
				: facts.busy
					? `${node}'s CI runner is online and running a job.`
					: `${node}'s CI runner is online and idle.`;
	return { registered: true, online, busy: facts.busy, labels: facts.labels, pinScoped, routable, summary };
}

function safeNodeLabel(node: string): string {
	try {
		return nodeRunnerLabel(node);
	} catch {
		return "";
	}
}

// ── Routing mode ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RoutingModeView {
	mode: RunnerRoutingMode;
	reason: RoutingReason;
	labels: string[];
	/** Share of the included minutes used, or null when unknown. */
	usedPercent: number | null;
	/** Null = unknown, never "fine". */
	minutesExhausted: boolean | null;
	/** Set when the owner needs to act or know: the machine is offline, or jobs wait for it. */
	alert: string | null;
	summary: string;
}

/** Where one repo's jobs run now, and why — the routing decision plus the pinned machine's availability. */
export function routingModeView(input: {
	repo: string;
	visibility: RepoVisibility | string;
	pinnedNode: string | null;
	minutes?: MinutesState;
	failureReason?: Pick<StartFailure, "classification"> | null;
	onlineNodes: ReadonlySet<string>;
}): RoutingModeView {
	const { directive, alert } = desiredRoute({ repo: input.repo, visibility: input.visibility, pinnedNode: input.pinnedNode, minutes: input.minutes, failureReason: input.failureReason }, input.onlineNodes);
	const usedPercent = typeof input.minutes?.usedPercent === "number" ? input.minutes.usedPercent : null;
	const minutesExhausted = typeof input.minutes?.exhausted === "boolean" ? input.minutes.exhausted : null;
	const why: Record<RoutingReason, string> = {
		default: "GitHub-hosted is the default",
		not_private: "only private repositories may use a self-hosted runner",
		not_pinned: "no machine is pinned for this repo",
		minutes_exhausted: "the org's Actions minutes are used up",
		minutes_low: `the org has used ${usedPercent ?? "most of"}% of its Actions minutes`,
		run_not_started_for_billing: "a run did not start for billing reasons",
	};
	const where = directive.mode === "self-hosted" ? `the pinned machine's runner (${directive.labels.join(", ")})` : "GitHub-hosted runners";
	return { mode: directive.mode, reason: directive.reason, labels: directive.labels, usedPercent, minutesExhausted, alert: alert ?? null, summary: `${input.repo}'s jobs run on ${where}: ${why[directive.reason]}.` };
}

// ── The stuck-queued-job watcher ──────────────────────────────────────────────────────────────────────────────────────────

/** A queued workflow run (or job) and the labels it asked for. */
export interface QueuedJob {
	repo: string;
	runId: number;
	labels: readonly string[];
	/** When it was queued, ISO. */
	queuedAt: string;
}

export type StuckVerdict =
	| { kind: "reroute"; job: QueuedJob; ageMinutes: number; reason: string }
	| { kind: "alert"; job: QueuedJob; ageMinutes: number; reason: string };

/** A job queued longer than this is stuck (#1113: "N minutes"); every workflow also sets its own `timeout-minutes`. */
export const DEFAULT_STUCK_QUEUE_MINUTES = 15;

/**
 * Which queued jobs are stuck, and what to do about each — never silent, never a guess:
 *   • queued on a self-hosted label whose machine is offline, with GitHub-hosted minutes left → **reroute** (cancel and re-dispatch
 *     on GitHub-hosted);
 *   • the same with no minutes left → **alert**: there is nowhere else to run it;
 *   • queued on a self-hosted label whose machine is online → **alert**: the machine is busy or not picking it up;
 *   • queued on GitHub-hosted → **alert**: GitHub is not starting it (usually billing, see #1112).
 * A job younger than the threshold is not stuck. A job with an unreadable time is not judged.
 */
export function stuckQueuedJobs(input: {
	jobs: readonly QueuedJob[];
	now: Date;
	thresholdMinutes?: number;
	onlineNodes: ReadonlySet<string>;
	/** Each machine's canonical node name by the label its runner carries. */
	nodeByLabel: Readonly<Record<string, string>>;
	/** Per repo: does its org still have GitHub-hosted minutes? Unknown counts as "none remain": the cautious reading is to alert. */
	minutesRemain: (repo: string) => boolean | null;
}): StuckVerdict[] {
	const threshold = input.thresholdMinutes ?? DEFAULT_STUCK_QUEUE_MINUTES;
	const out: StuckVerdict[] = [];
	for (const job of input.jobs) {
		const queued = Date.parse(job.queuedAt);
		if (Number.isNaN(queued)) continue;
		const ageMinutes = Math.floor((input.now.getTime() - queued) / 60_000);
		if (ageMinutes < threshold) continue;
		const nodeLabel = job.labels.find((l) => l.startsWith("pags-") && l !== "pags-unavailable");
		if (!job.labels.includes("self-hosted") || !nodeLabel) {
			out.push({ kind: "alert", job, ageMinutes, reason: `${job.repo} run ${job.runId} has waited ${ageMinutes} minutes for ${job.labels.join(", ") || GITHUB_HOSTED_LABEL}; GitHub is not starting it (check the org's Actions minutes and spending limit).` });
			continue;
		}
		const node = input.nodeByLabel[nodeLabel];
		if (node && input.onlineNodes.has(node)) {
			out.push({ kind: "alert", job, ageMinutes, reason: `${job.repo} run ${job.runId} has waited ${ageMinutes} minutes for ${node}, which is online: it is busy with another job or not picking this one up.` });
		} else if (input.minutesRemain(job.repo) === true) {
			out.push({ kind: "reroute", job, ageMinutes, reason: `${job.repo} run ${job.runId} has waited ${ageMinutes} minutes for ${node ?? nodeLabel}, which is offline; GitHub-hosted minutes remain, so it is re-dispatched there.` });
		} else {
			out.push({ kind: "alert", job, ageMinutes, reason: `${job.repo} run ${job.runId} has waited ${ageMinutes} minutes for ${node ?? nodeLabel}, which is offline, and no GitHub-hosted minutes are known to remain. Bring the machine back (\`pags up\`) or raise the spending limit.` });
		}
	}
	return out;
}
