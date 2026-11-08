import { useEffect } from "react";
import type { HistoryPanelId, PanelReport } from "../../lib/activityView";

/** What every History panel takes: who it is for, and where to say what it holds. */
export interface PanelProps {
	instanceId: string;
	onReport: (id: HistoryPanelId, report: PanelReport) => void;
}

/** Tell the History area what this panel holds, so it can order itself and know when it is empty. */
export function useReport(id: HistoryPanelId, onReport: PanelProps["onReport"], status: PanelReport["status"], rows: number, needsOwner: boolean) {
	useEffect(() => {
		onReport(id, { status, rows, needsOwner });
	}, [id, onReport, status, rows, needsOwner]);
}
