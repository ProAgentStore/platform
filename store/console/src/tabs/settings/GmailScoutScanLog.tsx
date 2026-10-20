import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import LoadFailed from "../../components/LoadFailed";
import { type GmailScoutScanLogItem, type GmailScoutScanLogPage, scanLogVerdict } from "../../lib/gmailScout";

const toneClass = { ok: "text-success", warn: "text-warning", muted: "text-muted" } as const;

/**
 * One scan's per-email decisions (#1247): every email it matched, with a link that opens it, what it
 * was taken for and why, the lead it became — and a digest's jobs one by one. Same rows as MCP's
 * gmail_scout_scan_log.
 */
export default function GmailScoutScanLog({ instanceId, scanId }: { instanceId: string; scanId: string }) {
	const [items, setItems] = useState<GmailScoutScanLogItem[]>([]);
	const [page, setPage] = useState<GmailScoutScanLogPage | null>(null);
	const [err, setErr] = useState("");

	const load = useCallback(async (cursor?: string) => {
		setErr("");
		try {
			const q = new URLSearchParams({ scan_id: scanId, ...(cursor ? { cursor } : {}) });
			const next = await api<GmailScoutScanLogPage>(`/v1/instances/${instanceId}/gmail-scout/scan-log?${q}`);
			setPage(next);
			setItems((prev) => (cursor ? [...prev, ...next.items] : next.items));
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId, scanId]);
	useEffect(() => { void load(); }, [load]);

	if (err) return <LoadFailed what="this scan's log" detail={err} onRetry={() => void load()} testId="gmail-scout-scan-log-failed" />;
	if (!page) return <p className="text-xs text-muted-soft mt-1">Loading…</p>;
	return (
		<div className="mt-1 ml-2 border-l border-line pl-2" data-testid="gmail-scout-scan-log">
			{page.scan?.query && <p className="text-2xs text-muted-soft break-words">Searched: <code>{page.scan.query}</code></p>}
			{!items.length && <p className="text-xs text-muted-soft">This scan matched no email{page.scan?.query ? "" : " (or it was logged before #1247)"}.</p>}
			<ul className="flex flex-col gap-2 mt-1">
				{items.map((item) => <LogRow key={item.seq} item={item} />)}
			</ul>
			{page.nextCursor && <Button size="sm" variant="ghost" onClick={() => void load(page.nextCursor ?? undefined)}>More ({page.total - items.length} left)</Button>}
		</div>
	);
}

function LogRow({ item }: { item: GmailScoutScanLogItem }) {
	const verdict = scanLogVerdict(item);
	return (
		<li className="text-xs min-w-0">
			<div className="flex flex-wrap gap-x-2 items-baseline">
				<span className={`font-semibold ${toneClass[verdict.tone]}`}>{verdict.text}</span>
				<span className="text-ink break-words">{item.subject ?? "(no subject)"}</span>
				{item.gmailLink && <a href={item.gmailLink} target="_blank" rel="noreferrer" className="text-accent underline">Open email</a>}
			</div>
			<div className="text-muted-soft break-words">{[item.sender, item.receivedAt].filter(Boolean).join(" · ")}</div>
			<div className="text-muted break-words">{item.reason}</div>
			{item.evidence && <div className="text-muted-soft break-words">Evidence: {item.evidence}</div>}
			{item.leadId && <div>Lead <code>{item.leadId}</code>{item.leadUrl && <> · <a href={item.leadUrl} className="text-accent underline">open in Data</a></>}</div>}
			{item.subItems?.length ? (
				<ul className="mt-1 ml-3 flex flex-col gap-1" aria-label="Jobs listed in this email">
					{item.subItems.map((sub) => {
						const v = scanLogVerdict(sub);
						return (
							<li key={`${sub.seq}-${sub.job?.url}`} className="break-words">
								<span className={toneClass[v.tone]}>{v.text.split(" · ")[0]}</span> · {sub.job?.title ?? "Untitled job"}
								{sub.job?.url && <> · <a href={sub.job.url} target="_blank" rel="noreferrer" className="text-accent underline">posting</a></>}
								{sub.leadId && <> · lead <code>{sub.leadId}</code></>}
							</li>
						);
					})}
				</ul>
			) : null}
		</li>
	);
}
