import { useState, useEffect, useCallback } from "react";
import { api } from "@proagentstore/sdk/client";
import type { AppRecord } from "../lib/types";
import { usePolling } from "@proagentstore/sdk/hooks";
import BoardTab from "./BoardTab";

// The job-application agent's dedicated surface: the applications pipeline on top
// of the shared runtime board (tasks + activity, via BoardTab). Registered as the
// "apply" surface in lib/surfaces.tsx. See ../../../PLAN-agent-os.md (Phase 2).

const APP_COLUMNS = [
	{ id: "queued", title: "Queued", color: "#eab308", statuses: ["queued"] },
	{ id: "pending", title: "Pending", color: "#3b82f6", statuses: ["pending"] },
	{ id: "submitted", title: "Submitted", color: "#7c3aed", statuses: ["submitted"] },
	{ id: "interview", title: "Interview", color: "#22c55e", statuses: ["interview"] },
	{ id: "rejected", title: "Rejected", color: "#ef4444", statuses: ["rejected"] },
	{ id: "accepted", title: "Accepted", color: "#22c55e", statuses: ["accepted"] },
];

export default function ApplyTab({ instanceId }: { instanceId: string }) {
	const [apps, setApps] = useState<AppRecord[]>([]);

	const loadApps = useCallback(async () => {
		try {
			const data = await api<{ records: AppRecord[] }>(
				`/v1/instances/${instanceId}/collections/applications/records`,
			);
			setApps(data.records || []);
		} catch {}
	}, [instanceId]);

	useEffect(() => { loadApps(); }, [loadApps]);
	usePolling(loadApps, 2500);

	return (
		<div>
			<div className="mb-3">
				<h3 className="text-base font-bold mb-0.5">Applications</h3>
				<div className="text-xs text-muted">
					{apps.length} application{apps.length !== 1 ? "s" : ""}
				</div>
			</div>

			{apps.length > 0 ? (
				<div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 items-start mb-6">
					{APP_COLUMNS.map((col) => {
						const items = apps.filter((a) => col.statuses.includes(a.status || "queued"));
						return (
							<div key={col.id} className="border border-line rounded-xl bg-panel/55 min-h-[120px]">
								<div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-line">
									<div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide">
										<span className="w-2 h-2 rounded-full" style={{ background: col.color }} />
										{col.title}
									</div>
									<span className="text-[0.65rem] text-muted border border-line rounded-full px-1.5 font-bold">
										{items.length}
									</span>
								</div>
								<div className="flex flex-col gap-1.5 p-2">
									{items.map((app) => (
										<div key={app.id} className="bg-paper border border-line rounded-lg p-2.5 text-sm">
											<div className="font-bold text-xs mb-0.5">{app.company || "Unknown"}</div>
											<div className="text-xs text-muted line-clamp-1">{app.role || ""}</div>
										</div>
									))}
								</div>
							</div>
						);
					})}
				</div>
			) : (
				<div className="text-center text-muted-soft text-sm py-6 mb-4 border border-line border-dashed rounded-xl">
					No applications yet — start one from chat or the agent.
				</div>
			)}

			{/* Shared runtime board (tasks + activity) */}
			<BoardTab instanceId={instanceId} />
		</div>
	);
}
