// Shared shape for a delegated-goal board task (#155). ONE source of truth for the observable
// "Overseer delegated on your behalf" card — used by both the route that CREATES it (running,
// routes/coding.ts) and the durable Pilot that CLOSES it (completed/failed,
// workflows/coding-session.ts). Kept in lib/ so the workflow doesn't import a routes module.

/** Build the board-task record for a delegated goal. Attributed to the Overseer on the user's
 *  behalf — never a user turn. `note` (e.g. the terminal outcome) is appended to the reasoning. */
export function delegationTaskRecord(opts: {
	id: string;
	repoName: string;
	objective: string;
	status: "running" | "completed" | "failed";
	now: string;
	note?: string;
}): Record<string, unknown> {
	const label = opts.objective.length > 120 ? `${opts.objective.slice(0, 117)}…` : opts.objective;
	const reasoning = `Overseer delegated on your behalf → ${opts.repoName}: ${opts.objective}${opts.note ? ` — ${opts.note}` : ""}`.slice(0, 8000);
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
