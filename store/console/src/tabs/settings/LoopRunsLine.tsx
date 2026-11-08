import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import HistoryLine from "../../components/HistoryLine";
import { type LoopRunsResponse, runNeedsOwner } from "../../lib/activityView";
import { type HistoryLineState, loopRunsLine } from "../../lib/historyLine";

/**
 * Settings → Automation: the one line left of "Autonomous runs", which are history and live in Activity →
 * History (#1590). Says how many runs wait for the owner; `Checking…` until it knows.
 */
export default function LoopRunsLine({ instanceId }: { instanceId: string }) {
	const [state, setState] = useState<HistoryLineState>({ status: "loading" });
	const load = useCallback(async () => {
		try {
			const r = await api<LoopRunsResponse>(`/v1/instances/${instanceId}/loop`);
			setState(loopRunsLine((r.runs ?? []).filter(runNeedsOwner).length));
		} catch {
			setState({ status: "failed" });
		}
	}, [instanceId]);
	useEffect(() => {
		void load();
	}, [load]);
	return (
		<div className="mb-3 sm:mb-4">
			<HistoryLine instanceId={instanceId} panel="loop-runs" state={state} testId="loop-runs-line" />
		</div>
	);
}
