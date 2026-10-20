/**
 * Where a parked run's set-aside work is (#1242) — the `parked` field of a loop run. A run resumes only
 * on the machine it parked on, so that machine is what the owner needs to see; the commit and whether
 * origin holds a copy say whether the work survives that machine.
 */
export interface ParkedWork {
	machineId: string | null;
	node: string | null;
	workdir: string | null;
	snapshot: string | null;
	ref: string | null;
	pushedToOrigin: boolean | null;
}

/** "Parked work 7cf5861 on pink-laptop · copy on origin", or "" when there is none to account for. */
export function parkedLine(p: ParkedWork | null | undefined): string {
	if (!p || (!p.snapshot && !p.node)) return "";
	const what = p.snapshot ? `Parked work ${p.snapshot.slice(0, 7)}` : "Parked";
	const where = p.node ? ` on ${p.node}` : "";
	const copy = !p.snapshot ? "" : p.pushedToOrigin === true ? " · copy on origin" : p.pushedToOrigin === false ? " · no copy on origin — that machine holds the only one" : "";
	return `${what}${where}${copy}`;
}
