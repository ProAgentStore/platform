/**
 * What a board card that IS an application execution says about it (#978).
 *
 * Its own component for the reason `BoardIssueFace` is: the card is a projection of someone else's
 * domain, so the domain's vocabulary — stage, checkpoint, directive, terminal reason, trace — lives
 * next to itself rather than inside the generic card, and `BoardTab` stays about the board.
 *
 * The APPLICATION itself remains data (its record, artifacts, authorization and outcome are on the
 * Applications/Data surface); this is only the run against it.
 */

/** The application fields a board card carries (#978), from `GET /board`. */
export interface ApplicationRunFields {
	application?: {
		applicationId: string;
		applicationStatus: string;
		stateVersion: number;
		actions: string[];
		kind: "tailor" | "fill";
		runId: string;
		stage: string;
		traceUrl: string;
		checkpoint?: { checkpointId: string; phase: string; directive: string | null };
		/** How far the fill actually got, from the runner's own facts (#986) — the counts `stage` was written from. */
		progress?: { stage: string; label: string; filled: number; uploaded: number; checkpointPhase: string | null; submitAttempted: boolean };
		blockReason?: string;
		runnerVersion?: string;
	};
}

/**
 * What each application control is called, and which ones ask first.
 *
 * A LABEL table, not a second source of truth about what is allowed: the server tells the card
 * which actions are permitted right now, and anything not named here is simply not rendered.
 */
export const APPLICATION_ACTION_LABEL: Record<string, string> = {
	request_review: "Fill for review",
	start_fill: "Fill and submit (policy allows)",
	approve_and_proceed: "Approve & proceed",
	retry_fill: "Retry fill",
	retry_tailoring: "Retry tailoring",
	resume: "Resume",
	cancel: "Cancel run",
	defer: "Defer",
	archive: "Archive",
	mark_not_interested: "Not interested",
	apply: "Put back in the queue",
	generate_materials: "Tailor materials",
};

/**
 * The label for one control, STAGE-aware for the approval (#981): before the fill it proceeds, after
 * the fill it continues. Falls back to the table, which is also what decides whether a control is
 * rendered at all.
 */
export const applicationControlLabel = (action: string, status?: string): string =>
	action === "approve_and_proceed" && status && status !== "materials_ready" ? "Approve & continue" : (APPLICATION_ACTION_LABEL[action] ?? action);

/** The controls that reach an employer's site, or stop live work — they ask before they run. */
export const APPLICATION_CONFIRM: Record<string, string> = {
	start_fill: "Fill this application and SUBMIT it to the employer if the site accepts it?",
	approve_and_proceed: "Approve THIS application and submit it to the employer? The approval covers this one job only and is used once.",
	// After the fill the owner is authorising the form that is already populated and waiting (#981).
	"approve_and_proceed:post_fill":
		"Approve THIS filled application and let it be submitted? The approval covers this one job only and is used once. If its browser session has already closed, the approval is held and a fresh run sends it — nothing is submitted twice.",
	cancel: "Stop the running tailoring or fill?",
};

/** The stage, the checkpoint it waits on, why it stopped, and where the correlated history is. */
export default function ApplicationRunFace({ item }: { item: ApplicationRunFields }) {
	const app = item.application;
	if (!app) return null;
	return (
		<div className="text-xs mt-2 flex flex-col gap-0.5" data-testid="application-run">
			{/* #986: the prefix names the KIND of run, not what it is doing — "Filling:" was printed
			    over every fill stage, so a card whose own sentence said nothing had been entered still
			    read as filling. What it is doing is `stage`, which is the runner's own facts. */}
			<span>
				<span className="text-accent font-bold">{app.kind === "tailor" ? "Tailoring" : "Fill"}:</span> {app.stage}
			</span>
			{app.progress && (
				<span className="text-muted-soft">
					{app.progress.filled} field{app.progress.filled === 1 ? "" : "s"}, {app.progress.uploaded} attachment{app.progress.uploaded === 1 ? "" : "s"}
					{app.progress.checkpointPhase ? ` · checkpoint ${app.progress.checkpointPhase.replace(/_/g, " ")}` : ""}
				</span>
			)}
			{app.checkpoint && (
				<span className="text-warning">
					Checkpoint {app.checkpoint.checkpointId} ({app.checkpoint.phase}) — {app.checkpoint.directive ? `directive: ${app.checkpoint.directive}` : "awaiting a directive"}
				</span>
			)}
			{app.blockReason && <span className="text-muted-soft">Reason: {app.blockReason.replace(/_/g, " ")}</span>}
			<a href={app.traceUrl} onClick={(e) => e.stopPropagation()} className="text-accent hover:underline w-fit">
				View the correlated trace →
			</a>
		</div>
	);
}

/**
 * The application's permitted controls, exactly as the action service lists them — so the board
 * offers nothing the Applications surface or MCP would refuse.
 */
export function ApplicationRunControls({ item, busy, onAction, compact }: { item: ApplicationRunFields; busy?: string | null; onAction: (action: string) => void; compact?: boolean }) {
	return (
		<>
			{(item.application?.actions ?? [])
				.filter((a) => a in APPLICATION_ACTION_LABEL)
				.map((a) => (
					<button
						key={a}
						type="button"
						disabled={!!busy}
						onClick={(e) => {
							e.stopPropagation();
							onAction(a);
						}}
						className={`${compact ? "shrink-0 " : ""}text-2xs px-2 py-1 rounded border border-line text-accent hover:bg-accent-soft font-bold disabled:opacity-40`}
						title={applicationControlLabel(a, item.application?.applicationStatus)}
					>
						{busy === a ? "…" : applicationControlLabel(a, item.application?.applicationStatus)}
					</button>
				))}
		</>
	);
}
