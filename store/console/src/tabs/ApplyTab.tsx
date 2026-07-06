import { useNavigate } from "react-router-dom";
import type { BoardColumn } from "../lib/types";
import BoardTab from "./BoardTab";
import ApplicationDetail from "./ApplicationDetail";

// The job-application agent's surface is now just the ONE shared work board
// (BoardTab), configured by the agent's columns. A deep link to a single
// application record still opens its rich detail page. The old second
// "Applications" records board was retired — see BoardTab.tsx.

export default function ApplyTab({ instanceId, recordId, columns }: { instanceId: string; recordId?: string; columns?: BoardColumn[] }) {
	const navigate = useNavigate();

	// Deep-linked to a single application → the rich detail page (agent-custom UI).
	if (recordId) {
		return <ApplicationDetail instanceId={instanceId} recordId={recordId} onBack={() => navigate(`/instances/${instanceId}/apply`)} />;
	}

	return <BoardTab instanceId={instanceId} columns={columns} apply />;
}
