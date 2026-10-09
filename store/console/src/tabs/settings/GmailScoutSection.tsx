import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import Card from "../../components/Card";

type Config = { pinnedEmail: string | null; enabled: boolean };
type Status = {
	config: Config | null;
	state: { lastScanAt: string | null; candidateCount: number; dedupeCount: number; failureCount: number; lastFailureAt: string | null; lastFailureMessage: string | null };
	leadCount: number;
	newLeadCount: number;
};

/** The owner-facing control plane for the dedicated, read-only Gmail Scout source (#995). */
export default function GmailScoutSection({ instanceId }: { instanceId: string }) {
	const [status, setStatus] = useState<Status | null>(null);
	const [mailbox, setMailbox] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			const value = await api<Status>(`/v1/instances/${instanceId}/gmail-scout/status`);
			setStatus(value);
			setMailbox(value.config?.pinnedEmail ?? "");
			setEnabled(value.config?.enabled ?? true);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not load Gmail Scout settings.");
		}
	}, [instanceId]);

	useEffect(() => { void load(); }, [load]);

	const save = async () => {
		setBusy(true); setMessage("");
		try {
			await api(`/v1/instances/${instanceId}/gmail-scout/config`, { method: "PUT", body: JSON.stringify({ pinnedEmail: mailbox.trim() || null, enabled }) });
			setMessage("Gmail Scout source saved.");
			await load();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not save Gmail Scout settings.");
		} finally { setBusy(false); }
	};

	const scan = async () => {
		setBusy(true); setMessage("");
		try {
			const result = await api<{ scan: { added: number; deduped: number } }>(`/v1/instances/${instanceId}/gmail-scout/scan`, { method: "POST" });
			setMessage(`Scan complete: ${result.scan.added} lead(s) added, ${result.scan.deduped} duplicate(s) skipped.`);
			await load();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Gmail scan failed.");
		} finally { setBusy(false); }
	};

	const state = status?.state;
	return <Card className="mt-4" aria-labelledby="gmail-scout-heading">
		<div className="flex flex-wrap items-center justify-between gap-2">
			<div><h2 id="gmail-scout-heading" className="font-semibold">Gmail Job Search Scout</h2><p className="text-xs text-muted-soft mt-1">Read-only job-alert ingestion. It never sends, archives, marks, or modifies mail.</p></div>
			<Button size="sm" onClick={() => void scan()} disabled={busy || !enabled || !mailbox.trim()}>{busy ? "Working…" : "Scan now"}</Button>
		</div>
		<label className="block text-sm mt-4">Connected Gmail mailbox
			<input className="mt-1 w-full rounded border border-line bg-base px-2 py-1.5" value={mailbox} onChange={(event) => setMailbox(event.target.value)} placeholder="serge.pro.job@gmail.com" type="email" />
		</label>
		<label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable Gmail job-alert scans</label>
		<div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" onClick={() => void save()} disabled={busy}>Save Gmail source</Button>{message && <span className="text-xs text-muted-soft" role="status">{message}</span>}</div>
		<div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
			<div><span className="block text-xs text-muted-soft">Last scan</span>{state?.lastScanAt ? new Date(state.lastScanAt).toLocaleString() : "Never"}</div>
			<div><span className="block text-xs text-muted-soft">Candidates</span>{state?.candidateCount ?? 0}</div>
			<div><span className="block text-xs text-muted-soft">Duplicates</span>{state?.dedupeCount ?? 0}</div>
			<div><span className="block text-xs text-muted-soft">New leads</span>{status?.newLeadCount ?? 0} / {status?.leadCount ?? 0}</div>
		</div>
		{state?.failureCount ? <p className="mt-3 text-sm text-danger">{state.failureCount} scan failure(s){state.lastFailureAt ? `; latest ${new Date(state.lastFailureAt).toLocaleString()}` : ""}: {state.lastFailureMessage || "Unknown failure"}</p> : null}
	</Card>;
}
