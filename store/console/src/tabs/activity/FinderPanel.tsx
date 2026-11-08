import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import { type OriginalFinderOverview, countRows, leadNeedsOwner, orderLeads, safeHref, stateLabel } from "../../lib/originalFinder";
import { type PanelProps, useReport } from "./useReport";

/**
 * Activity → History → Original Finder (#1616): the queue by state and the recent leads, failed first.
 * Shown only for a Finder; renders nothing while it holds nothing.
 */
export default function FinderPanel({ instanceId, onReport }: PanelProps) {
	const [data, setData] = useState<OriginalFinderOverview | null>(null);
	const [failed, setFailed] = useState("");

	const load = useCallback(async () => {
		try {
			setData(await api<OriginalFinderOverview>(`/v1/instances/${instanceId}/original-finder`));
			setFailed("");
		} catch (e) {
			setFailed(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => {
		void load();
	}, [load]);

	const leads = data ? orderLeads(data.leads) : [];
	useReport("finder", onReport, data ? "ready" : failed ? "failed" : "loading", leads.length, leads.some(leadNeedsOwner));

	if (!data) return failed ? <LoadFailed what="the Original Finder queue" detail={failed} onRetry={() => void load()} testId="history-failed-finder" compact /> : null;
	if (leads.length === 0) return null;

	return (
		<Card className="mb-3 sm:mb-4" data-testid="history-finder">
			<h3 className="text-base font-bold mb-1">Original Finder</h3>
			<p className="text-xs text-muted mb-2" data-testid="finder-counts">
				{countRows(data.counts).map(({ state, n }) => `${n} ${stateLabel(state)}`).join(" · ")}
			</p>
			{leads.map((l) => {
				const href = safeHref(l.original_url);
				return (
					<div key={l.lead_id} className="text-sm border border-line rounded-lg px-3 py-2 mb-1" data-testid="finder-row">
						<div className={`font-semibold ${leadNeedsOwner(l) ? "text-danger" : ""}`}>
							{stateLabel(l.state)}
							<span className="font-normal text-muted text-xs"> · {l.attempts} {l.attempts === 1 ? "attempt" : "attempts"}</span>
						</div>
						{l.state === "queued" && l.next_attempt_at ? <div className="text-2xs text-muted">Next attempt {new Date(l.next_attempt_at).toLocaleString()}</div> : null}
						{l.detail && <div className="text-2xs text-muted break-words">{l.detail}</div>}
						{href && <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs underline break-all inline-flex items-center min-h-6">{l.original_url}</a>}
					</div>
				);
			})}
		</Card>
	);
}
