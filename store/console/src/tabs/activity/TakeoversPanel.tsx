import { useState } from "react";
import Button from "../../components/Button";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import { isLive, takeoverRow } from "../../lib/browserTakeovers";
import { needingFirst } from "../../lib/activityView";
import { type PanelProps, useReport } from "./useReport";
import type { TakeoversState } from "./useTakeovers";

/**
 * Activity → History → recent browser takeovers (#1031; moved from Settings → Browser in #1590). A live one
 * is something waiting for the owner, so it is listed first. A live site-consent request offers Allow as well
 * as Decline: Settings has no control that allows a host nobody has decided yet.
 */
export default function TakeoversPanel({ onReport, highlightId, state }: PanelProps & { highlightId: string | null; state: TakeoversState }) {
	const { takeovers, loaded, failed, load, allow: allowHost, decline: declineTakeover } = state;
	const [msg, setMsg] = useState("");
	const decline = async (id: string) => setMsg(await declineTakeover(id));
	const allow = async (host: string) => setMsg(await allowHost(host));

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
