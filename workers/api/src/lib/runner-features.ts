/**
 * Which server features a runner of a given version can serve (#859) — one table, read by every
 * surface that reports a machine's version.
 *
 * Each feature's minimum lives beside the code that needs it (`*_MIN_CLI`); this collects them so
 * `list_runner_nodes` and `instance_runner_node` can say, per machine, what it is too old for — and
 * so an operator knows `runner_update` is worth running before a call fails for it.
 */
import { TURN_REPORT_MIN_CLI } from "./coding-turn-outcome.js";
import { REPO_SEARCH_MIN_CLI } from "./connectors/repo-local.js";
import { RESULT_LINES_MIN_CLI, TOOL_OUTCOME_MIN_CLI } from "./engine-tool-calls.js";
import { MACHINE_ID_MIN_CLI } from "./machine-identity.js";
import { SWITCH_BRANCH_MIN_CLI } from "./repo-policy-act.js";
import { REPO_SYNC_MIN_CLI } from "./repo-sync.js";
import { FAST_FORWARD_MIN_CLI } from "./repo-sync-gate.js";
import { cliAtLeast } from "./runner-upgrade.js";

/**
 * The runner's own control commands, answered by the CLI over the relay: the membership sync behind
 * repin attach and `force_runner_attach` (#850, #856), background clones for `coding_repo_add … clone`
 * (#857, #858), and `runner_update` itself (#859). All first published in this release.
 */
export const RUNNER_CONTROL_MIN_CLI = "0.4.62";
/** The self-updating bootstrap stub (#862): from here on `pags up` moves onto the latest release by itself. */
export const BOOTSTRAP_MIN_CLI = "0.4.63";
/** `runner_update` restarts the `pags up` supervisor too, and runners under launchd/systemd or a restart command (#860). */
export const SUPERVISOR_RESTART_MIN_CLI = "0.4.64";

export interface RunnerFeature {
	feature: string;
	minCli: string;
}

export const RUNNER_FEATURES: readonly RunnerFeature[] = [
	{ feature: "runner_update restarts pags up itself, and service-managed runners", minCli: SUPERVISOR_RESTART_MIN_CLI },
	{ feature: "self-updating pags up (never needs a manual install again)", minCli: BOOTSTRAP_MIN_CLI },
	{ feature: "runner_update (remote CLI update + restart)", minCli: RUNNER_CONTROL_MIN_CLI },
	{ feature: "coding_repo_add clone (background, https or SSH)", minCli: RUNNER_CONTROL_MIN_CLI },
	{ feature: "force_runner_attach / repin attach", minCli: RUNNER_CONTROL_MIN_CLI },
	{ feature: "fast-forward a stale checkout", minCli: FAST_FORWARD_MIN_CLI },
	{ feature: "upstream sync check", minCli: REPO_SYNC_MIN_CLI },
	{ feature: "full tool-result lines", minCli: RESULT_LINES_MIN_CLI },
	{ feature: "tool call outcomes", minCli: TOOL_OUTCOME_MIN_CLI },
	{ feature: "engine turn reports", minCli: TURN_REPORT_MIN_CLI },
	{ feature: "repo_search", minCli: REPO_SEARCH_MIN_CLI },
	{ feature: "switch a checkout back to its branch", minCli: SWITCH_BRANCH_MIN_CLI },
	{ feature: "machine identity across renames", minCli: MACHINE_ID_MIN_CLI },
];

/**
 * The features this version is too old for, newest requirement first — `[]` when it serves them all,
 * and `null` when there is no version to judge (never registered, or a runner that did not say).
 */
export function runnerFeatureGaps(version: string | null | undefined): RunnerFeature[] | null {
	if (!version?.trim()) return null;
	return RUNNER_FEATURES.filter((f) => !cliAtLeast(version, f.minCli));
}

/** A machine's version and what it is behind on, as the node listings report it. */
export function runnerVersionView(version: string | null | undefined): { runnerVersion: string | null; behind: string[] | null } {
	const gaps = runnerFeatureGaps(version);
	return { runnerVersion: version?.trim() || null, behind: gaps?.map((g) => `${g.feature} (needs ${g.minCli})`) ?? null };
}
