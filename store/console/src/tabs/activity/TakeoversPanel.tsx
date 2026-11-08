import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import { type BrowserTakeover, type BrowserTakeoverListResponse, isLive, takeoverRow } from "../../lib/browserTakeovers";
import { needingFirst } from "../../lib/activityView";
import { type PanelProps, useReport } from "./useReport";

/**
 * Activity → History → recent browser takeovers (#1031; moved from Settings → Browser in #1590). A live one
 * is something waiting for the owner, so it is listed first. A live site-consent request offers Allow as well
 * as Decline: Settings has no control that allows a host nobody has decided yet.
 */
export default function TakeoversPanel({ instanceId, onReport, highlightId }: PanelProps & { highlightId: string | null }) {
	const [takeovers, setTakeovers] = useState<BrowserTakeover[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [failed, setFailed] = useState("");
	const [msg, setMsg] = useState("");

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
		void load();
	}, [load]);

	const act = async (run: () => Promise<unknown>) => {
		setMsg("");
		try {
			await run();
			await load();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};
	const decline = (id: string) => act(() => api(`/v1/instances/${instanceId}/browser-takeovers/${id}`, { method: "PATCH", body: JSON.stringify({ state: "ended" }) }));
	// The call the research run's own "allow this site" pause action makes. The next verification pass sees the host allowed and closes the takeover as resumed.
	const allow = (host: string) => act(() => api(`/v1/instances/${instanceId}/local-browser/consent`, { method: "PUT", body: JSON.stringify({ scope: "navigate", domain: host, decision: "allow" }) }));

	const gone = loaded && highlightId !== null && !takeovers.some((t) => t.id === highlightId);
	useReport("takeovers", onReport, loaded ? "ready" : failed ? "failed" : "loading", takeovers.length + (gone ? 1 : 0), takeovers.some(isLive));

	if (!loaded) return failed ? <LoadFailed what="browser takeovers" detail={failed} onRetry={() => void load()} testId="history-failed-takeovers" compact /> : null;
	if (!takeovers.length && !gone) return null;
	return (
		<Card className="mb-3 sm:mb-4" data-testid="bv-takeovers">
			{gone && <p role="status" className="text-sm text-muted mb-2" data-testid="takeover-not-listed">This takeover is no longer listed</p>}
			{takeovers.length > 0 && (
				<>
					<h3 className="text-base font-bold mb-2">Recent takeovers</h3>
					<ul className="text-xs flex flex-col gap-1">
						{needingFirst(takeovers, isLive).map((t) => {
							const row = takeoverRow(t);
							return (
								<li key={t.id} data-testid="takeover-row" data-highlighted={t.id === highlightId ? "true" : undefined} className={`flex flex-wrap gap-2 items-center ${t.id === highlightId ? "rounded-lg border border-accent px-2 py-1" : ""}`}>
									<span className={row.tone === "warn" ? "text-warning" : "text-muted"}>{row.text}</span>
									<span className="text-muted-soft">{t.subjectKind.replace(/_/g, " ")} · {t.createdAt.slice(0, 16).replace("T", " ")}</span>
									{row.consentHost && <Button size="sm" variant="primary" onClick={() => void allow(row.consentHost as string)}>Allow</Button>}
									{isLive(t) && <Button size="sm" variant="ghost" onClick={() => void decline(t.id)}>Decline</Button>}
								</li>
							);
						})}
					</ul>
				</>
			)}
			{msg && <p role="status" className="text-xs text-warning mt-2">{msg}</p>}
		</Card>
	);
}
