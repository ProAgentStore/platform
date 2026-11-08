import { compareVersions, readRunner, type RunnerNodeRead } from "./releaseGate";
import type { Machine } from "./runnerPanel";

export interface CliWarning {
	/** `Runner 0.4.215 is older than 0.4.230` or `Runner version unknown`. */
	state: string;
	/** Where the update is done: the machine's page when the node reports an id, else Terminals. */
	href: string;
}

/**
 * Whether the pinned machine's CLI is too old for the saved browser settings (#1593). The server refuses the launch
 * when the version is lower, missing or malformed, so unknown reads as a warning too. Nothing when the machine is
 * current, no machine is pinned, or the machine list could not be read (nothing known is not a reason to warn).
 */
export function browserCliWarning(requiredCli: string | null | undefined, rn: RunnerNodeRead | null, machines: readonly Machine[] | null): CliWarning | null {
	if (!requiredCli || !rn || !machines) return null;
	const { node, version } = readRunner(rn, machines);
	if (!node) return null;
	const machine = machines.find((m) => m.node === node || (m.aka ?? []).includes(node));
	const href = machine?.machineId ? `/terminals/machines/${encodeURIComponent(machine.machineId)}` : "/terminals";
	// A version that does not compare with itself is not x.y.z.
	if (!version || compareVersions(version, version) === null) return { state: "Runner version unknown", href };
	const cmp = compareVersions(version, requiredCli);
	if (cmp === null || cmp >= 0) return null;
	return { state: `Runner ${version.replace(/^v/, "")} is older than ${requiredCli.replace(/^v/, "")}`, href };
}
