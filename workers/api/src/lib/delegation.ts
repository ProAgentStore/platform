// Shared shape for a delegated-goal board task (#155). ONE source of truth for the observable
// "Overseer delegated on your behalf" card — used by both the route that CREATES it (running,
// routes/coding.ts) and the durable Pilot that CLOSES it (completed/failed,
// workflows/coding-session.ts). Kept in lib/ so the workflow doesn't import a routes module.

/** Build the board-task record for a delegated goal. Attributed to the Overseer on the user's
 *  behalf — never a user turn. `note` (e.g. the terminal outcome) is appended to the reasoning. */
export function delegationTaskRecord(opts: {
	id: string;
	/** Human name of whatever the goal went TO — a repo today, an instance once supervision is
	 *  configurable (#183). Generic so the board card doesn't have to be re-shaped per target
	 *  kind; the rendered text is unchanged for repos. */
	targetLabel: string;
	objective: string;
	status: "running" | "completed" | "failed";
	now: string;
	note?: string;
}): Record<string, unknown> {
	const label = opts.objective.length > 120 ? `${opts.objective.slice(0, 117)}…` : opts.objective;
	const reasoning = `Overseer delegated on your behalf → ${opts.targetLabel}: ${opts.objective}${opts.note ? ` — ${opts.note}` : ""}`.slice(0, 8000);
	return {
		id: opts.id,
		type: "delegation",
		status: opts.status,
		title: `Delegated: ${label}`.slice(0, 200),
		reasoning,
		createdAt: opts.now,
		updatedAt: opts.now,
	};
}
