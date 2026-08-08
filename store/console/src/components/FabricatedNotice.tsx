/**
 * The label on a retracted answer (#406).
 *
 * A stored assistant message that wrote its own tool results is still in the transcript and still
 * reads, to a scrolling human, exactly like an answer that was fetched — which is how an invented
 * list of three GitHub issues became the basis of a decision about what to build next. #395 catches
 * this at generation time; the rows written before it shipped are what this is for, and the API
 * stamps them on every read (`Message.fabricated`).
 *
 * It is a label, not a deletion. The user acted on the text, so the text stays: removing it would
 * take away the only thing that shows them what they acted on. What changes is that it can no
 * longer be mistaken for a real one, and — separately, server-side — the agent no longer reads it.
 *
 * Red rather than the platform's yellow. Yellow is this console's colour for "the platform is
 * reporting" (SystemMessage, #336), and a retracted answer is a stronger claim than a report: the
 * content directly below this line is false.
 */
export default function FabricatedNotice() {
	return (
		<div className="text-2xs text-danger font-bold mb-1 flex items-start gap-1">
			<span aria-hidden="true">⚠️</span>
			<span>
				Not fetched. This reply wrote its own tool results — nothing in it was read from a tool. It is kept as a record
				and is withheld from the agent’s context.
			</span>
		</div>
	);
}
