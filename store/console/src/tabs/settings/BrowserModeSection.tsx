import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import BrowserSettingsFields, { BrowserSettingsHelp } from "../../components/BrowserSettingsFields";
import BrowserSessionReceipt from "../../components/BrowserSessionReceipt";
import type { BrowserSettings, BrowserSettingsView } from "../../lib/browserSettings";

export function BrowserModeSettings({ data, saving, message, onChange }: { data: BrowserSettingsView; saving: boolean; message: string; onChange: (patch: Partial<BrowserSettings>) => void }) {
	return (
		<Card className="mb-3 sm:mb-4" data-testid="browser-mode-settings">
			<h3 className="text-base font-bold mb-1">Browser settings</h3>
			<p className="text-sm text-muted mb-3">Choose this instance's browser, window mode and profile. Changes apply on the next browser launch; current tasks continue unchanged.</p>
			<BrowserSettingsFields value={data} inherited={data.agentDefaults} effective={data.effective} sources={data.sources} disabled={saving} onChange={onChange} />
			<BrowserSettingsHelp />
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
		<BrowserModeSettings data={data} saving={saving} message={message} onChange={(patch) => void save(patch)} />
		<BrowserSessionReceipt instanceId={instanceId} />
	</>;
}
