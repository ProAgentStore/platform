/**
 * What a board card that IS a Scout scan says about it (#980).
 *
 * Its own component for the reason `BoardIssueFace` and `ApplicationRunFace` are: the card is a
 * projection of another domain, so that domain's vocabulary — sources, results, leads, the reason a
 * scan found nothing — lives next to itself and `BoardTab` stays about the board.
 *
 * Counts and closed-vocabulary words only, exactly as the server wrote them: the leads themselves
 * are Data, reachable from the run page this card links to.
 */

/** The scan fields a board card carries (#980), from `GET /board`. */
export interface ScanRunFields {
	scan?: {
		runId: string;
		startedBy: "owner" | "trigger" | "unknown";
		pages: number;
		results: number;
		leadsAdded: number;
		duplicates: number;
		pendingReview: number;
		sourcesConfigured: number;
		sourcesUnreachable: number;
		handoffs: number;
		warnings: number;
		errors: number;
		outcome: string;
		reason: string;
		leadRecordIds: string[];
		pauseReason?: string;
	};
}

export default function ScanRunFace({ item }: { item: ScanRunFields }) {
	const scan = item.scan;
	if (!scan) return null;
	return (
		<div className="text-xs mt-2 flex flex-col gap-0.5" data-testid="scan-run">
			<span>
				<span className="text-accent font-bold">{scan.startedBy === "trigger" ? "Scheduled scan:" : "Scan:"}</span> {scan.pages} page{scan.pages === 1 ? "" : "s"} · {scan.results} result
				{scan.results === 1 ? "" : "s"} · {scan.leadsAdded} lead{scan.leadsAdded === 1 ? "" : "s"} added
			</span>
			{(scan.duplicates > 0 || scan.pendingReview > 0) && (
				<span className="text-muted">
					{scan.duplicates > 0 && `${scan.duplicates} duplicate${scan.duplicates === 1 ? "" : "s"}`}
					{scan.duplicates > 0 && scan.pendingReview > 0 && " · "}
					{scan.pendingReview > 0 && `${scan.pendingReview} awaiting your review`}
				</span>
			)}
			{scan.sourcesUnreachable > 0 && (
				<span className="text-warning">
					{scan.sourcesUnreachable} of {scan.sourcesConfigured || scan.sourcesUnreachable} source{scan.sourcesConfigured === 1 ? "" : "s"} unreachable
				</span>
			)}
			{scan.pauseReason && <span className="text-warning">Waiting for you: {scan.pauseReason.replace(/_/g, " ")}</span>}
			{scan.errors > 0 && <span className="text-danger">{scan.errors} error{scan.errors === 1 ? "" : "s"} — open the run for the detail</span>}
			{/* The one sentence that answers "why did this find nothing". */}
			<span className="text-muted break-words">{scan.reason}</span>
		</div>
	);
}
