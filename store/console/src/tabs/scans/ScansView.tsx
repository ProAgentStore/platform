import { Link } from "react-router-dom";
import Button from "../../components/Button";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import GmailScoutScanLog from "../settings/GmailScoutScanLog";
import { type GmailScoutStatus, type LeadVerification, hasScans, jobsPushLine, leadVerificationLine, leadsNotReachingJobs, rejectionSummary, scanTime } from "../../lib/gmailScout";

export interface ScansViewProps {
	instanceId: string;
	/** null until the first answer. */
	status: GmailScoutStatus | null;
	/** The status request's failure; the last good `status` is kept beneath it. */
	error: string | null;
	verifications: LeadVerification[];
	busy: boolean;
	message: string;
	/** The receipt expanded to its per-email log (#1247). */
	openScan: string | null;
	/** Is the Data tab shown, so an active lead can be triaged there (#1602)? */
	hasData: boolean;
	onRetry: () => void;
	onScan: () => void;
	onVerify: (leadId: string) => void;
	onToggleScan: (scanId: string | null) => void;
}

const triggerWords = { on_demand: "Scan now", reprocess: "Reprocess", schedule: "Scheduled" } as const;

/** What the Scans tab shows of a Gmail Scout (#1591) — pure over its props, so every state is rendered in a unit test. */
export default function ScansView(props: ScansViewProps) {
	const { instanceId, status, error, verifications, busy, message, openScan, hasData } = props;
	const base = `/instances/${encodeURIComponent(instanceId)}`;
	if (!status) {
		return error
			? <LoadFailed what="the Gmail scans" detail={error} onRetry={props.onRetry} testId="scans-load-failed" />
			: <p className="text-sm text-muted-soft" role="status" data-testid="scans-loading">Loading scans…</p>;
	}
	const { state } = status;
	const enabled = status.config?.enabled !== false;
	const scanned = hasScans(status);
	const scanNow = <Button size="sm" onClick={props.onScan} disabled={busy}>{busy ? "Working…" : "Scan now"}</Button>;
	return <Card aria-labelledby="scans-heading">
		<div className="flex flex-wrap items-center justify-between gap-2">
			<div><h2 id="scans-heading" className="font-semibold">Gmail scans</h2><p className="text-xs text-muted-soft mt-1">Read-only job-alert ingestion. It never sends, archives, marks, or modifies mail.</p></div>
			{enabled && scanned && scanNow}
		</div>
		{error && <LoadFailed compact what="the latest scan status" detail={error} onRetry={props.onRetry} testId="scans-refresh-failed" />}
		{message && <p className="mt-2 text-xs text-muted-soft" role="status">{message}</p>}
		{!enabled && <p className="mt-3 text-sm text-warning" data-testid="scans-source-off">Gmail source is off · <Link to={`${base}/settings?subtab=agent`} className="text-accent underline">Turn on in Settings</Link></p>}
		{leadsNotReachingJobs(status.receipts) && <p className="mt-3 text-sm text-warning" data-testid="scans-jobs-warning">Leads are not reaching Jobs · <Link to={`${base}/permissions`} className="text-accent underline">Fix in Permissions</Link></p>}
		{!scanned && enabled && <p className="mt-3 text-sm text-muted" data-testid="scans-empty">No scans yet · {scanNow}</p>}
		{scanned && <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
			<div><span className="block text-xs text-muted-soft">Last scan</span>{state.lastScanAt ? scanTime(state.lastScanAt) : "Never"}</div>
			<div><span className="block text-xs text-muted-soft">Candidates</span>{state.candidateCount}</div>
			<div><span className="block text-xs text-muted-soft">Duplicates</span>{state.dedupeCount}</div>
			<div><span className="block text-xs text-muted-soft">New leads</span>{status.newLeadCount} / {status.leadCount}</div>
		</div>}
		{status.receipts?.length ? (
			<div className="mt-4" data-testid="gmail-scout-receipts">
				<h3 className="text-xs text-muted-soft mb-1">Recent scans</h3>
				<ul className="flex flex-col gap-1 text-xs">
					{status.receipts.slice(0, 5).map((r) => {
						const jobs = r.status === "completed" ? jobsPushLine(r) : "";
						return (
							<li key={r.id}>
								{scanTime(r.startedAt)} · {triggerWords[r.trigger] ?? "Scheduled"} ·{" "}
								<span className={r.status === "failed" ? "text-danger" : "text-muted"}>{r.status}</span>
								{r.status === "completed" ? ` · ${r.added ?? 0} added${r.awaitingBrowserVerification ? ` (${r.awaitingBrowserVerification} awaiting browser verification)` : ""}, ${r.deduped ?? 0} duplicate(s)${rejectionSummary(r.rejected) ? `, skipped: ${rejectionSummary(r.rejected)}` : ""}` : ""}
								{jobs ? ` · ${jobs}` : ""}
								{r.status === "failed" && r.errorMessage ? ` · ${r.errorMessage}` : ""}
								{r.scanLog && (r.hits ?? 0) > 0 && (
									<button type="button" className="ml-2 text-accent underline" aria-expanded={openScan === r.id} onClick={() => props.onToggleScan(openScan === r.id ? null : r.id)}>
										{openScan === r.id ? "Hide emails" : `Show ${r.hits} email(s)`}
									</button>
								)}
								{openScan === r.id && <GmailScoutScanLog instanceId={instanceId} scanId={r.id} />}
							</li>
						);
					})}
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
								{line.canVerifyNow && <Button size="sm" variant="ghost" disabled={busy} onClick={() => props.onVerify(v.leadId)}>{v.state === "unverifiable" ? "Verify again" : "Verify now"}</Button>}
								{v.state === "active" && hasData && <Link to={`${base}/data?lead=${encodeURIComponent(v.leadId)}`} className="text-accent underline">Triage in Data</Link>}
							</li>
						);
					})}
				</ul>
			</div>
		) : null}
		{state.failureCount ? <p className="mt-3 text-sm text-danger">{state.failureCount} scan failure(s){state.lastFailureAt ? `; latest ${scanTime(state.lastFailureAt)}` : ""}: {state.lastFailureMessage || "Unknown failure"}</p> : null}
	</Card>;
}
