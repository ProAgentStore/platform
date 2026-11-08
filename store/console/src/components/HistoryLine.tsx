import { Link } from "react-router-dom";
import { type HistoryLineState, historyLineView, VIEW_IN_ACTIVITY } from "../lib/historyLine";
import type { HistoryPanelId } from "../lib/activityView";

/** Waiting for the owner is a warning; events that never arrived are a failure; the rest is just status. */
const TONE = { warn: "text-warning font-semibold", bad: "text-danger font-semibold", muted: "text-muted" } as const;

/**
 * The one line a Settings card keeps for a panel that moved to Activity → History (#1590):
 * `<state> · View in Activity`, `Checking…` while loading, `Couldn't check · View in Activity` on failure.
 * Renders nothing when the card has nothing to say.
 */
export default function HistoryLine({ instanceId, panel, state, testId }: { instanceId: string; panel: HistoryPanelId; state: HistoryLineState; testId: string }) {
	const view = historyLineView(state);
	if (!view) return null;
	return (
		<p role="status" data-testid={testId} className="text-xs flex flex-wrap items-center gap-x-1 min-h-6">
			<span className={TONE[view.tone]}>{view.text}</span>
			{view.link && (
				<>
					<span className="text-muted" aria-hidden="true">·</span>
					<Link to={`/instances/${encodeURIComponent(instanceId)}/activity?view=history&panel=${panel}`} className="underline min-h-6 inline-flex items-center">
						{VIEW_IN_ACTIVITY}
					</Link>
				</>
			)}
		</p>
	);
}
