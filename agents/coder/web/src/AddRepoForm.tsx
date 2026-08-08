/**
 * "Point this agent at a repo" — ONE form, wherever the question is asked (#411).
 *
 * There are two places an agent can have no repository: the multi-repo list, and the solo view a
 * one-repo agent gets instead of a list (`CodingTab`'s `singleRepo` branch, which returns before
 * `ReposList` is ever rendered). Only the first had an add form; the second showed *"add its path
 * in Settings → Agent settings"* — a `repo` field that seeded the row once, was read by nothing
 * afterwards, and is deleted by migration 0101. So a one-repo agent whose repo was wrong or
 * removed had nowhere in the product to fix it.
 *
 * Extracted rather than copied. Two copies of an input and a button is how the console ends up
 * with a fourteenth button shape (#366/#367) — and the whole lesson of this ticket is that one
 * fact deserves one place, which applies to the control as much as to the column behind it.
 */
export default function AddRepoForm({ value, onChange, onAdd, heading, className = "" }: {
	value: string;
	onChange: (v: string) => void;
	onAdd: () => void;
	/** Shown above the field where this form IS the empty state, rather than an extra panel row. */
	heading?: string;
	className?: string;
}) {
	return (
		<div className={className}>
			{heading && <p className="text-sm text-muted-soft mb-3 text-center">{heading}</p>}
			<div className="flex gap-1.5 flex-wrap">
				<input
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") onAdd(); }}
					aria-label="Repository path or URL"
					placeholder="~/dev/my-repo or owner/repo or clone URL"
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					className="flex-1 min-w-[180px] bg-panel border border-line rounded-xl px-3 py-2 text-sm"
				/>
				<button type="button" onClick={onAdd} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Add</button>
			</div>
			<p className="text-xs text-muted mt-1.5 text-left">
				<b>Best for dev:</b> point at a repo you already have (<code>~/dev/my-repo</code>) — the agent works in your real checkout.
			</p>
		</div>
	);
}
