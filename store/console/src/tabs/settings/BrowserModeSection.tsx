import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import BrowserModeSelect, { browserModeLabel, type BrowserMode } from "../../components/BrowserModeSelect";

export interface BrowserModeView {
	mode: BrowserMode | null;
	agentDefault: BrowserMode | null;
	effective: BrowserMode | null;
	source: "instance" | "agent" | "runner";
	explained: string;
}

export function BrowserModeSettings({ data, saving, message, onChange }: { data: BrowserModeView; saving: boolean; message: string; onChange: (mode: BrowserMode | null) => void }) {
	return (
		<Card className="mb-3 sm:mb-4" data-testid="browser-mode-settings">
			<h3 className="text-base font-bold mb-1">Browser mode</h3>
			<p className="text-sm text-muted mb-3">Choose whether this instance opens a visible window on its runner machine. Changes apply on the next browser launch; current tasks continue unchanged.</p>
			<BrowserModeSelect value={data.mode} inheritLabel={`Use agent default (${browserModeLabel(data.agentDefault)})`} disabled={saving} onChange={onChange} />
			<p className="text-xs mt-2">Effective setting: {browserModeLabel(data.effective)}{data.source === "agent" ? " (from agent)" : data.source === "instance" ? " (instance override)" : " (no agent or instance override)"}.</p>
			<p className="text-xs text-muted mt-2">{data.explained}</p>
			{message && <p role="status" className="text-xs mt-2">{message}</p>}
		</Card>
	);
}

export default function BrowserModeSection({ instanceId }: { instanceId: string }) {
	const [data, setData] = useState<BrowserModeView | null>(null);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [saving, setSaving] = useState(false);
	const load = useCallback(async () => {
		try {
			setData(await api<BrowserModeView>(`/v1/instances/${instanceId}/browser-mode`));
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => { void load(); }, [load]);
	if (error && !data) return <LoadFailed what="browser mode settings" detail={error} onRetry={load} />;
	if (!data) return null;
	const save = async (mode: BrowserMode | null) => {
		setSaving(true);
		setMessage("");
		try {
			setData(await api<BrowserModeView>(`/v1/instances/${instanceId}/browser-mode`, { method: "PUT", body: JSON.stringify({ mode }) }));
			setMessage("Saved — applies on the next browser launch. Current tasks continue unchanged.");
		} catch (e) {
			setMessage(e instanceof Error ? e.message : String(e));
		}
		setSaving(false);
	};
	return <BrowserModeSettings data={data} saving={saving} message={message} onChange={(mode) => void save(mode)} />;
}
