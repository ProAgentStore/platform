// The owner-directive block of the Pilot prompt (#1015). Its own module: `coding-loop.ts` is at its size pin.

/**
 * The owner's directives for this run, as the Pilot reads them every round (#1015). Newest LAST and
 * stated as overriding the objective: a later "read-only", "do not stash", or "stop after the push —
 * do not wait for CI" stays in force, and the Pilot must not re-issue the original objective over it.
 */
export function ownerDirectivesBlock(directives: ReadonlyArray<{ text: string; processed: boolean }>): string {
	const items = directives.map((d, i) => `${i + 1}. ${d.text}${d.processed ? "" : " (not yet processed by the engine)"}`);
	return `\nOWNER DIRECTIVES FOR THIS RUN — the owner's latest words, newest last. They OVERRIDE the objective and any earlier instruction wherever they conflict, and stay in force for the rest of the run. Never send an instruction that contradicts them, and never re-issue the original objective in a form they narrowed:\n${items.join("\n")}`;
}
