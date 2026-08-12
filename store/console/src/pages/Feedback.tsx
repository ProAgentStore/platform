import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Page from "../components/Page";
import FeedbackList from "../components/FeedbackList";

/**
 * Everything flagged, across every agent (#514) — the triage view.
 *
 * The per-instance tab answers "what did I say about THIS agent"; this answers "what is still
 * open", which is the question actually being asked at the moment someone sits down to file
 * tickets. Same route, same component: `GET /v1/feedback` without `instance_id`.
 *
 * The instance names are fetched here rather than joined server-side, so the read route stays the
 * one shape `errors.ts` established. A name that cannot be resolved degrades to the id's first
 * eight characters instead of blocking the list.
 */
export default function Feedback() {
	const [names, setNames] = useState<Record<string, string>>({});

	useEffect(() => {
		void (async () => {
			try {
				const d = await api<{ instances?: Array<{ id: string; name?: string; agent_name?: string }> }>("/v1/instances/my/instances");
				setNames(Object.fromEntries((d.instances || []).map((i) => [i.id, i.name || i.agent_name || i.id])));
			} catch {
				// IGNORABLE (#291): these are LABELS on rows that render fine without them, and the
				// list itself reports its own read failure. An error banner here would claim the
				// feedback failed to load when it did not.
			}
		})();
	}, []);

	return (
		<Page>
			<FeedbackList agentNames={names} />
		</Page>
	);
}
