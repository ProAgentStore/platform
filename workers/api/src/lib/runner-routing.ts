/**
 * Where a repository's GitHub Actions jobs run (#1113, slice 1): GitHub-hosted by default, the PINNED
 * machine's self-hosted runner only as a fallback when Actions minutes are exhausted or nearly so.
 *
 * Pure decisions only. Nothing here registers a runner, mints a registration token, or writes the
 * `PAGS_RUNNER` repository variable. Those need new GitHub App permissions and a runner installer on
 * the owner's machines, both still pending (docs/runner-self-hosted-design.md). What this fixes in
 * place are the rules the live loop must obey:
 *
 *   - **Pin-scoped, never generic.** A self-hosted route names exactly ONE machine — the one the Coder
 *     is pinned to — by its unique label `pags-<node>`. A label set of only `self-hosted` / `pags`
 *     would let every registered runner pick the job up, which is the mutual-exclusion breach #1113
 *     forbids; {@link isPinScoped} is the check, and {@link selectRunnerLabel} never returns anything else.
 *   - **Private repos only.** A public repo never routes to an owner's machine (a fork PR would run its
 *     code there); {@link assertPrivateRepo} is the guard the runner-group writer must call.
 *   - **No pin, no self-hosted.** Unpinned means GitHub-hosted, whatever the minutes say.
 *
 * The value is the JSON workflows read with `runs-on: ${{ fromJSON(vars.PAGS_RUNNER || '"ubuntu-latest"') }}`.
 */
import type { StartFailure } from "./github-actions.js";

/** The repository (or org) Actions variable workflows route on. */
export const PAGS_RUNNER_VARIABLE = "PAGS_RUNNER";
/** GitHub-hosted: the default for every job. */
export const GITHUB_HOSTED_LABEL = "ubuntu-latest";
/** Every pags runner also carries this label; it is never enough on its own to route a job. */
export const PAGS_RUNNER_LABEL = "pags";
/** "Low" minutes: at or above this share of the included minutes, route to self-hosted (#1113: e.g. 90%). */
export const DEFAULT_LOW_MINUTES_PERCENT = 90;

export type RunnerRoutingMode = "github-hosted" | "self-hosted";
export type RepoVisibility = "private" | "public" | "internal";

/** What is known about an org's Actions minutes. Absent fields are unknown, never "fine". */
export interface MinutesState {
	/** The org cannot start GitHub-hosted jobs (minutes used up, or the spending limit reached). */
	exhausted?: boolean;
	/** Share of the included minutes used this cycle, 0–100. */
	usedPercent?: number | null;
}

export type RoutingReason = "default" | "not_private" | "not_pinned" | "minutes_exhausted" | "minutes_low" | "run_not_started_for_billing";

export interface RunnerDirective {
	mode: RunnerRoutingMode;
	/** The `runs-on` label set. Self-hosted: exactly `["self-hosted", "pags-<node>"]`. */
	labels: string[];
	/** What `PAGS_RUNNER` is set to — JSON, as the workflow reads it with fromJSON. */
	variableValue: string;
	reason: RoutingReason;
}

export class PublicRepoError extends Error {
	constructor(readonly visibility: string) {
		super(`Only private repositories may use a self-hosted pags runner; this one is ${visibility || "of unknown visibility"}. A public repo's fork pull requests could run code on the owner's machine.`);
		this.name = "PublicRepoError";
	}
}

/** Throws unless the repo is private — the guard every runner-group add must pass, and re-check periodically. */
export function assertPrivateRepo(visibility: unknown): asserts visibility is "private" {
	if (visibility !== "private") throw new PublicRepoError(typeof visibility === "string" ? visibility : "");
}

/**
 * The pinned machine's unique label: `pags-` + a slug of its canonical runner-node name
 * (`normalizeRunnerNode`), lower-case `[a-z0-9-]`, so `Sergeys-Mac-mini.local` → `pags-sergeys-mac-mini-local`.
 * Throws for an empty name: a runner with no unique label cannot be routed to safely.
 */
