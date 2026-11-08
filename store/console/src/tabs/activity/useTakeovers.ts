import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { BrowserTakeover, BrowserTakeoverListResponse } from "../../lib/browserTakeovers";

/**
 * The one takeovers fetch on Activity (#1604): the takeovers panel lists them, and the verifications panel joins them to
 * its leads (a lead waits on a host's site-consent takeover), so History owns the request and both read it.
 * `enabled` is false for an agent with no local browser: nothing is requested.
 */
export function useTakeovers(instanceId: string, enabled: boolean) {
	const [takeovers, setTakeovers] = useState<BrowserTakeover[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [failed, setFailed] = useState("");

	const load = useCallback(async () => {
		try {
			const t = await api<BrowserTakeoverListResponse>(`/v1/instances/${instanceId}/browser-takeovers?limit=10`);
			setTakeovers(t.takeovers);
			setLoaded(true);
			setFailed("");
		} catch (e) {
			setFailed(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => {
		if (enabled) void load();
	}, [enabled, load]);

	/** Run a write, then re-read. Resolves to the failure's message, or "". */
	const act = useCallback(
		async (run: () => Promise<unknown>) => {
			try {
				await run();
				await load();
				return "";
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			}
		},
		[load],
	);
	const decline = (id: string) => act(() => api(`/v1/instances/${instanceId}/browser-takeovers/${id}`, { method: "PATCH", body: JSON.stringify({ state: "ended" }) }));
	// The call the research run's own "allow this site" pause action makes. The next verification pass sees the host allowed and closes the takeover as resumed.
	const allow = (host: string) => act(() => api(`/v1/instances/${instanceId}/local-browser/consent`, { method: "PUT", body: JSON.stringify({ scope: "navigate", domain: host, decision: "allow" }) }));

	return { takeovers, loaded, failed, load, allow, decline };
}

export type TakeoversState = ReturnType<typeof useTakeovers>;
