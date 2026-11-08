import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
	type ActivityView,
	type HistoryCaps,
	type HistoryPanelId,
	HISTORY_PANELS,
	historyIsEmpty,
	orderPanels,
	type PanelReport,
	showsHistoryPanel,
} from "../../lib/activityView";
import BrowserLaunchPanel from "./BrowserLaunchPanel";
import DeliveriesPanel from "./DeliveriesPanel";
import FinderPanel from "./FinderPanel";
import LoopRunsPanel from "./LoopRunsPanel";
import SecureInputsPanel from "./SecureInputsPanel";
import TakeoversPanel from "./TakeoversPanel";
import type { PanelProps } from "./useReport";

/**
 * Activity's History area (#1590): what is waiting for the owner and what already happened, ABOVE the
 * timeline on every visit. Status and history used to sit at the bottom of Settings pages, where a run
 * waiting on its owner for 29 days was easy to lose.
 *
 * Each panel fetches and refreshes itself, and reports what it holds; this area only orders them
 * (`orderPanels`: a panel with something for the owner first) and says so when there is nothing at all.
 * A panel with no rows renders nothing. `lib/activityView.ts` owns the URL grammar and the ordering.
 */
export default function HistoryArea({ instanceId, caps, view }: { instanceId: string; caps: HistoryCaps; view: ActivityView }) {
	const [reports, setReports] = useState<Partial<Record<HistoryPanelId, PanelReport>>>({});
	const onReport = useCallback<PanelProps["onReport"]>((id, r) => {
		setReports((prev) => {
			const p = prev[id];
			return p && p.status === r.status && p.rows === r.rows && p.needsOwner === r.needsOwner ? prev : { ...prev, [id]: r };
		});
	}, []);

	const panelProps = { instanceId, onReport };
	const renderers: Partial<Record<HistoryPanelId, () => ReactNode>> = {
		"loop-runs": () => <LoopRunsPanel {...panelProps} />,
		takeovers: () => <TakeoversPanel {...panelProps} highlightId={view.takeover} />,
		"browser-launch": () => <BrowserLaunchPanel {...panelProps} />,
		"secure-inputs": () => <SecureInputsPanel {...panelProps} />,
		finder: () => <FinderPanel {...panelProps} />,
		deliveries: () => <DeliveriesPanel {...panelProps} focused={view.panel === "deliveries"} />,
	};
	const shown = HISTORY_PANELS.filter((id) => renderers[id] && showsHistoryPanel(caps, id));
	const reportOf = (id: HistoryPanelId): PanelReport => reports[id] ?? { status: "loading", rows: 0, needsOwner: false };
	const order = orderPanels(shown.map((id) => ({ id, needsOwner: reportOf(id).needsOwner })));
	const answered = shown.every((id) => reportOf(id).status !== "loading");

	// A link that names History (or a panel) scrolls to and focuses it once every panel has answered, so the target is where it will stay.
	const areaRef = useRef<HTMLElement>(null);
	const focused = useRef(false);
	useEffect(() => {
		if (!view.focusHistory || focused.current || !answered) return;
		focused.current = true;
		const panel = view.panel && reportOf(view.panel).rows > 0 ? document.getElementById(`history-panel-${view.panel}`) : null;
		const target = panel ?? areaRef.current;
		// After layout settles: WebKit scrolled the document instead of the tab's own scroller when this ran in the commit.
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				target?.scrollIntoView({ block: "start" });
				target?.focus({ preventScroll: true });
			}),
		);
	});

	const empty = historyIsEmpty(shown.map(reportOf));
	return (
		<section ref={areaRef} tabIndex={-1} aria-label="History" data-testid="activity-history" className="outline-none">
			{order.map((id) => (
				<div key={id} id={`history-panel-${id}`} tabIndex={-1} data-testid={`history-panel-${id}`} className="outline-none">
					{renderers[id]?.()}
				</div>
			))}
			{empty && view.focusHistory && (
				<p className="text-sm text-muted mb-3 sm:mb-4" data-testid="history-empty">Nothing waiting and no recent history</p>
			)}
		</section>
	);
}
