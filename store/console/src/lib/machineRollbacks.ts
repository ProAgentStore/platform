import type { MachineDetail, MachineRollback } from "./machineDetail";
import { machineLatestVersion } from "./machineDetail";

/** The rollbacks the machine page lists, newest first; none on an older API or a machine that never rolled back. */
export function machineRollbacks(machine: MachineDetail): MachineRollback[] {
	return [...(machine.rollbacks ?? [])].sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0));
}

/**
 * Whether "Retry" would do something: the release the machine would update to is one it rolled back from, so auto-update
 * and a plain update both refuse it (#1150). A newer release than the rolled-back one installs as usual — nothing to retry.
 */
export function retryableRollback(machine: MachineDetail): MachineRollback | null {
	const latest = machineLatestVersion(machine);
	return latest ? (machineRollbacks(machine).find((r) => r.from === latest) ?? null) : null;
}

/** One line for a rollback: "0.4.150 → back to 0.4.149: it did not register…". */
export function rollbackLine(r: MachineRollback): string {
	return `${r.from} was rolled back${r.to ? ` to ${r.to}` : ""}: ${r.reason.replace(/\.$/, "")}.`;
}
