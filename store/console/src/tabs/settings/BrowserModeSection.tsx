import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import BrowserSettingsFields, { BrowserSettingsHelp } from "../../components/BrowserSettingsFields";
import WebsiteGrants from "../../components/WebsiteGrants";
import { useBrowserSession } from "../../components/BrowserSessionReceipt";
import HistoryLine from "../../components/HistoryLine";
import { launchDiffersFromSettings } from "../../lib/browserLaunchCompare";
import { type HistoryLineState, launchLine } from "../../lib/historyLine";
import type { BrowserSettings, BrowserSettingsView } from "../../lib/browserSettings";

export function BrowserModeSettings({ data, saving, message, onChange, instanceId }: { instanceId?: string; data: BrowserSettingsView; saving: boolean; message: string; onChange: (patch: Partial<BrowserSettings>) => void }) {
	return (
		<Card className="mb-3 sm:mb-4" data-testid="browser-mode-settings">
			<h3 className="text-base font-bold mb-1">Browser settings</h3>
			<p className="text-sm text-muted mb-3">Choose this instance's browser, window mode, profile and website access. Changes apply on the next browser launch; current tasks continue unchanged.</p>
			<BrowserSettingsFields value={data} inherited={data.agentDefaults} effective={data.effective} sources={data.sources} disabled={saving} onChange={onChange} />
			<BrowserSettingsHelp />
			{instanceId && <WebsiteGrants key={instanceId} instanceId={instanceId} />}
			<p className="text-xs text-muted mt-2">{data.explained}</p>
			{data.requiredCli && <p className="text-xs text-muted mt-2">These saved settings require PAGS runner {data.requiredCli} or later.</p>}
			{message && <p role="status" className="text-xs mt-2">{message}</p>}
		</Card>
	);
}

export default function BrowserModeSection({ instanceId }: { instanceId: string }) {
	const [data, setData] = useState<BrowserSettingsView | null>(null);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [saving, setSaving] = useState(false);
	// What the runner last launched is history (Activity → History, #1590); here it only says when the saved setting differs.
	const session = useBrowserSession(instanceId);
	const load = useCallback(async () => {
		try {
			setData(await api<BrowserSettingsView>(`/v1/instances/${instanceId}/browser-settings`));
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => { void load(); }, [load]);
	if (error && !data) return <LoadFailed what="browser settings" detail={error} onRetry={load} />;
	if (!data) return null;
	const launch: HistoryLineState = session.loading && !session.data ? { status: "loading" } : session.error && !session.data ? { status: "failed" } : launchLine(session.data?.status === "connected" && launchDiffersFromSettings(data.effective, session.data.launch));
	const save = async (patch: Partial<BrowserSettings>) => {
		setSaving(true);
		setMessage("");
		try {
			setData(await api<BrowserSettingsView>(`/v1/instances/${instanceId}/browser-settings`, { method: "PUT", body: JSON.stringify(patch) }));
			setMessage("Saved — applies on the next browser launch. Current tasks continue unchanged.");
		} catch (e) {
			setMessage(e instanceof Error ? e.message : String(e));
		}
		setSaving(false);
	};
	return <>
		<BrowserModeSettings instanceId={instanceId} data={data} saving={saving} message={message} onChange={(patch) => void save(patch)} />
		<div className="mb-3 sm:mb-4"><HistoryLine instanceId={instanceId} panel="browser-launch" state={launch} testId="browser-launch-line" /></div>
	</>;
}
