// The run's objective, delivered verbatim with a turn and attributed to the platform (#1019).

/** A run objective as the cloud sent it, or undefined — narrowed, because any caller can POST here (#1019). */
export function runObjective(raw: unknown): { runId: string; text: string } | undefined {
	const o = raw as { runId?: unknown; text?: unknown } | null | undefined;
	return o && typeof o.runId === "string" && o.runId.length <= 128 && typeof o.text === "string" && o.text.trim() ? { runId: o.runId, text: o.text } : undefined;
}

/**
 * The run's objective as the engine reads it (#1019): verbatim, fenced, and attributed to the platform —
 * the Pilot's instruction that follows is its own turn, and owner directives sent later outrank both.
 */
export function runObjectiveBlock(o: { runId: string; text: string }): string {
	return [
		`[pags] RUN OBJECTIVE — the owner's objective for run ${o.runId}, exactly as ProAgentStore accepted it. It was not written by the Pilot. Owner instructions sent later in this run take precedence over it.`,
		"<<<OBJECTIVE",
		o.text,
		"OBJECTIVE>>>",
	].join("\n");
}