export function nodeRunnerLabel(node: string): string {
	const slug = node
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) throw new Error("A self-hosted route needs the pinned machine's canonical node name; none was given.");
	const label = `${PAGS_RUNNER_LABEL}-${slug}`;
	// Refused rather than cut: two long names cut to the same prefix would share a label (GitHub caps labels at 100).
	if (label.length > 100) throw new Error("The pinned machine's node name is too long to be a runner label (100 characters).");
	return label;
}

/** Does this label set name exactly one machine? Generic labels alone (`self-hosted`, `pags`) never do. */
export function isPinScoped(labels: readonly string[]): boolean {
	const specific = labels.filter((l) => l.startsWith(`${PAGS_RUNNER_LABEL}-`));
	return specific.length === 1 && labels.every((l) => l === "self-hosted" || l === PAGS_RUNNER_LABEL || l === specific[0]);
}

/** Two machines whose names slug to the same label would share a route — say which, so neither is used. */
export function labelCollisions(nodes: readonly string[]): Array<{ label: string; nodes: string[] }> {
	const by = new Map<string, string[]>();
	for (const n of nodes) {
		try {
			const label = nodeRunnerLabel(n);
			by.set(label, [...(by.get(label) ?? []), n]);
		} catch {
			// An empty name has no label to collide on.
		}
	}
	return [...by.entries()].filter(([, ns]) => new Set(ns).size > 1).map(([label, ns]) => ({ label, nodes: [...new Set(ns)] }));
}

/** Is this run's start failure the billing block #1112 classifies — the one signal that justifies self-hosted? */
export function shouldFallbackToSelfHosted(failureReason: Pick<StartFailure, "classification"> | null | undefined): boolean {
	return failureReason?.classification === "minutes_exhausted";
}

const hosted = (reason: RoutingReason): RunnerDirective => ({ mode: "github-hosted", labels: [GITHUB_HOSTED_LABEL], variableValue: JSON.stringify(GITHUB_HOSTED_LABEL), reason });

/**
 * Route one repo. GitHub-hosted unless ALL of: the repo is private, the Coder is pinned to a machine,
 * and minutes are exhausted, at/above the low threshold, or a run just failed to start for billing
 * (#1112 `minutes_exhausted`). Then exactly the pinned machine's label set — never a generic one.
 * Minutes that read as fine again route back to GitHub-hosted: the decision has no memory.
 */
export function selectRunnerLabel(input: {
	visibility: RepoVisibility | string;
	pinnedNode: string | null | undefined;
	minutes?: MinutesState;
	failureReason?: Pick<StartFailure, "classification"> | null;
	lowMinutesPercent?: number;
}): RunnerDirective {
	if (input.visibility !== "private") return hosted("not_private");
	const node = (input.pinnedNode ?? "").trim();
	if (!node) return hosted("not_pinned");
	const minutes = input.minutes ?? {};
	const low = input.lowMinutesPercent ?? DEFAULT_LOW_MINUTES_PERCENT;
	const reason: RoutingReason | null = minutes.exhausted
		? "minutes_exhausted"
		: typeof minutes.usedPercent === "number" && minutes.usedPercent >= low
			? "minutes_low"
			: shouldFallbackToSelfHosted(input.failureReason)
				? "run_not_started_for_billing"
				: null;
	if (!reason) return hosted("default");
	const labels = ["self-hosted", nodeRunnerLabel(node)];
	return { mode: "self-hosted", labels, variableValue: JSON.stringify(labels), reason };
}

/** The directive for one workflow run's repo — {@link selectRunnerLabel} with the repo named for the caller. */
export function getWorkflowRunnerDirective(
	repo: { fullName: string; visibility: RepoVisibility | string },
	pinnedNode: string | null | undefined,
	opts: { minutes?: MinutesState; failureReason?: Pick<StartFailure, "classification"> | null; lowMinutesPercent?: number } = {},
): RunnerDirective & { repo: string; variable: typeof PAGS_RUNNER_VARIABLE } {
	return { repo: repo.fullName, variable: PAGS_RUNNER_VARIABLE, ...selectRunnerLabel({ visibility: repo.visibility, pinnedNode, ...opts }) };
}
