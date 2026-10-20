/**
 * Where a parked run's set-aside work is (#1242), as the loop-run view reports it. Its own module so
 * `agent-loop-store.ts` stays under its size line; the row columns are 0246 + 0263.
 */
/**
 * Where a parked run's work is (#1242). `snapshot` is the set-aside commit — null when it had nothing
 * uncommitted or kept its checkout; `pushedToOrigin` says whether the copy at `ref` reached origin (null:
 * unknown, e.g. a runner before CLI 0.4.165). A run resumes only on `node`/`machineId`.
 */
export interface ParkedWork {
	machineId: string | null;
	node: string | null;
	workdir: string | null;
	snapshot: string | null;
	ref: string | null;
	pushedToOrigin: boolean | null;
}

/** The row columns the view is built from. */
interface ParkedRow {
	run_id: string;
	status: string;
	waiting_reason: string | null;
	checkout_snapshot?: string | null;
	parked_machine_id?: string | null;
	parked_node?: string | null;
	parked_workdir?: string | null;
	parked_pushed?: number | null;
}

export function parkedWork(row: ParkedRow): ParkedWork | null {
	const parkedNow = row.status === "running" && row.waiting_reason === "decision";
	if (!row.checkout_snapshot && !(parkedNow && (row.parked_node || row.parked_machine_id))) return null;
	return {
		machineId: row.parked_machine_id ?? null,
		node: row.parked_node ?? null,
		workdir: row.parked_workdir ?? null,
		snapshot: row.checkout_snapshot ?? null,
		ref: row.checkout_snapshot ? `refs/pags/parked/${row.run_id}` : null,
		pushedToOrigin: row.parked_pushed === 1 ? true : row.parked_pushed === 0 ? false : null,
	};
}
