import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import VerificationQueue, { type VerificationAsk } from "../../components/VerificationQueue";
import { orderVerifications, verificationTakeover } from "../../lib/activityView";
import type { LeadVerification, LeadVerificationListResponse } from "../../lib/gmailScout";
import { type PanelProps, useReport } from "./useReport";
import type { TakeoversState } from "./useTakeovers";

/**
 * Activity → History → browser verification (#1604): the queue of a `local_browser` agent that is not a Gmail Scout (whose
 * queue is on its Scans tab). A lead waiting on a site's consent comes first and offers Allow / Decline from the takeover
 * that asks; the takeovers are History's own fetch (`useTakeovers`), never a second request. Renders nothing while empty.
 */
export default function VerificationsPanel({ instanceId, onReport, takeovers: state }: PanelProps & { takeovers: TakeoversState }) {
	const [leads, setLeads] = useState<LeadVerification[] | null>(null);
	const [failed, setFailed] = useState("");
	const [msg, setMsg] = useState("");

	const load = useCallback(async () => {
		try {
			const v = await api<LeadVerificationListResponse>(`/v1/instances/${instanceId}/job-leads/browser-verifications?limit=20`);
			setLeads(v.leads);
			setFailed("");
		} catch (e) {
			setFailed(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => {
		void load();
	}, [load]);

	const ordered = leads ? orderVerifications(leads, state.takeovers) : [];
	const asks: Record<string, VerificationAsk> = {};
	for (const v of ordered) {
		const t = verificationTakeover(v, state.takeovers);
		if (t) asks[v.leadId] = { host: t.subjectId.slice("site-consent:".length), takeoverId: t.id };
	}
	useReport("verifications", onReport, leads ? "ready" : failed ? "failed" : "loading", ordered.length, Object.keys(asks).length > 0);

	const verify = async (leadId: string) => {
		setMsg("");
		try {
			await api(`/v1/instances/${instanceId}/job-leads/${encodeURIComponent(leadId)}/browser-verification`, { method: "POST" });
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		await load();
	};
	const decide = async (run: () => Promise<string>) => {
		setMsg(await run());
		await load();
	};

	if (!leads) return failed ? <LoadFailed what="browser verifications" detail={failed} onRetry={() => void load()} testId="history-failed-verifications" compact /> : null;
	if (!ordered.length) return null;
	return (
		<Card className="mb-3 sm:mb-4" data-testid="history-verifications">
			<h3 className="text-base font-bold mb-1">Browser verification</h3>
			<VerificationQueue
				verifications={ordered}
				busy={false}
				onVerify={(id) => void verify(id)}
				asks={asks}
				onAllow={(host) => void decide(() => state.allow(host))}
				onDecline={(id) => void decide(() => state.decline(id))}
			/>
			{msg && <p role="status" className="text-xs text-warning mt-2">{msg}</p>}
		</Card>
	);
}
