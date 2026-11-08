import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { type GmailScoutScanResponse, type LeadVerification, type LeadVerificationListResponse, scanNowMessage } from "../lib/gmailScout";
import { useGmailScoutStatus } from "../lib/useGmailScoutStatus";
import ScansView from "./scans/ScansView";

/**
 * A Gmail Job Search Scout's scans (#1591): Scan now, what the last scans found, the per-email log, the browser-verification
 * queue and whether the leads reached Jobs. The source's configuration stays in Settings → Agent. Shown only where the
 * server says the instance is a Scout (`isGmailScout`) — never by its Gmail tools, which the Application Runner shares.
 */
export default function ScansTab({ instanceId, hasData }: { instanceId: string; hasData: boolean }) {
	const { status, error, reload } = useGmailScoutStatus(instanceId);
	// #1030: the leads the server could not check, verified in this Scout's browser.
	const [verifications, setVerifications] = useState<LeadVerification[]>([]);
	const [openScan, setOpenScan] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);

	const loadVerifications = useCallback(async () => {
		const v = await api<LeadVerificationListResponse>(`/v1/instances/${instanceId}/job-leads/browser-verifications?limit=20`).catch((): LeadVerificationListResponse => ({ leads: [] }));
		setVerifications(v.leads);
	}, [instanceId]);
	useEffect(() => { void loadVerifications(); }, [loadVerifications]);
	const refresh = useCallback(() => Promise.all([reload(), loadVerifications()]).then(() => undefined), [reload, loadVerifications]);

	const scan = async () => {
		setBusy(true); setMessage("");
		try {
			const result = await api<GmailScoutScanResponse>(`/v1/instances/${instanceId}/gmail-scout/scan`, { method: "POST" });
			setMessage(scanNowMessage(result.scan));
			await refresh();
		} catch (e) {
			setMessage(e instanceof Error ? e.message : "Gmail scan failed.");
		} finally { setBusy(false); }
	};

	const verify = async (leadId: string) => {
		try {
			await api(`/v1/instances/${instanceId}/job-leads/${encodeURIComponent(leadId)}/browser-verification`, { method: "POST" });
		} catch (e) {
			setMessage(e instanceof Error ? e.message : String(e));
		}
		await refresh();
	};

	return <ScansView instanceId={instanceId} status={status} error={error} verifications={verifications} busy={busy} message={message} openScan={openScan} hasData={hasData} onRetry={() => void refresh()} onScan={() => void scan()} onVerify={(id) => void verify(id)} onToggleScan={setOpenScan} />;
}
