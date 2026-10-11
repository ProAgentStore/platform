// The owner-directive block of the Pilot prompt (#1015). Its own module: `coding-loop.ts` is at its size pin.

/** How many directives the prompt quotes in full. The CONSTRAINTS come from every one (#1019). */
export const DIRECTIVES_SHOWN = 10;

/**
 * Where a directive stands with the ENGINE (#1019). Accepted, queued, delivered and processed are four
 * different facts, and a newer directive the engine has not yet read must not read as acknowledged.
 * None of them changes whether it binds the Pilot: it binds from the moment the owner sent it.
 */
export function directiveState(d: { delivery: string; processed: boolean }): string {
	if (d.processed) return "processed by the engine";
	if (d.delivery === "queued") return "queued behind the engine's turn — not yet read by it";
	if (d.delivery === "interrupting") return "sent, interrupting the engine's turn — not yet confirmed processed";
	if (d.delivery === "delivered") return "delivered to the idle engine — not yet confirmed processed";
	return "accepted by the runner — the engine's state was unknown, not yet confirmed processed";
}

/**
 * The owner's directives for this run, as the Pilot reads them every round (#1015). Newest LAST and
 * stated as overriding the objective: a later "read-only", "do not stash", or "stop after the push —
 * do not wait for CI" stays in force, and the Pilot must not re-issue the original objective over it.
 * Only the newest {@link DIRECTIVES_SHOWN} are quoted; what the older ones still require is listed by
 * the constraints block, which reads all of them.
 */
export function ownerDirectivesBlock(directives: ReadonlyArray<{ text: string; delivery: string; processed: boolean }>): string {
	const hidden = Math.max(0, directives.length - DIRECTIVES_SHOWN);
	const items = directives.map((d, i) => ({ d, n: i + 1 })).filter(({ n }) => n > hidden).map(({ d, n }) => `${n}. ${d.text} (${directiveState(d)})`);
	const older = hidden ? `(${hidden} earlier directive${hidden === 1 ? "" : "s"} not quoted — what they still require is in CONSTRAINTS IN FORCE below.)\n` : "";
	return `\nOWNER DIRECTIVES FOR THIS RUN — the owner's latest words, newest last. They OVERRIDE the objective and any earlier instruction wherever they conflict, and stay in force for the rest of the run, whether or not the engine has processed them yet. Never send an instruction that contradicts them, and never re-issue the original objective in a form they narrowed:\n${older}${items.join("\n")}`;
}
