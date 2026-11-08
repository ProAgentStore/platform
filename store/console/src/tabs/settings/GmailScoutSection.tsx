import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import Card from "../../components/Card";
import { scanSummary } from "../../lib/gmailScout";
import { useGmailScoutStatus } from "../../lib/useGmailScoutStatus";

const GMAIL_SCOUT_MAILBOX = "serge.pro.job@gmail.com";

/** The one line of scan status Settings → Agent keeps (#1591): `<state> · View scans`, warning for a failed scan or leads not reaching Jobs. */
export function ScanSummaryLine({ instanceId, summary }: { instanceId: string; summary: ReturnType<typeof scanSummary> }) {
	return (
		<p className={`mt-3 text-sm ${summary.tone === "warn" ? "text-warning" : "text-muted"}`} data-testid="gmail-scout-summary" role="status">
			{summary.text}
			{summary.link && <> · <Link to={`/instances/${encodeURIComponent(instanceId)}/scans`} className="text-accent underline">View scans</Link></>}
		</p>
	);
}

/** The Gmail source's configuration (#995): the mailbox, whether it is read, and a line pointing at its scans, which live on the Scans tab (#1591). */
export default function GmailScoutSection({ instanceId }: { instanceId: string }) {
	const { status, error, reload } = useGmailScoutStatus(instanceId);
	const [mailbox, setMailbox] = useState(GMAIL_SCOUT_MAILBOX);
	const [enabled, setEnabled] = useState(true);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!status) return;
		setMailbox(status.config?.pinnedEmail ?? GMAIL_SCOUT_MAILBOX);
		setEnabled(status.config?.enabled ?? true);
	}, [status]);

	const save = async () => {
		setBusy(true); setMessage("");
		try {
			await api(`/v1/instances/${instanceId}/gmail-scout/config`, { method: "PUT", body: JSON.stringify({ pinnedEmail: GMAIL_SCOUT_MAILBOX, enabled }) });
			setMessage("Gmail Scout source saved.");
			await reload();
		} catch (e) {
			setMessage(e instanceof Error ? e.message : "Could not save Gmail Scout settings.");
		} finally { setBusy(false); }
	};

	return <Card className="mt-4" aria-labelledby="gmail-scout-heading">
		<div><h2 id="gmail-scout-heading" className="font-semibold">Gmail Job Search Scout</h2><p className="text-xs text-muted-soft mt-1">Read-only job-alert ingestion. It never sends, archives, marks, or modifies mail.</p></div>
		<label className="block text-sm mt-4">Connected Gmail mailbox
			<input className="mt-1 w-full rounded border border-line bg-paper px-2 py-1.5" value={mailbox} readOnly aria-readonly="true" type="email" />
		</label>
		<label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable Gmail job-alert scans</label>
		<div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" onClick={() => void save()} disabled={busy}>Save Gmail source</Button>{message && <span className="text-xs text-muted-soft" role="status">{message}</span>}</div>
		<ScanSummaryLine instanceId={instanceId} summary={scanSummary({ status, failed: !!error })} />
	</Card>;
}
