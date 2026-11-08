import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { GmailScoutStatus } from "./gmailScout";

/**
 * `GET /v1/instances/:id/gmail-scout/status` — read by the Scans tab and by the one line Settings → Agent
 * shows of it (#1591). `status` stays the last good answer when a refresh fails; `error` is the failure.
 */
export function useGmailScoutStatus(instanceId: string): { status: GmailScoutStatus | null; error: string | null; reload: () => Promise<void> } {
	const [status, setStatus] = useState<GmailScoutStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reload = useCallback(async () => {
		try {
			setStatus(await api<GmailScoutStatus>(`/v1/instances/${instanceId}/gmail-scout/status`));
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not load Gmail Scout status.");
		}
	}, [instanceId]);
	useEffect(() => { void reload(); }, [reload]);
	return { status, error, reload };
}
