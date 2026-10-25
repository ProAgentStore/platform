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

/**
 * What to tell the owner about a machine that updates in place (#1147): not under the bootstrap stub, so a release is not
 * installed beside the running one with a fallback. null when it is (or the machine has not said).
 */
export function noRollbackNote(machine: MachineDetail): string | null {
	return machine.rollback_available === false
		? "This machine updates in place (it is not running under the bootstrap stub), so a broken release is not tried beside the running one. A new release is started once after it is installed and, if that fails, the previous release is put back — but there is no automatic fall-back after that. Starting it with `pags up` from the installed `pags` command puts it under the stub."
		: null;
}
