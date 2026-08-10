/**
 * "This didn't load" — the sentence an empty list cannot say (#291).
 *
 * ── Why this exists
 *
 * Almost every list in the console loads through `try { setThing(await api(...)) } catch {}`. The
 * catch is not the defect on its own: `api()` has already written the durable error row before it
 * throws (`packages/sdk/src/client.ts`), so the failure IS recorded and readable over MCP
 * `list_errors`. The defect is what the user is then shown — the list state never changed, so it
 * renders its empty state, and "Documents (0)" is a confident claim about the account rather than a
 * report about the request.
 *
 * So the triage rule this component serves is NOT "reads are safe, writes are dangerous". It is:
 * **a fallback that is indistinguishable from a real answer is the dangerous case**, whichever
 * direction the request went. A list falling back to `[]` qualifies, and the worst instance of it in
 * this product cost the user data rather than a glance — Knowledge → Rules & Tips rendered an empty
 * textarea over a failed read with a live Save next to it, so the failure did not merely hide the
 * standing rules, it armed the control that overwrites them.
 *
 * ── Why a component rather than a message per site
 *
 * Because the alternative was a dozen hand-written variations of the same sentence, and a user who
 * meets two of them learns nothing from the second. Retry is part of it for the same reason: the
 * overwhelmingly common cause is one dropped request, and an error state with no way out of it just
 * relocates the dead end.
 */
export default function LoadFailed({
	what,
	detail,
	onRetry,
	testId,
	compact,
}: {
	/** What failed to load, as a noun phrase: "your documents", "this agent's memory". */
	what: string;
	/** The error text. Shown, not hidden — it is usually the only clue the user can relay. */
	detail?: string;
	onRetry: () => void;
	testId?: string;
	/** Inline row rather than a centred block, for a section inside an already-busy panel. */
	compact?: boolean;
}) {
	return (
		<div
			data-testid={testId ?? "load-failed"}
			className={
				compact
					? "flex items-center gap-2 flex-wrap text-xs px-3 py-2 rounded-lg bg-danger-soft border border-danger-line text-danger"
					: "flex flex-col items-center gap-2 text-center py-8 px-3 text-sm text-danger"
			}
		>
			<span className="font-semibold">Couldn't load {what}.</span>
			{detail ? <span className="text-xs text-muted break-words">{detail}</span> : null}
			<button
				type="button"
				onClick={onRetry}
				className="text-xs px-2.5 py-1 rounded-lg border border-danger-line text-danger font-semibold hover:bg-danger-soft"
			>
				Retry
			</button>
		</div>
	);
}
