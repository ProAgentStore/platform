import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import Card from "../../components/Card";
import { type GmailScoutScanReceipt, type GmailScoutScanResponse, type LeadVerification, leadVerificationLine, rejectionSummary, scanNowMessage } from "../../lib/gmailScout";

const GMAIL_SCOUT_MAILBOX = "serge.pro.job@gmail.com";

type Config = { pinnedEmail: string | null; enabled: boolean };
type Status = {
	config: Config | null;
	state: { lastScanAt: string | null; candidateCount: number; dedupeCount: number; failureCount: number; lastFailureAt: string | null; lastFailureMessage: string | null };
	leadCount: number;
	newLeadCount: number;
	/** #1023 — absent on an older API. */
	receipts?: GmailScoutScanReceipt[];
};

/** The owner-facing control plane for the dedicated, read-only Gmail Scout source (#995). */
export default function GmailScoutSection({ instanceId }: { instanceId: string }) {
	const [status, setStatus] = useState<Status | null>(null);
	const [mailbox, setMailbox] = useState(GMAIL_SCOUT_MAILBOX);
	const [enabled, setEnabled] = useState(true);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	// #1030: the leads the server could not check, verified in this Scout's browser.
	const [verifications, setVerifications] = useState<LeadVerification[]>([]);

	const load = useCallback(async () => {
		try {
			const value = await api<Status>(`/v1/instances/${instanceId}/gmail-scout/status`);
			setStatus(value);
			const v = await api<{ leads: LeadVerification[] }>(`/v1/instances/${instanceId}/job-leads/browser-verifications?limit=20`).catch(() => ({ leads: [] }));
			setVerifications(v.leads);
			setMailbox(value.config?.pinnedEmail ?? GMAIL_SCOUT_MAILBOX);
			setEnabled(value.config?.enabled ?? true);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not load Gmail Scout settings.");
		}
	}, [instanceId]);

	useEffect(() => { void load(); }, [load]);

	const save = async () => {
		setBusy(true); setMessage("");
		try {
			await api(`/v1/instances/${instanceId}/gmail-scout/config`, { method: "PUT", body: JSON.stringify({ pinnedEmail: GMAIL_SCOUT_MAILBOX, enabled }) });
			setMessage("Gmail Scout source saved.");
			await load();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not save Gmail Scout settings.");
		} finally { setBusy(false); }
	};

	const scan = async () => {
		setBusy(true); setMessage("");
		try {
			const result = await api<GmailScoutScanResponse>(`/v1/instances/${instanceId}/gmail-scout/scan`, { method: "POST" });
			setMessage(scanNowMessage(result.scan));
			await load();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Gmail scan failed.");
		} finally { setBusy(false); }
	};

	const state = status?.state;
	return <Card className="mt-4" aria-labelledby="gmail-scout-heading">
		<div className="flex flex-wrap items-center justify-between gap-2">
			<div><h2 id="gmail-scout-heading" className="font-semibold">Gmail Job Search Scout</h2><p className="text-xs text-muted-soft mt-1">Read-only job-alert ingestion. It never sends, archives, marks, or modifies mail.</p></div>
			<Button size="sm" onClick={() => void scan()} disabled={busy || !enabled}>{busy ? "Working…" : "Scan now"}</Button>
		</div>
		<label className="block text-sm mt-4">Connected Gmail mailbox
			<input className="mt-1 w-full rounded border border-line bg-paper px-2 py-1.5" value={mailbox} readOnly aria-readonly="true" type="email" />
		</label>
		<label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable Gmail job-alert scans</label>
		<div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" onClick={() => void save()} disabled={busy}>Save Gmail source</Button>{message && <span className="text-xs text-muted-soft" role="status">{message}</span>}</div>
		<div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
			<div><span className="block text-xs text-muted-soft">Last scan</span>{state?.lastScanAt ? new Date(state.lastScanAt).toLocaleString() : "Never"}</div>
			<div><span className="block text-xs text-muted-soft">Candidates</span>{state?.candidateCount ?? 0}</div>
			<div><span className="block text-xs text-muted-soft">Duplicates</span>{state?.dedupeCount ?? 0}</div>
			<div><span className="block text-xs text-muted-soft">New leads</span>{status?.newLeadCount ?? 0} / {status?.leadCount ?? 0}</div>
		</div>
		{status?.receipts?.length ? (
			<div className="mt-4" data-testid="gmail-scout-receipts">
				<h3 className="text-xs text-muted-soft mb-1">Recent scans</h3>
				<ul className="flex flex-col gap-1 text-xs">
					{status.receipts.slice(0, 5).map((r) => (
						<li key={r.id}>
							{new Date(r.startedAt).toLocaleString()} · {r.trigger === "on_demand" ? "Scan now" : "Scheduled"} ·{" "}
							<span className={r.status === "failed" ? "text-danger" : "text-muted"}>{r.status}</span>
							{r.status === "completed" ? ` · ${r.added ?? 0} added${r.awaitingBrowserVerification ? ` (${r.awaitingBrowserVerification} awaiting browser verification)` : ""}, ${r.deduped ?? 0} duplicate(s)${rejectionSummary(r.rejected) ? `, skipped: ${rejectionSummary(r.rejected)}` : ""}` : ""}
							{r.status === "failed" && r.errorMessage ? ` · ${r.errorMessage}` : ""}
						</li>
					))}
				</ul>
			</div>
		) : null}
		{verifications.length ? (
			<div className="mt-4" data-testid="gmail-scout-verifications">
				<h3 className="text-xs text-muted-soft mb-1">Browser verification</h3>
				<p className="text-xs text-muted mb-1">Leads the server could not check are checked in this Scout's browser — only the posting itself, never your alert link. Only a job found active can be applied for.</p>
				<ul className="flex flex-col gap-1 text-xs">
					{verifications.map((v) => {
						const line = leadVerificationLine(v);
						return (
							<li key={v.leadId} className="flex flex-wrap gap-2 items-center">
								<span className={line.tone === "ok" ? "text-success" : line.tone === "warn" ? "text-warning" : "text-muted"}>{line.text}</span>
								{v.lastDetail && <span className="text-muted-soft">{v.lastDetail}</span>}
								{line.canVerifyNow && (
									<Button size="sm" variant="ghost" disabled={busy} onClick={async () => {
										try {
											await api(`/v1/instances/${instanceId}/job-leads/${encodeURIComponent(v.leadId)}/browser-verification`, { method: "POST" });
										} catch (e) {
											setMessage(e instanceof Error ? e.message : String(e));
										}
										await load();
									}}>Verify now</Button>
								)}
							</li>
						);
					})}
				</ul>
			</div>
		) : null}
		{state?.failureCount ? <p className="mt-3 text-sm text-danger">{state.failureCount} scan failure(s){state.lastFailureAt ? `; latest ${new Date(state.lastFailureAt).toLocaleString()}` : ""}: {state.lastFailureMessage || "Unknown failure"}</p> : null}
	</Card>;
}
